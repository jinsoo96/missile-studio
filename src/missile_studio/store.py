"""SQLite persistence (stdlib sqlite3, WAL).

Tables: conversations, messages, tool_audit, admin_users, api_tokens, events, settings.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from .config import db_path

SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  assistant_id TEXT NOT NULL DEFAULT 'default',
  provider_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at REAL NOT NULL,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE TABLE IF NOT EXISTS tool_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL,
  conversation_id TEXT NOT NULL DEFAULT '',
  tool TEXT NOT NULL,
  arguments TEXT NOT NULL DEFAULT '{}',
  decision TEXT NOT NULL DEFAULT '',
  is_error INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  result_excerpt TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON tool_audit(ts);
CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL,
  last_login_at REAL
);
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT 'chat',
  created_at REAL NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  last_used_at REAL,
  revoked_at REAL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  category TEXT NOT NULL DEFAULT 'system',
  message TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  actor TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_cat ON events(category);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at REAL NOT NULL
);
"""


def _message_text(message: dict) -> str:
    """The searchable text of a stored message: plain content or the text parts of a multimodal one."""
    c = message.get("content")
    if isinstance(c, str):
        return c.strip()
    if isinstance(c, list):
        return "\n".join(str(p.get("text", "")) for p in c if isinstance(p, dict) and p.get("type") == "text").strip()
    return ""


def _fts_phrase(q: str) -> str:
    """Quote a user string as one FTS5 phrase (trigram: substring match, no operator surprises)."""
    return '"' + q.replace('"', '""') + '"'


def sha256(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


class Store:
    def __init__(self, path: Optional[Path] = None):
        self.path = path or db_path()
        self._local = threading.local()
        with self._conn() as c:
            c.executescript(SCHEMA)
            self._migrate(c)

    def _conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(str(self.path), check_same_thread=False, isolation_level=None)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA foreign_keys=ON")
            self._local.conn = conn
        return conn

    def _migrate(self, conn: sqlite3.Connection) -> None:
        """Add columns and side tables introduced after 0.1 (branching, styles, account roles, compaction, search,
        memories, knowledge base). Idempotent."""
        acols = {r[1] for r in conn.execute("PRAGMA table_info(admin_users)").fetchall()}
        if acols and "role" not in acols:
            conn.execute("ALTER TABLE admin_users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'")  # admin | user (sign-ups)
        ccols = {r[1] for r in conn.execute("PRAGMA table_info(conversations)").fetchall()}
        if "summary" not in ccols:
            conn.execute("ALTER TABLE conversations ADD COLUMN summary TEXT NOT NULL DEFAULT ''")  # compacted earlier history
        if "summary_upto" not in ccols:
            conn.execute("ALTER TABLE conversations ADD COLUMN summary_upto TEXT")  # id of the last message the summary covers
        # full-text search over message bodies, memories and knowledge chunks. trigram = substring matches, Korean included.
        self.fts = True
        try:
            conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, message_id UNINDEXED, conversation_id UNINDEXED, role UNINDEXED, tokenize='trigram')")
            conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(text, memory_id UNINDEXED, tokenize='trigram')")
            conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(text, chunk_id UNINDEXED, tokenize='trigram')")
        except sqlite3.OperationalError:
            self.fts = False
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS memories (
              id TEXT PRIMARY KEY, text TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '',
              created_at REAL NOT NULL, updated_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS kb_sources (
              id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, added_at REAL NOT NULL, indexed_at REAL, files INTEGER NOT NULL DEFAULT 0, chunks INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS kb_chunks (
              id TEXT PRIMARY KEY, source_id TEXT NOT NULL, path TEXT NOT NULL, idx INTEGER NOT NULL, text TEXT NOT NULL, mtime REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS kb_chunks_path ON kb_chunks(source_id, path);
            CREATE TABLE IF NOT EXISTS kb_vectors (chunk_id TEXT PRIMARY KEY, model TEXT NOT NULL, dim INTEGER NOT NULL, vec BLOB NOT NULL);
            """
        )
        if self.fts and conn.execute("SELECT COUNT(*) FROM messages_fts").fetchone()[0] == 0:
            for r in conn.execute("SELECT id, conversation_id, role, content FROM messages WHERE role IN ('user','assistant')").fetchall():
                text = _message_text(json.loads(r[3]))
                if text:
                    conn.execute("INSERT INTO messages_fts(text, message_id, conversation_id, role) VALUES (?,?,?,?)", (text, r[0], r[1], r[2]))
        cols = {r[1] for r in conn.execute("PRAGMA table_info(messages)").fetchall()}
        if "parent_id" not in cols:
            conn.execute("ALTER TABLE messages ADD COLUMN parent_id TEXT")
        cols = {r[1] for r in conn.execute("PRAGMA table_info(conversations)").fetchall()}
        if "head_id" not in cols:
            conn.execute("ALTER TABLE conversations ADD COLUMN head_id TEXT")
        if "style_id" not in cols:
            conn.execute("ALTER TABLE conversations ADD COLUMN style_id TEXT NOT NULL DEFAULT ''")
        # legacy linear conversations: chain by seq and point head at the last message
        for row in conn.execute("SELECT id FROM conversations WHERE head_id IS NULL").fetchall():
            ids = [r[0] for r in conn.execute("SELECT id FROM messages WHERE conversation_id=? ORDER BY seq", (row[0],)).fetchall()]
            prev = None
            for mid in ids:
                conn.execute("UPDATE messages SET parent_id=? WHERE id=?", (prev, mid))
                prev = mid
            if prev:
                conn.execute("UPDATE conversations SET head_id=? WHERE id=?", (prev, row[0]))

    # ---- conversations
    def create_conversation(self, *, title: str = "", assistant_id: str = "default", provider_id: str = "", model: str = "") -> dict:
        cid = uuid.uuid4().hex[:16]
        now = time.time()
        self._conn().execute(
            "INSERT INTO conversations(id,title,assistant_id,provider_id,model,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
            (cid, title, assistant_id, provider_id, model, now, now),
        )
        return self.get_conversation(cid)  # type: ignore[return-value]

    def get_conversation(self, cid: str) -> Optional[dict]:
        row = self._conn().execute("SELECT * FROM conversations WHERE id=?", (cid,)).fetchone()
        return dict(row) if row else None

    def list_conversations(self, limit: int = 200, offset: int = 0, q: str = "") -> list[dict]:
        if q:
            rows = self._conn().execute(
                "SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id) AS message_count FROM conversations c WHERE title LIKE ? ORDER BY updated_at DESC LIMIT ? OFFSET ?",
                (f"%{q}%", limit, offset),
            ).fetchall()
        else:
            rows = self._conn().execute(
                "SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id) AS message_count FROM conversations c ORDER BY updated_at DESC LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
        return [dict(r) for r in rows]

    def count_conversations(self, q: str = "") -> int:
        if q:
            return self._conn().execute("SELECT COUNT(*) FROM conversations WHERE title LIKE ?", (f"%{q}%",)).fetchone()[0]
        return self._conn().execute("SELECT COUNT(*) FROM conversations").fetchone()[0]

    def update_conversation(self, cid: str, **fields: Any) -> None:
        if not fields:
            return
        fields["updated_at"] = time.time()
        cols = ", ".join(f"{k}=?" for k in fields)
        self._conn().execute(f"UPDATE conversations SET {cols} WHERE id=?", (*fields.values(), cid))

    def delete_conversation(self, cid: str) -> None:
        self._conn().execute("DELETE FROM messages WHERE conversation_id=?", (cid,))
        self._conn().execute("DELETE FROM conversations WHERE id=?", (cid,))
        if getattr(self, "fts", False):
            self._conn().execute("DELETE FROM messages_fts WHERE conversation_id=?", (cid,))

    # ---- messages
    def append_message(self, cid: str, message: dict, parent_id: Any = "__head__") -> str:
        """Append a message. By default it hangs off the conversation head and becomes the new head."""
        conn = self._conn()
        if parent_id == "__head__":
            row = conn.execute("SELECT head_id FROM conversations WHERE id=?", (cid,)).fetchone()
            parent_id = (row["head_id"] or None) if row else None
        seq = conn.execute("SELECT COALESCE(MAX(seq),0)+1 FROM messages WHERE conversation_id=?", (cid,)).fetchone()[0]
        mid = message.get("id") or uuid.uuid4().hex[:16]
        body = {k: v for k, v in message.items() if k != "id"}
        conn.execute(
            "INSERT INTO messages(id,conversation_id,seq,role,content,created_at,parent_id) VALUES (?,?,?,?,?,?,?)",
            (mid, cid, seq, message.get("role", "user"), json.dumps(body, ensure_ascii=False), time.time(), parent_id),
        )
        conn.execute("UPDATE conversations SET updated_at=?, head_id=? WHERE id=?", (time.time(), mid, cid))
        self.index_message(mid, cid, message.get("role", "user"), body)
        return mid

    def _rows(self, cid: str) -> dict[str, sqlite3.Row]:
        return {r["id"]: r for r in self._conn().execute("SELECT id, parent_id, seq, created_at, content FROM messages WHERE conversation_id=? ORDER BY seq", (cid,)).fetchall()}

    def get_messages(self, cid: str) -> list[dict]:
        """The visible thread: root -> head (other branches are hidden)."""
        conn = self._conn()
        conv = conn.execute("SELECT head_id FROM conversations WHERE id=?", (cid,)).fetchone()
        rows = self._rows(cid)
        if not rows:
            return []
        head = conv["head_id"] if conv else None
        if head == "":
            return []  # head rewound to the root: the next message starts a sibling branch at the top
        if not head or head not in rows:
            head = max(rows.values(), key=lambda r: r["seq"])["id"]
        path: list[dict] = []
        cur = head
        seen = set()
        while cur and cur in rows and cur not in seen:
            seen.add(cur)
            r = rows[cur]
            m = json.loads(r["content"])
            m["id"] = r["id"]
            m["parent_id"] = r["parent_id"]
            path.append(m)
            cur = r["parent_id"]
        path.reverse()
        return path

    def branch_info(self, cid: str, path: list[dict]) -> dict[str, dict]:
        """For each message on the path: its siblings (same parent) and its index among them."""
        rows = self._rows(cid)
        by_parent: dict[Any, list[str]] = {}
        for r in sorted(rows.values(), key=lambda r: r["seq"]):
            by_parent.setdefault(r["parent_id"], []).append(r["id"])
        out = {}
        for m in path:
            sibs = by_parent.get(m.get("parent_id"), [m["id"]])
            if len(sibs) > 1:
                out[m["id"]] = {"siblings": sibs, "index": sibs.index(m["id"]) if m["id"] in sibs else 0}
        return out

    def leaf_of(self, cid: str, message_id: str) -> str:
        """Follow the most recent child chain down from a message."""
        rows = self._rows(cid)
        cur = message_id
        while True:
            kids = [r for r in rows.values() if r["parent_id"] == cur]
            if not kids:
                return cur
            cur = max(kids, key=lambda r: r["seq"])["id"]

    def set_head(self, cid: str, message_id) -> None:
        """Point the visible thread at a message. None means the root ("" is stored so it is not mistaken for a legacy row)."""
        self._conn().execute("UPDATE conversations SET head_id=? WHERE id=?", (message_id or "", cid))

    def parent_of(self, cid: str, message_id: str):
        row = self._conn().execute("SELECT parent_id FROM messages WHERE id=? AND conversation_id=?", (message_id, cid)).fetchone()
        return row["parent_id"] if row else None

    def truncate_after(self, cid: str, message_id: str) -> None:
        conn = self._conn()
        row = conn.execute("SELECT seq FROM messages WHERE id=? AND conversation_id=?", (message_id, cid)).fetchone()
        if row:
            conn.execute("DELETE FROM messages WHERE conversation_id=? AND seq>=?", (cid, row["seq"]))

    # ---- full-text search over chats
    def index_message(self, mid: str, cid: str, role: str, message: dict) -> None:
        if not getattr(self, "fts", False) or role not in ("user", "assistant"):
            return
        text = _message_text(message)
        if text:
            self._conn().execute("INSERT INTO messages_fts(text, message_id, conversation_id, role) VALUES (?,?,?,?)", (text, mid, cid, role))

    def search_messages(self, q: str, limit: int = 30) -> list[dict]:
        """Chats whose messages contain ``q`` (substring, any language), newest first, with a snippet per hit."""
        q = (q or "").strip()
        if not q:
            return []
        conn = self._conn()
        rows: list = []
        if getattr(self, "fts", False) and len(q) >= 3:
            rows = conn.execute(
                "SELECT f.message_id, f.conversation_id, f.role, snippet(messages_fts, 0, '[', ']', '…', 18) AS snip, m.created_at, c.title "
                "FROM messages_fts f JOIN messages m ON m.id=f.message_id JOIN conversations c ON c.id=f.conversation_id "
                "WHERE messages_fts MATCH ? ORDER BY m.created_at DESC LIMIT ?",
                (_fts_phrase(q), limit),
            ).fetchall()
        if not rows:  # short queries (trigram needs 3 chars), or no FTS: substring scan over the message text itself
            like = f"%{q}%"
            rows = conn.execute(
                "WITH t AS (SELECT m.id, m.conversation_id, m.role, m.created_at, c.title, "
                "CASE WHEN json_type(m.content, '$.content') = 'text' THEN json_extract(m.content, '$.content') ELSE m.content END AS body "
                "FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.role IN ('user','assistant')) "
                "SELECT id, conversation_id, role, replace(substr(body, max(1, instr(body, ?) - 40), 120), ?, '[' || ? || ']'), created_at, title "
                "FROM t WHERE body LIKE ? ORDER BY created_at DESC LIMIT ?",
                (q, q, q, like, limit),
            ).fetchall()
        return [{"message_id": r[0], "conversation_id": r[1], "role": r[2], "snippet": r[3], "created_at": r[4], "title": r[5]} for r in rows]

    # ---- memories (facts about the user that outlive one chat)
    def add_memory(self, text: str, source: str = "", tags: str = "") -> dict:
        mid = uuid.uuid4().hex[:12]
        now = time.time()
        conn = self._conn()
        conn.execute("INSERT INTO memories(id,text,source,tags,created_at,updated_at) VALUES (?,?,?,?,?,?)", (mid, text.strip(), source, tags, now, now))
        if getattr(self, "fts", False):
            conn.execute("INSERT INTO memories_fts(text, memory_id) VALUES (?,?)", (text.strip(), mid))
        return self.get_memory(mid)  # type: ignore[return-value]

    def get_memory(self, mid: str) -> Optional[dict]:
        row = self._conn().execute("SELECT * FROM memories WHERE id=?", (mid,)).fetchone()
        return dict(row) if row else None

    def list_memories(self, limit: int = 500) -> list[dict]:
        return [dict(r) for r in self._conn().execute("SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?", (limit,)).fetchall()]

    def update_memory(self, mid: str, text: str) -> bool:
        conn = self._conn()
        cur = conn.execute("UPDATE memories SET text=?, updated_at=? WHERE id=?", (text.strip(), time.time(), mid))
        if cur.rowcount and getattr(self, "fts", False):
            conn.execute("DELETE FROM memories_fts WHERE memory_id=?", (mid,))
            conn.execute("INSERT INTO memories_fts(text, memory_id) VALUES (?,?)", (text.strip(), mid))
        return cur.rowcount > 0

    def delete_memory(self, mid: str) -> bool:
        conn = self._conn()
        cur = conn.execute("DELETE FROM memories WHERE id=?", (mid,))
        if getattr(self, "fts", False):
            conn.execute("DELETE FROM memories_fts WHERE memory_id=?", (mid,))
        return cur.rowcount > 0

    def search_memories(self, q: str, limit: int = 5) -> list[dict]:
        """Memories matching any 3+ character word of ``q`` (OR), best first; falls back to the newest ones."""
        words = [w for w in re.findall(r"[\w가-힣]{3,}", q or "") if not w.isdigit()][:12]
        conn = self._conn()
        if words and getattr(self, "fts", False):
            match = " OR ".join(_fts_phrase(w) for w in words)
            try:
                rows = conn.execute("SELECT m.* FROM memories_fts f JOIN memories m ON m.id=f.memory_id WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?", (match, limit)).fetchall()
                if rows:
                    return [dict(r) for r in rows]
            except sqlite3.OperationalError:
                pass
        return []

    # ---- knowledge base (indexed folders/files)
    def kb_add_source(self, path: str) -> dict:
        sid = uuid.uuid4().hex[:10]
        conn = self._conn()
        row = conn.execute("SELECT * FROM kb_sources WHERE path=?", (path,)).fetchone()
        if row:
            return dict(row)
        conn.execute("INSERT INTO kb_sources(id,path,added_at) VALUES (?,?,?)", (sid, path, time.time()))
        return dict(conn.execute("SELECT * FROM kb_sources WHERE id=?", (sid,)).fetchone())

    def kb_list_sources(self) -> list[dict]:
        return [dict(r) for r in self._conn().execute("SELECT * FROM kb_sources ORDER BY added_at").fetchall()]

    def kb_update_source(self, sid: str, **fields: Any) -> None:
        if fields:
            cols = ", ".join(f"{k}=?" for k in fields)
            self._conn().execute(f"UPDATE kb_sources SET {cols} WHERE id=?", (*fields.values(), sid))

    def kb_delete_source(self, sid: str) -> bool:
        conn = self._conn()
        ids = [r[0] for r in conn.execute("SELECT id FROM kb_chunks WHERE source_id=?", (sid,)).fetchall()]
        self._kb_drop_chunks(ids)
        return conn.execute("DELETE FROM kb_sources WHERE id=?", (sid,)).rowcount > 0

    def kb_file_mtimes(self, sid: str) -> dict[str, float]:
        return {r[0]: r[1] for r in self._conn().execute("SELECT path, MAX(mtime) FROM kb_chunks WHERE source_id=? GROUP BY path", (sid,)).fetchall()}

    def _kb_drop_chunks(self, ids: list[str]) -> None:
        conn = self._conn()
        for i in range(0, len(ids), 500):
            batch = ids[i : i + 500]
            marks = ",".join("?" * len(batch))
            conn.execute(f"DELETE FROM kb_chunks WHERE id IN ({marks})", batch)
            conn.execute(f"DELETE FROM kb_vectors WHERE chunk_id IN ({marks})", batch)
            if getattr(self, "fts", False):
                conn.execute(f"DELETE FROM kb_fts WHERE chunk_id IN ({marks})", batch)

    def kb_replace_file(self, sid: str, path: str, chunks: list[str], mtime: float) -> list[str]:
        """Re-index one file: drop its old chunks, insert the new ones. Returns the new chunk ids."""
        conn = self._conn()
        old = [r[0] for r in conn.execute("SELECT id FROM kb_chunks WHERE source_id=? AND path=?", (sid, path)).fetchall()]
        self._kb_drop_chunks(old)
        ids = []
        for i, text in enumerate(chunks):
            cid = uuid.uuid4().hex[:14]
            conn.execute("INSERT INTO kb_chunks(id,source_id,path,idx,text,mtime) VALUES (?,?,?,?,?,?)", (cid, sid, path, i, text, mtime))
            if getattr(self, "fts", False):
                conn.execute("INSERT INTO kb_fts(text, chunk_id) VALUES (?,?)", (text, cid))
            ids.append(cid)
        return ids

    def kb_drop_file(self, sid: str, path: str) -> None:
        ids = [r[0] for r in self._conn().execute("SELECT id FROM kb_chunks WHERE source_id=? AND path=?", (sid, path)).fetchall()]
        self._kb_drop_chunks(ids)

    def kb_search_text(self, q: str, limit: int = 12) -> list[dict]:
        q = (q or "").strip()
        conn = self._conn()
        words = [w for w in re.findall(r"[\w가-힣]{3,}", q)][:12]
        rows: list = []
        if words and getattr(self, "fts", False):
            match = " OR ".join(_fts_phrase(w) for w in words)
            try:
                rows = conn.execute("SELECT c.id, c.path, c.idx, c.text, rank FROM kb_fts f JOIN kb_chunks c ON c.id=f.chunk_id WHERE kb_fts MATCH ? ORDER BY rank LIMIT ?", (match, limit)).fetchall()
            except sqlite3.OperationalError:
                rows = []
        if not rows and q:
            rows = conn.execute("SELECT id, path, idx, text, 0 FROM kb_chunks WHERE text LIKE ? LIMIT ?", (f"%{q}%", limit)).fetchall()
        return [{"chunk_id": r[0], "path": r[1], "idx": r[2], "text": r[3], "score": float(r[4] or 0)} for r in rows]

    def kb_get_chunks(self, ids: list[str]) -> dict[str, dict]:
        if not ids:
            return {}
        marks = ",".join("?" * len(ids))
        return {r["id"]: dict(r) for r in self._conn().execute(f"SELECT * FROM kb_chunks WHERE id IN ({marks})", ids).fetchall()}

    def kb_chunks_without_vectors(self, model: str, limit: int = 256) -> list[dict]:
        return [dict(r) for r in self._conn().execute("SELECT c.id, c.text FROM kb_chunks c LEFT JOIN kb_vectors v ON v.chunk_id=c.id AND v.model=? WHERE v.chunk_id IS NULL LIMIT ?", (model, limit)).fetchall()]

    def kb_set_vector(self, chunk_id: str, model: str, vec: bytes, dim: int) -> None:
        self._conn().execute("INSERT OR REPLACE INTO kb_vectors(chunk_id, model, dim, vec) VALUES (?,?,?,?)", (chunk_id, model, dim, vec))

    def kb_vectors(self, model: str) -> list[tuple[str, int, bytes]]:
        return [(r[0], r[1], r[2]) for r in self._conn().execute("SELECT chunk_id, dim, vec FROM kb_vectors WHERE model=?", (model,)).fetchall()]

    def kb_stats(self) -> dict:
        conn = self._conn()
        return {
            "sources": conn.execute("SELECT COUNT(*) FROM kb_sources").fetchone()[0],
            "chunks": conn.execute("SELECT COUNT(*) FROM kb_chunks").fetchone()[0],
            "vectors": conn.execute("SELECT COUNT(*) FROM kb_vectors").fetchone()[0],
            "fts": bool(getattr(self, "fts", False)),
        }

    # ---- audit
    def audit(self, *, conversation_id: str, tool: str, arguments: dict, decision: str, is_error: bool, duration_ms: int, result_excerpt: str) -> None:
        self._conn().execute(
            "INSERT INTO tool_audit(ts,conversation_id,tool,arguments,decision,is_error,duration_ms,result_excerpt) VALUES (?,?,?,?,?,?,?,?)",
            (time.time(), conversation_id, tool, json.dumps(arguments, ensure_ascii=False)[:4000], decision, int(is_error), duration_ms, result_excerpt[:2000]),
        )

    def list_audit(self, limit: int = 200, conversation_id: str = "") -> list[dict]:
        if conversation_id:
            rows = self._conn().execute(
                "SELECT * FROM tool_audit WHERE conversation_id=? ORDER BY ts DESC LIMIT ?", (conversation_id, limit)
            ).fetchall()
        else:
            rows = self._conn().execute("SELECT * FROM tool_audit ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()
        return [dict(r) for r in rows]

    # ---- admin users
    def list_admins(self) -> list[dict]:
        return [dict(r) for r in self._conn().execute("SELECT id, username, role, must_change_password, created_at, last_login_at FROM admin_users ORDER BY id").fetchall()]

    def get_admin(self, username: str) -> Optional[dict]:
        row = self._conn().execute("SELECT * FROM admin_users WHERE username=?", (username,)).fetchone()
        return dict(row) if row else None

    def upsert_admin(self, username: str, password_hash: str, must_change: bool, role: Optional[str] = None) -> None:
        """Create or update an account. ``role`` is 'admin' (default for new rows) or 'user'; None keeps an existing role."""
        conn = self._conn()
        if conn.execute("SELECT 1 FROM admin_users WHERE username=?", (username,)).fetchone():
            conn.execute("UPDATE admin_users SET password_hash=?, must_change_password=? WHERE username=?", (password_hash, int(must_change), username))
            if role:
                conn.execute("UPDATE admin_users SET role=? WHERE username=?", (role, username))
        else:
            conn.execute("INSERT INTO admin_users(username,password_hash,must_change_password,created_at,role) VALUES (?,?,?,?,?)", (username, password_hash, int(must_change), time.time(), role or "admin"))

    def touch_admin_login(self, username: str) -> None:
        self._conn().execute("UPDATE admin_users SET last_login_at=? WHERE username=?", (time.time(), username))

    def delete_admin(self, username: str) -> bool:
        cur = self._conn().execute("DELETE FROM admin_users WHERE username=?", (username,))
        return cur.rowcount > 0

    # ---- api tokens
    def create_token(self, name: str, token_plain: str, scopes: str, created_by: str) -> dict:
        tid = "tok_" + uuid.uuid4().hex[:12]
        self._conn().execute(
            "INSERT INTO api_tokens(id,name,token_hash,scopes,created_at,created_by) VALUES (?,?,?,?,?,?)",
            (tid, name, sha256(token_plain), scopes, time.time(), created_by),
        )
        return self.get_token(tid)  # type: ignore[return-value]

    def get_token(self, tid: str) -> Optional[dict]:
        row = self._conn().execute("SELECT id,name,scopes,created_at,created_by,last_used_at,revoked_at FROM api_tokens WHERE id=?", (tid,)).fetchone()
        return dict(row) if row else None

    def list_tokens(self) -> list[dict]:
        return [dict(r) for r in self._conn().execute("SELECT id,name,scopes,created_at,created_by,last_used_at,revoked_at FROM api_tokens ORDER BY created_at DESC").fetchall()]

    def lookup_token(self, token_plain: str) -> Optional[dict]:
        row = self._conn().execute("SELECT id,name,scopes,revoked_at FROM api_tokens WHERE token_hash=?", (sha256(token_plain),)).fetchone()
        if not row or row["revoked_at"]:
            return None
        self._conn().execute("UPDATE api_tokens SET last_used_at=? WHERE id=?", (time.time(), row["id"]))
        return dict(row)

    def revoke_token(self, tid: str) -> bool:
        cur = self._conn().execute("UPDATE api_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL", (time.time(), tid))
        return cur.rowcount > 0

    # ---- events (admin/system log)
    def event(self, level: str, category: str, message: str, details: Optional[dict] = None, actor: str = "") -> None:
        try:
            self._conn().execute(
                "INSERT INTO events(ts,level,category,message,details,actor) VALUES (?,?,?,?,?,?)",
                (time.time(), level, category, message, json.dumps(details or {}, ensure_ascii=False, default=str)[:8000], actor),
            )
        except Exception:
            pass

    def list_events(self, category: str = "", level: str = "", before: Optional[int] = None, limit: int = 100) -> list[dict]:
        sql = "SELECT * FROM events WHERE 1=1"
        args: list[Any] = []
        if category:
            sql += " AND category=?"
            args.append(category)
        if level:
            sql += " AND level=?"
            args.append(level)
        if before:
            sql += " AND id<?"
            args.append(before)
        sql += " ORDER BY id DESC LIMIT ?"
        args.append(limit)
        out = []
        for r in self._conn().execute(sql, args).fetchall():
            d = dict(r)
            try:
                d["details"] = json.loads(d["details"])
            except Exception:
                pass
            out.append(d)
        return out

    # ---- settings kv
    def get_setting(self, key: str, default: Any = None) -> Any:
        row = self._conn().execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        if not row:
            return default
        try:
            return json.loads(row["value"])
        except Exception:
            return default

    def set_setting(self, key: str, value: Any) -> None:
        self._conn().execute("INSERT INTO settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", (key, json.dumps(value, ensure_ascii=False), time.time()))

    def all_settings(self) -> dict:
        out = {}
        for r in self._conn().execute("SELECT key, value FROM settings").fetchall():
            try:
                out[r["key"]] = json.loads(r["value"])
            except Exception:
                pass
        return out

    # ---- stats (admin dashboard)
    def stats(self, since: float) -> dict:
        c = self._conn()
        msgs = c.execute("SELECT role, COUNT(*) AS n FROM messages WHERE created_at>=? GROUP BY role", (since,)).fetchall()
        by_role = {r["role"]: r["n"] for r in msgs}
        tools = c.execute("SELECT COUNT(*) AS n, SUM(is_error) AS errors, SUM(CASE WHEN decision='deny' THEN 1 ELSE 0 END) AS denied, SUM(CASE WHEN decision='block' THEN 1 ELSE 0 END) AS blocked, AVG(duration_ms) AS avg_ms FROM tool_audit WHERE ts>=?", (since,)).fetchone()
        convs = c.execute("SELECT COUNT(*) FROM conversations WHERE created_at>=?", (since,)).fetchone()[0]
        errors = c.execute("SELECT COUNT(*) FROM messages WHERE created_at>=? AND role='assistant' AND content LIKE '%\"error\": true%'", (since,)).fetchone()[0]
        return {
            "user_messages": by_role.get("user", 0),
            "assistant_messages": by_role.get("assistant", 0),
            "tool_calls": tools["n"] or 0,
            "tool_errors": tools["errors"] or 0,
            "tool_denied": tools["denied"] or 0,
            "tool_blocked": tools["blocked"] or 0,
            "tool_avg_ms": int(tools["avg_ms"] or 0),
            "new_conversations": convs,
            "turn_errors": errors,
        }

    def hourly(self, hours: int = 24) -> list[dict]:
        now = time.time()
        start = now - hours * 3600
        c = self._conn()
        buckets = [{"hour": int((start + i * 3600) // 3600 * 3600), "messages": 0, "tool_calls": 0, "errors": 0} for i in range(hours)]
        for r in c.execute("SELECT created_at FROM messages WHERE created_at>=? AND role='user'", (start,)).fetchall():
            i = int((r["created_at"] - start) // 3600)
            if 0 <= i < hours:
                buckets[i]["messages"] += 1
        for r in c.execute("SELECT ts, is_error FROM tool_audit WHERE ts>=?", (start,)).fetchall():
            i = int((r["ts"] - start) // 3600)
            if 0 <= i < hours:
                buckets[i]["tool_calls"] += 1
                buckets[i]["errors"] += int(r["is_error"])
        return buckets

    def top_tools(self, since: float, limit: int = 10) -> list[dict]:
        rows = self._conn().execute("SELECT tool, COUNT(*) AS n, SUM(is_error) AS errors FROM tool_audit WHERE ts>=? GROUP BY tool ORDER BY n DESC LIMIT ?", (since, limit)).fetchall()
        return [dict(r) for r in rows]

    def usage_by_model(self, since: float, limit: int = 10) -> list[dict]:
        rows = self._conn().execute("SELECT content FROM messages WHERE created_at>=? AND role='assistant'", (since,)).fetchall()
        agg: dict[str, dict] = {}
        for r in rows:
            try:
                meta = json.loads(r["content"]).get("meta") or {}
            except Exception:
                continue
            key = f"{meta.get('provider', '?')} / {meta.get('model', '?')}"
            a = agg.setdefault(key, {"key": key, "turns": 0, "input_tokens": 0, "output_tokens": 0})
            a["turns"] += 1
            u = meta.get("usage") or {}
            a["input_tokens"] += int(u.get("input_tokens", 0) or 0)
            a["output_tokens"] += int(u.get("output_tokens", 0) or 0)
        return sorted(agg.values(), key=lambda x: -x["turns"])[:limit]

    def totals(self) -> dict:
        c = self._conn()
        return {
            "conversations": c.execute("SELECT COUNT(*) FROM conversations").fetchone()[0],
            "messages": c.execute("SELECT COUNT(*) FROM messages").fetchone()[0],
            "tool_calls": c.execute("SELECT COUNT(*) FROM tool_audit").fetchone()[0],
            "events": c.execute("SELECT COUNT(*) FROM events").fetchone()[0],
        }

    # ---- retention
    def prune(self, conversation_days: int = 0, event_days: int = 365, audit_days: int = 365) -> dict:
        c = self._conn()
        now = time.time()
        out = {"conversations": 0, "events": 0, "audit": 0}
        if conversation_days and conversation_days > 0:
            cutoff = now - conversation_days * 86400
            ids = [r["id"] for r in c.execute("SELECT id FROM conversations WHERE updated_at<?", (cutoff,)).fetchall()]
            for cid in ids:
                self.delete_conversation(cid)
            out["conversations"] = len(ids)
        if event_days and event_days > 0:
            out["events"] = c.execute("DELETE FROM events WHERE ts<?", (now - event_days * 86400,)).rowcount
        if audit_days and audit_days > 0:
            out["audit"] = c.execute("DELETE FROM tool_audit WHERE ts<?", (now - audit_days * 86400,)).rowcount
        return out

    def vacuum(self) -> None:
        self._conn().execute("VACUUM")

    def db_size(self) -> int:
        total = 0
        for suffix in ("", "-wal", "-shm"):
            p = Path(str(self.path) + suffix)
            if p.exists():
                total += p.stat().st_size
        return total
