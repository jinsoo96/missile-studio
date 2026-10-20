"""Built-in local tools (server name ``local``), sandboxed to the workspace folder.

Tools: run_shell, read_file, write_file, list_dir, search_files, fetch_url, now.
Paths must resolve inside the workspace (symlinks resolved) or one of the extra allowed roots.
Dangerous shell commands are flagged so the policy layer always asks a human first.
"""

from __future__ import annotations

import asyncio
import datetime as _dt
import fnmatch
import os
import platform
import re
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional

import httpx

from ..mcp.manager import SEP, ToolInfo

LOCAL = "local"

DANGEROUS_PATTERNS = [
    r"\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b",
    r"\brm\s+-rf\b",
    r"\bRemove-Item\b.*-Recurse",
    r"\brmdir\s+/s",
    r"\bdel\s+/[fsq]",
    r"\bformat\b\s+[a-zA-Z]:",
    r"\bmkfs\b",
    r"\bdd\s+if=",
    r"\bshutdown\b|\breboot\b|\bRestart-Computer\b|\bStop-Computer\b",
    r"\bgit\s+push\s+.*--force|\bgit\s+reset\s+--hard|\bgit\s+clean\s+-[a-zA-Z]*f",
    r"\bdrop\s+(table|database)\b",
    r"\bchmod\s+-R\s+777\b",
    r":\(\)\s*\{\s*:\|:&\s*\};:",
    r"\bcurl\b.*\|\s*(ba)?sh\b|\bwget\b.*\|\s*(ba)?sh\b|\biwr\b.*\|\s*iex\b",
    r"\bnpm\s+publish\b|\btwine\s+upload\b",
    r"\bkubectl\s+delete\b|\bdocker\s+(system\s+prune|rm\s+-f|rmi)\b",
]
_DANGER_RE = [re.compile(p, re.IGNORECASE) for p in DANGEROUS_PATTERNS]


def is_dangerous_command(cmd: str) -> bool:
    return any(r.search(cmd) for r in _DANGER_RE)


@dataclass
class BuiltinTool:
    name: str
    description: str
    input_schema: dict
    fn: Callable[..., Any]
    read_only: bool = False
    destructive: bool = False

    @property
    def full_name(self) -> str:
        return f"{LOCAL}{SEP}{self.name}"

    def info(self) -> ToolInfo:
        return ToolInfo(
            server=LOCAL,
            name=self.name,
            full_name=self.full_name,
            description=self.description,
            input_schema=self.input_schema,
            read_only=self.read_only,
            destructive=self.destructive,
            open_world=self.name == "fetch_url",
        )


class LocalTools:
    def __init__(self, workspace: Path, allowed_roots: Optional[list[Path]] = None, enable_shell: bool = True, enable_fs: bool = True, enable_web: bool = True):
        self.workspace = workspace
        self.workspace.mkdir(parents=True, exist_ok=True)
        self.allowed_roots = [self.workspace.resolve()] + [Path(p).expanduser().resolve() for p in (allowed_roots or [])]
        self.tools: dict[str, BuiltinTool] = {}
        if enable_shell:
            self._add(
                "run_shell",
                "Run one non-interactive shell command on this machine inside the workspace folder "
                f"({'PowerShell' if os.name == 'nt' else 'sh'}). Returns stdout+stderr (truncated) and the exit code.",
                {"type": "object", "properties": {"command": {"type": "string"}, "timeout_seconds": {"type": "integer", "default": 120}, "cwd": {"type": "string", "description": "relative to the workspace"}}, "required": ["command"]},
                self.run_shell,
                destructive=True,
            )
        if enable_fs:
            self._add("read_file", "Read a UTF-8 text file inside the workspace. Supports offset/limit by line.", {"type": "object", "properties": {"path": {"type": "string"}, "offset": {"type": "integer", "default": 0}, "limit": {"type": "integer", "default": 2000}}, "required": ["path"]}, self.read_file, read_only=True)
            self._add("write_file", "Create or overwrite a UTF-8 text file inside the workspace (parent folders are created).", {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}, "append": {"type": "boolean", "default": False}}, "required": ["path", "content"]}, self.write_file, destructive=True)
            self._add("list_dir", "List entries of a folder inside the workspace.", {"type": "object", "properties": {"path": {"type": "string", "default": "."}, "recursive": {"type": "boolean", "default": False}, "max_entries": {"type": "integer", "default": 500}}}, self.list_dir, read_only=True)
            self._add("search_files", "Search text (regex) in files under the workspace. Returns path:line:text matches.", {"type": "object", "properties": {"pattern": {"type": "string"}, "path": {"type": "string", "default": "."}, "glob": {"type": "string", "default": "*"}, "max_results": {"type": "integer", "default": 200}}, "required": ["pattern"]}, self.search_files, read_only=True)
        if enable_web:
            self._add("fetch_url", "HTTP GET a URL and return the body as text (HTML tags stripped), truncated.", {"type": "object", "properties": {"url": {"type": "string"}, "max_chars": {"type": "integer", "default": 20000}}, "required": ["url"]}, self.fetch_url, read_only=True)
        self._add("now", "Current date/time with timezone, plus OS and workspace path.", {"type": "object", "properties": {}}, self.now, read_only=True)

    def _add(self, name: str, desc: str, schema: dict, fn: Callable, read_only: bool = False, destructive: bool = False) -> None:
        self.tools[name] = BuiltinTool(name, desc, schema, fn, read_only=read_only, destructive=destructive)

    # ------------------------------------------------------------ helpers
    def _resolve(self, rel: str) -> Path:
        p = Path(rel).expanduser()
        if not p.is_absolute():
            p = self.workspace / p
        rp = p.resolve()
        for root in self.allowed_roots:
            try:
                rp.relative_to(root)
                return rp
            except ValueError:
                continue
        raise PermissionError(f"[PATH_OUTSIDE_WORKSPACE] {rel} is outside {self.workspace}")

    def infos(self) -> list[ToolInfo]:
        return [t.info() for t in self.tools.values()]

    async def call(self, full_name: str, arguments: dict) -> dict:
        name = full_name.split(SEP, 1)[1] if SEP in full_name else full_name
        tool = self.tools.get(name)
        if tool is None:
            return {"content": [{"type": "text", "text": f"unknown local tool {name}"}], "is_error": True, "text": f"unknown local tool {name}"}
        try:
            res = tool.fn(**(arguments or {}))
            if asyncio.iscoroutine(res):
                res = await res
            text = res if isinstance(res, str) else str(res)
            return {"content": [{"type": "text", "text": text}], "is_error": False, "text": text}
        except TypeError as e:
            msg = f"bad arguments for {name}: {e}"
            return {"content": [{"type": "text", "text": msg}], "is_error": True, "text": msg}
        except Exception as e:
            msg = f"{type(e).__name__}: {e}"
            return {"content": [{"type": "text", "text": msg}], "is_error": True, "text": msg}

    # ------------------------------------------------------------ tools
    async def run_shell(self, command: str, timeout_seconds: int = 120, cwd: str = "") -> str:
        workdir = self._resolve(cwd) if cwd else self.workspace
        if os.name == "nt":
            exe = shutil.which("pwsh") or shutil.which("powershell") or "powershell"
            argv = [exe, "-NoProfile", "-NonInteractive", "-Command", command]
        else:
            argv = [os.environ.get("SHELL", "/bin/sh"), "-lc", command]
        env = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "MISSILE_WORKSPACE": str(self.workspace)}
        proc = await asyncio.create_subprocess_exec(*argv, cwd=str(workdir), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, stdin=asyncio.subprocess.DEVNULL, env=env)
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=max(1, int(timeout_seconds)))
        except asyncio.TimeoutError:
            with _suppress():
                proc.kill()
            return f"[TIMEOUT] command exceeded {timeout_seconds}s"
        text = out.decode("utf-8", "replace") if out else ""
        if len(text) > 60000:
            text = text[:30000] + f"\n... [{len(text) - 60000} chars truncated] ...\n" + text[-30000:]
        return f"{text.rstrip()}\n[exit {proc.returncode}]"

    def read_file(self, path: str, offset: int = 0, limit: int = 2000) -> str:
        p = self._resolve(path)
        if not p.is_file():
            raise FileNotFoundError(f"{path} is not a file")
        if p.stat().st_size > 20 * 1024 * 1024:
            raise ValueError("file larger than 20MB")
        lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
        chunk = lines[max(0, offset) : max(0, offset) + max(1, limit)]
        head = f"[{p.relative_to(self.workspace) if _inside(p, self.workspace) else p}] lines {offset + 1}-{offset + len(chunk)} of {len(lines)}\n"
        return head + "\n".join(chunk)

    def write_file(self, path: str, content: str, append: bool = False) -> str:
        p = self._resolve(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("a" if append else "w", encoding="utf-8", newline="\n") as f:
            f.write(content)
        return f"wrote {len(content)} chars to {p}"

    def list_dir(self, path: str = ".", recursive: bool = False, max_entries: int = 500) -> str:
        p = self._resolve(path)
        if not p.is_dir():
            raise NotADirectoryError(f"{path} is not a directory")
        out: list[str] = []
        it = p.rglob("*") if recursive else p.iterdir()
        for e in sorted(it, key=lambda x: str(x).lower()):
            if any(part in (".git", "node_modules", "__pycache__", ".venv") for part in e.parts):
                continue
            rel = e.relative_to(p)
            try:
                size = e.stat().st_size if e.is_file() else 0
            except OSError:
                size = 0
            out.append(f"{'d' if e.is_dir() else 'f'} {size:>10} {rel}")
            if len(out) >= max_entries:
                out.append(f"... truncated at {max_entries}")
                break
        return f"{p}\n" + "\n".join(out) if out else f"{p}\n(empty)"

    def search_files(self, pattern: str, path: str = ".", glob: str = "*", max_results: int = 200) -> str:
        root = self._resolve(path)
        rx = re.compile(pattern, re.IGNORECASE)
        hits: list[str] = []
        for f in root.rglob(glob):
            if not f.is_file() or any(part in (".git", "node_modules", "__pycache__", ".venv") for part in f.parts):
                continue
            try:
                if f.stat().st_size > 5 * 1024 * 1024:
                    continue
                with f.open("r", encoding="utf-8", errors="replace") as fh:
                    for i, line in enumerate(fh, 1):
                        if rx.search(line):
                            hits.append(f"{f.relative_to(root)}:{i}:{line.rstrip()[:300]}")
                            if len(hits) >= max_results:
                                return "\n".join(hits) + f"\n... truncated at {max_results}"
            except OSError:
                continue
        return "\n".join(hits) if hits else "(no matches)"

    async def fetch_url(self, url: str, max_chars: int = 20000) -> str:
        if not re.match(r"^https?://", url):
            raise ValueError("only http(s) URLs")
        async with httpx.AsyncClient(follow_redirects=True, timeout=30.0, headers={"User-Agent": "missile-studio/0.1"}) as c:
            r = await c.get(url)
        ctype = r.headers.get("content-type", "")
        body = r.text
        if "html" in ctype:
            body = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", body, flags=re.S | re.I)
            body = re.sub(r"<[^>]+>", " ", body)
            body = re.sub(r"[ \t]+", " ", body)
            body = re.sub(r"\n\s*\n+", "\n", body)
        body = body.strip()
        if len(body) > max_chars:
            body = body[:max_chars] + f"\n... [truncated, {len(body)} chars total]"
        return f"HTTP {r.status_code} {ctype}\n{body}"

    def now(self) -> str:
        n = _dt.datetime.now().astimezone()
        return f"{n.isoformat()} ({n.tzname()}) | {platform.system()} {platform.release()} | python {sys.version.split()[0]} | workspace {self.workspace}"


def _inside(p: Path, root: Path) -> bool:
    try:
        p.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


class _suppress:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return True


def match_rule(name: str, rules: dict[str, str]) -> Optional[str]:
    if name in rules:
        return rules[name]
    for pat, dec in rules.items():
        if any(ch in pat for ch in "*?[") and fnmatch.fnmatch(name, pat):
            return dec
    return None
