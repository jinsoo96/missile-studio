"""SQLite persistence (stdlib sqlite3, WAL).

Tables: conversations, messages, tool_audit, admin_users, api_tokens, events, settings.
"""

from __future__ import annotations

import hashlib
import json
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
        """Add columns introduced after 0.1 (branching, styles, account roles). Idempotent."""
        acols = {r[1] for r in conn.execute("PRAGMA table_info(admin_users)").fetchall()}
        if acols and "role" not in acols:
            conn.execute("ALTER TABLE admin_users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'")  # admin | user (sign-ups)
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
