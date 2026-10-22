"""Knowledge base: folders and files indexed into chunks for retrieval.

Retrieval is hybrid: SQLite FTS5 (trigram, so substrings and Korean work without a model) plus, when an
embeddings provider is configured, cosine similarity over vectors fetched from any OpenAI-compatible
``/embeddings`` endpoint (DashScope ``text-embedding-v4``, OpenAI ``text-embedding-3-small``, a local vLLM).
The two rankings are merged with reciprocal rank fusion. numpy is used when installed, pure Python otherwise.
"""

from __future__ import annotations

import asyncio
import logging
import math
import re
import time
from array import array
from pathlib import Path
from typing import Any, Callable, Optional

import httpx

from .config import KnowledgeConfig, ProviderConfig
from .store import Store

log = logging.getLogger("missile.knowledge")

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache", ".history", "dist", "build"}
MAX_FILE_BYTES = 2 * 1024 * 1024

try:  # optional speed-up for the vector scan
    import numpy as _np  # type: ignore
except Exception:  # pragma: no cover
    _np = None


def chunk_text(text: str, size: int = 900, overlap_paragraphs: int = 1) -> list[str]:
    """Paragraph-aware chunks of about ``size`` characters, each starting with the tail of the previous one."""
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks: list[str] = []
    cur: list[str] = []
    cur_len = 0
    for p in paras:
        if len(p) > size * 2:  # a huge paragraph: hard-split it
            for i in range(0, len(p), size):
                chunks.append(p[i : i + size])
            cur, cur_len = [], 0
            continue
        if cur and cur_len + len(p) > size:
            chunks.append("\n\n".join(cur))
            cur = cur[-overlap_paragraphs:] if overlap_paragraphs else []
            cur_len = sum(len(c) for c in cur)
        cur.append(p)
        cur_len += len(p)
    if cur:
        chunks.append("\n\n".join(cur))
    return [c for c in chunks if c.strip()]


def read_text(path: Path) -> str:
    if path.suffix.lower() == ".pdf":
        try:
            from pypdf import PdfReader  # type: ignore
        except Exception:
            return ""
        try:
            return "\n\n".join((p.extract_text() or "") for p in PdfReader(str(path)).pages)
        except Exception:
            return ""
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return ""


class Knowledge:
    def __init__(self, store: Store, get_cfg: Callable[[], KnowledgeConfig], get_provider: Callable[[str], Optional[ProviderConfig]]):
        self.store = store
        self.get_cfg = get_cfg
        self.get_provider = get_provider
        self.indexing = False
        self.last: dict[str, Any] = {}
        self._run: Optional[asyncio.Task] = None  # the in-progress reindex, so a second caller can wait for it

    # ------------------------------------------------------------ status
    def status(self) -> dict:
        cfg = self.get_cfg()
        st = self.store.kb_stats()
        st.update({"sources": self.store.kb_list_sources(), "indexing": self.indexing, "last": self.last, "embeddings": bool(cfg.embeddings_provider and cfg.embeddings_model), "embeddings_model": cfg.embeddings_model, "embeddings_provider": cfg.embeddings_provider})
        return st

    # ------------------------------------------------------------ indexing
    def _files(self, root: Path, exts: set[str]) -> list[Path]:
        if root.is_file():
            return [root]
        out: list[Path] = []
        for p in root.rglob("*"):
            if any(part in SKIP_DIRS or part.startswith(".") for part in p.relative_to(root).parts[:-1]):
                continue
            if p.is_file() and p.suffix.lower() in exts and p.name not in SKIP_DIRS:
                try:
                    if p.stat().st_size <= MAX_FILE_BYTES:
                        out.append(p)
                except OSError:
                    continue
        return out

    def _index_source_sync(self, src: dict, cfg: KnowledgeConfig) -> dict:
        root = Path(src["path"]).expanduser()
        if not root.exists():
            self.store.kb_update_source(src["id"], error=f"not found: {root}", indexed_at=time.time())
            return {"files": 0, "chunks": 0, "changed": 0, "error": "not found"}
        exts = {e.lower() for e in cfg.extensions}
        known = self.store.kb_file_mtimes(src["id"])
        seen: set[str] = set()
        changed = 0
        total_chunks = 0
        files = self._files(root, exts)
        for p in files:
            key = str(p)
            seen.add(key)
            try:
                mtime = p.stat().st_mtime
            except OSError:
                continue
            if abs(known.get(key, -1) - mtime) < 1e-6:
                continue
            text = read_text(p)
            chunks = chunk_text(text, cfg.chunk_chars) if text.strip() else []
            self.store.kb_replace_file(src["id"], key, chunks, mtime)
            changed += 1
        for gone in set(known) - seen:
            self.store.kb_drop_file(src["id"], gone)
        total_chunks = self.store._conn().execute("SELECT COUNT(*) FROM kb_chunks WHERE source_id=?", (src["id"],)).fetchone()[0]
        self.store.kb_update_source(src["id"], indexed_at=time.time(), files=len(files), chunks=total_chunks, error="")
        return {"files": len(files), "chunks": total_chunks, "changed": changed}

    async def reindex(self, source_id: Optional[str] = None) -> dict:
        """Walk the configured sources (or one), (re)chunk changed files, drop deleted ones, then embed what is new.
        A call made while a run is in progress waits for that run and then does its own (cheap: unchanged files are skipped)."""
        while self.indexing and self._run is not None:
            try:
                await asyncio.shield(self._run)
            except Exception:
                pass
        self._run = asyncio.current_task()
        self.indexing = True
        t0 = time.time()
        summary: dict[str, Any] = {"sources": [], "embedded": 0, "embed_error": ""}
        try:
            cfg = self.get_cfg()
            for src in self.store.kb_list_sources():
                if source_id and src["id"] != source_id:
                    continue
                res = await asyncio.to_thread(self._index_source_sync, src, cfg)
                summary["sources"].append({"id": src["id"], "path": src["path"], **res})
            if cfg.embeddings_provider and cfg.embeddings_model:
                try:
                    summary["embedded"] = await self._embed_missing(cfg)
                except Exception as e:
                    summary["embed_error"] = f"{type(e).__name__}: {e}"[:300]
            summary["seconds"] = round(time.time() - t0, 1)
            summary["ok"] = True
            self.last = summary
            return summary
        finally:
            self.indexing = False
            self._run = None

    # ------------------------------------------------------------ embeddings
    async def embed(self, texts: list[str]) -> list[list[float]]:
        cfg = self.get_cfg()
        pc = self.get_provider(cfg.embeddings_provider)
        if not pc or not cfg.embeddings_model:
            raise RuntimeError("embeddings provider/model not configured")
        base = (pc.base_url or "").rstrip("/")
        if pc.kind == "openai" and not base:
            base = "https://api.openai.com/v1"
        headers = {"Content-Type": "application/json", **pc.headers}
        key = pc.resolved_api_key()
        if key:
            headers["Authorization"] = f"Bearer {key}"
        async with httpx.AsyncClient(timeout=120.0, verify=not pc.allow_insecure_tls) as c:
            r = await c.post(f"{base}/embeddings", headers=headers, json={"model": cfg.embeddings_model, "input": texts})
        if r.status_code >= 400:
            raise RuntimeError(f"HTTP {r.status_code} from embeddings: {r.text[:300]}")
        data = sorted(r.json().get("data", []), key=lambda d: d.get("index", 0))
        return [d["embedding"] for d in data]

    async def _embed_missing(self, cfg: KnowledgeConfig) -> int:
        done = 0
        batch = 10  # the smallest common limit (DashScope caps a request at 10 inputs; OpenAI allows far more)
        while True:
            rows = self.store.kb_chunks_without_vectors(cfg.embeddings_model, limit=batch)
            if not rows:
                return done
            vecs = await self.embed([r["text"][:6000] for r in rows])
            for row, v in zip(rows, vecs):
                self.store.kb_set_vector(row["id"], cfg.embeddings_model, array("f", v).tobytes(), len(v))
                done += 1

    # ------------------------------------------------------------ search
    def _vector_rank(self, qv: list[float], model: str, limit: int) -> list[tuple[str, float]]:
        rows = self.store.kb_vectors(model)
        if not rows:
            return []
        if _np is not None:
            ids = [r[0] for r in rows]
            mat = _np.stack([_np.frombuffer(r[2], dtype=_np.float32) for r in rows if r[1] == len(qv)])
            q = _np.asarray(qv, dtype=_np.float32)
            sims = mat @ q / (_np.linalg.norm(mat, axis=1) * (_np.linalg.norm(q) or 1.0) + 1e-9)
            order = _np.argsort(-sims)[:limit]
            return [(ids[int(i)], float(sims[int(i)])) for i in order]
        qn = math.sqrt(sum(x * x for x in qv)) or 1.0
        scored: list[tuple[str, float]] = []
        for cid, dim, blob in rows:
            if dim != len(qv):
                continue
            v = array("f")
            v.frombytes(blob)
            dot = sum(a * b for a, b in zip(v, qv))
            vn = math.sqrt(sum(a * a for a in v)) or 1.0
            scored.append((cid, dot / (vn * qn)))
        scored.sort(key=lambda t: -t[1])
        return scored[:limit]

    async def search(self, query: str, k: int = 6) -> list[dict]:
        """Hybrid retrieval: FTS hits and vector hits fused by reciprocal rank; each hit carries path, idx, text, score."""
        query = (query or "").strip()
        if not query:
            return []
        cfg = self.get_cfg()
        fts = self.store.kb_search_text(query, limit=max(12, k * 3))
        ranks: dict[str, float] = {}
        for i, h in enumerate(fts):
            ranks[h["chunk_id"]] = ranks.get(h["chunk_id"], 0.0) + 1.0 / (60 + i)
        if cfg.embeddings_provider and cfg.embeddings_model and self.store.kb_stats()["vectors"]:
            try:
                qv = (await self.embed([query[:6000]]))[0]
                for i, (cid, _sim) in enumerate(self._vector_rank(qv, cfg.embeddings_model, max(12, k * 3))):
                    ranks[cid] = ranks.get(cid, 0.0) + 1.0 / (60 + i)
            except Exception as e:  # keyword results still answer
                log.warning("vector search skipped: %s", e)
        top = sorted(ranks.items(), key=lambda t: -t[1])[:k]
        chunks = self.store.kb_get_chunks([cid for cid, _ in top])
        out = []
        for cid, score in top:
            c = chunks.get(cid)
            if c:
                out.append({"chunk_id": cid, "path": c["path"], "idx": c["idx"], "text": c["text"], "score": round(score * 60, 3)})
        return out
