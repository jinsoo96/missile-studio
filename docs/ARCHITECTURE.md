# Architecture

One engine, three surfaces (web, terminal, MCP hub/bridge). No framework: `httpx` for providers,
the official `mcp` SDK (2.x) for MCP, FastAPI for the API, stdlib `sqlite3` for storage, vanilla JS for the UI.

## Canonical message / event vocabulary

Providers translate **to and from one message shape** (OpenAI-like roles with `tool_calls` as
`{id, name, arguments: dict}` and `role: tool` results). They emit one **event vocabulary** while
streaming: `text_delta`, `thinking_delta`, `tool_call` (complete call, emitted once), `usage`,
`done {finish_reason}`, `error`. The engine adds `approval_required`, `tool_result`, `message`,
`status`, `remote_tool`. The web UI and the terminal render the same events; the API streams them
as `data:` frames over SSE.

Why: one vocabulary keeps every surface identical and makes adding a provider a one-file job.

## Provider adapters

- `openai_compat.py`: `/chat/completions` streaming; accumulates tool-call argument deltas by index;
  `reasoning_content` → `thinking_delta`; retries once without `stream_options` for strict servers;
  model discovery via `/models` with an Ollama `/api/tags` fallback. Quirk handled in the engine:
  Ollama output cap (`num_predict` 128) by setting `max_tokens=8192` when none is given.
- `anthropic.py`: Messages API; folds consecutive same-role turns, `tool_result` as user blocks,
  images as base64 blocks, `thinking_delta` from thinking blocks.
- `gemini.py`: `streamGenerateContent?alt=sse`; strips JSON-schema keywords Gemini rejects;
  groups `functionResponse` parts; `thought` parts → thinking.
- `agentserver.py`: remote agent servers (see GUIDE-agent-server.md). The "model" is an agent id.

## MCP manager

One asyncio task per server owns the transport + `ClientSession` context (anyio cancel scopes must be
entered and exited by the same task). Other tasks call `session.call_tool` on the shared session.
Keepalive ping every 15 s; failures mark the server `failed` and retry with backoff; a failing server
never affects the others; `tools/list_changed` refreshes the catalog; stdio stderr goes to
`logs/mcp-<name>.log`. Names are `<server>__<tool>`; annotations are kept for policy
(`read_only`, `destructive`).

## Engine (agent loop)

```
history + user message
  → provider.stream(messages, tools)       (text / thinking / tool_call events)
  → for each tool_call: policy.decide → allow | ask (await human) | block
      → execute (local or MCP) with timeout → audit row → role:tool message
  → loop until no tool calls, error, or max_iterations
```

Policy order: per-conversation session allow → dangerous shell pattern (always ask) → explicit rule
(exact or glob) → read-only default → default. Decisions and results are persisted
(`messages`, `tool_audit`) as they happen, so a refresh mid-turn loses nothing.

Approvals are futures keyed by call id. The web UI resolves them through `POST /api/approvals/{id}`;
the terminal resolves them inline; non-interactive `missile ask` denies. Timeout 10 minutes → deny.

## Local tools

Sandboxed to the workspace folder with a realpath containment check (symlinks resolved), shell runs
through PowerShell (Windows) or `$SHELL -lc`, output truncated, `[exit N]` appended. The dangerous
command list (`rm -rf`, `Remove-Item -Recurse`, `format`, `dd`, `git push --force`, `curl | sh`,
`kubectl delete`, ...) forces an approval even when the tool is allowed.

## Hub and bridge

- Hub: a `MCPServer` subclass whose `list_tools`/`call_tool` proxy to the engine; stdio or
  Streamable HTTP. Ask-level tools are refused unless `--trust`.
- Bridge: the agent server's device WebSocket over `websockets`; catalog = engine tools; per-call deadline
  from the server (`deadline_ms` − 1 s) or 130 s; results in MCP `CallToolResult` shape.

## Storage and config

`config.json` (pydantic models in `config.py`) and `studio.db` (WAL) under `MISSILE_HOME`.
Provider secrets may be referenced by env var name (`api_key_env`). The UI never receives raw keys
(masked); sending the masked placeholder back keeps the stored secret.

## Concurrent turns, split panes, workspace drawer

The server already runs one task per conversation turn (`turn_tasks`), so any number of chats can
stream at once; `/api/conversations` reports `running` per chat. The web UI keeps one live stream
object per conversation (`S.live[convId]`) that owns its DOM nodes, so switching chats or re-rendering
never interrupts a stream, and a pane re-attaches the live node when it shows that conversation again.
Panes are independent (own conversation, model, assistant, tools switch); *link inputs* fans one
message out to every pane. The workspace drawer talks to `/api/workspace/*` (tree, read, write,
delete, run), all resolved through the same sandbox as the local tools; writes and commands need the
admin role and are recorded (events / tool audit as `workspace__run`, decision `human`).

## Auth and the admin console

Three principals: the **owner token** (`server.token`, admin), **API tokens** from the admin console
(scope `chat` or `admin`, SHA-256 stored, revocable, last-used tracked) and **admin sessions**
(username + PBKDF2 password, HS256 cookie, 12 h, CSRF header on mutations, login rate limit per IP).
A loopback bind without a token trusts the local user as admin. Settings-changing routes need the
admin role; chat routes need any principal; maintenance mode turns chat off for non-admins.

The admin console (`server/admin.py`, `static/admin.*`) adds a typed settings registry (kind, group,
choices, min/max; keys backed either by `config.json` or by the `settings` table), dashboard stats
computed from `messages` / `tool_audit`, warnings as codes the UI turns into fix-it links, an `events`
table every admin action writes to (secrets redacted), system info, log tails and a 6-hourly retention
loop. Static assets are served with `Cache-Control: no-cache` and versioned query strings so UI updates
land without a hard reload.

## Security posture

- Non-loopback bind requires a token (auto-generated).
- Local tools cannot leave the workspace; shell asks on dangerous commands.
- Hub/bridge never auto-approve `ask` tools without `--trust`.
- Everything a tool did is in `/api/audit` and the Audit tab.
