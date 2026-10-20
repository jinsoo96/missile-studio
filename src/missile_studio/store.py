"""SQLite persistence (stdlib sqlite3, WAL). Conversations, messages, tool audit log."""

from __future__ import annotations

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
"""


class Store:
    def __init__(self, path: Optional[Path] = None):
        self.path = path or db_path()
        self._local = threading.local()
        with self._conn() as c:
            c.executescript(SCHEMA)

    def _conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(str(self.path), check_same_thread=False, isolation_level=None)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA foreign_keys=ON")
            self._local.conn = conn
        return conn

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

    def list_conversations(self, limit: int = 200) -> list[dict]:
        rows = self._conn().execute("SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?", (limit,)).fetchall()
        return [dict(r) for r in rows]

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
    def append_message(self, cid: str, message: dict) -> str:
        conn = self._conn()
        seq = conn.execute("SELECT COALESCE(MAX(seq),0)+1 FROM messages WHERE conversation_id=?", (cid,)).fetchone()[0]
        mid = message.get("id") or uuid.uuid4().hex[:16]
        body = {k: v for k, v in message.items() if k != "id"}
        conn.execute(
            "INSERT INTO messages(id,conversation_id,seq,role,content,created_at) VALUES (?,?,?,?,?,?)",
            (mid, cid, seq, message.get("role", "user"), json.dumps(body, ensure_ascii=False), time.time()),
        )
        conn.execute("UPDATE conversations SET updated_at=? WHERE id=?", (time.time(), cid))
        return mid

    def get_messages(self, cid: str) -> list[dict]:
        rows = self._conn().execute(
            "SELECT id, content FROM messages WHERE conversation_id=? ORDER BY seq", (cid,)
        ).fetchall()
        out = []
        for r in rows:
            m = json.loads(r["content"])
            m["id"] = r["id"]
            out.append(m)
        return out

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
