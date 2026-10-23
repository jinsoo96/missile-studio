"""Per-chat settings reach the model; chats can be pinned and renamed without moving; saved prompts; message times."""

from __future__ import annotations

from .test_api import H, client, read_sse  # noqa: F401  (fixture)
from .test_mcp_and_engine import FakeProvider


def _answer(text="ok"):
    return [[{"type": "text_delta", "text": text}, {"type": "done", "finish_reason": "stop"}]]


def test_chat_settings_are_cleaned_and_reach_the_model(client):
    conv = client.post("/api/conversations", json={}, headers=H).json()
    r = client.patch(f"/api/conversations/{conv['id']}", json={"settings": {"instructions": "  Answer in Korean.  ", "temperature": "5", "max_tokens": "300", "junk": 1}}, headers=H).json()
    assert r["settings"] == {"instructions": "Answer in Korean.", "temperature": 2.0, "max_tokens": 300}
    FakeProvider.seen.clear(); FakeProvider.options_seen.clear(); FakeProvider.script = _answer()
    with client.stream("POST", "/api/chat", json={"conversation_id": conv["id"], "text": "hi", "tools": "none"}, headers=H) as s:
        read_sse(s)
    system = FakeProvider.seen[-1][0]["content"]
    assert "Instructions for this chat" in system and "Answer in Korean." in system
    opts = FakeProvider.options_seen[-1]
    assert opts.temperature == 2.0 and opts.max_tokens == 300
    # clearing returns to the assistant's defaults
    assert client.patch(f"/api/conversations/{conv['id']}", json={"settings": {}}, headers=H).json()["settings"] == {}


def test_pin_and_rename_keep_the_chat_in_place(client):
    a = client.post("/api/conversations", json={"title": "a"}, headers=H).json()
    b = client.post("/api/conversations", json={"title": "b"}, headers=H).json()
    before = {c["id"]: c["updated_at"] for c in client.get("/api/conversations", headers=H).json()}
    client.patch(f"/api/conversations/{a['id']}", json={"pinned": True}, headers=H)
    client.patch(f"/api/conversations/{a['id']}", json={"title": "renamed"}, headers=H)
    convs = client.get("/api/conversations", headers=H).json()
    assert convs[0]["id"] == a["id"] and convs[0]["pinned"] > 0 and convs[0]["title"] == "renamed"
    assert convs[0]["updated_at"] == before[a["id"]]  # not bumped by the pin or the rename
    client.patch(f"/api/conversations/{a['id']}", json={"pinned": False}, headers=H)
    assert [c["id"] for c in client.get("/api/conversations", headers=H).json()][:2] == [b["id"], a["id"]]


def test_prompt_library_and_message_times(client):
    r = client.post("/api/prompts", json={"id": "sum", "name": "Summary", "text": "Summarize {{topic}}"}, headers=H)
    assert r.status_code == 200 and r.json()[0]["id"] == "sum"
    assert client.get("/api/state", headers=H).json()["prompts"][0]["text"] == "Summarize {{topic}}"
    assert client.post("/api/prompts", json={"id": "bad id!", "name": "x"}, headers=H).status_code == 400
    assert client.delete("/api/prompts/sum", headers=H).json()["ok"]
    assert client.get("/api/state", headers=H).json()["prompts"] == []
    conv = client.post("/api/conversations", json={}, headers=H).json()
    FakeProvider.script = _answer()
    with client.stream("POST", "/api/chat", json={"conversation_id": conv["id"], "text": "hi", "tools": "none"}, headers=H) as s:
        read_sse(s)
    msgs = client.get(f"/api/conversations/{conv['id']}", headers=H).json()["messages"]
    assert all(isinstance(m.get("ts"), float) for m in msgs)
