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
- `probe.py`: turns a pasted endpoint into `(kind, base_url)` candidates. Request paths
  (`/chat/completions`, `/v1/messages`, `/models` …) are cut off, a bare host is tried with `/v1`
  first, and Anthropic or Gemini hosts pick their own adapter. `POST /api/providers/probe` keeps the
  first candidate that lists models and returns every attempt, so a failure says what was tried.

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
A chat's permission mode (Ask / Allow all / Read-only) is applied on top: Allow all skips the `ask`
pause (blocked tools and dangerous shell commands still stop), Read-only offers read-only tools only.

## Harness: small models and long runs

The same loop serves a hosted frontier model and a 16k-context model on a rented GPU, so it carries
the guard rails a weaker model needs:

- **Throughput and failures.** Tool calls of one turn run concurrently (4 at a time; approvals still
  one by one). Provider errors before any output (429, 5xx, connection) are retried with backoff.
  Anthropic requests cache the system prompt and tool list and replay thinking blocks with their
  signatures, so extended thinking survives tool loops.
- **Tools without a tool parser.** A server that rejects tool definitions (vLLM without
  `--enable-auto-tool-choice`) is switched to tool calls through the prompt: tools are described in the
  system prompt and `<tool_call>{…}</tool_call>` blocks are read from the text.
- **Many tools, small windows.** Above 24 tools (configurable) the model gets a one-line catalog and
  loads what it needs with `local__load_tools`; loaded tools stay for the conversation. Token counts are
  estimated (Korean-aware), tool results are capped for the model, older results and images are shortened
  before each request, a long tool loop inside one turn is folded into a one-line log of its earlier
  steps, and a context-length 400 is answered by trimming harder and sending again. Long threads are
  compacted by the model into a summary that replaces the old part; the recent tail stays verbatim.
- **Steering a stuck turn.** A turn that repeats the same tool call is nudged to wait (`job_wait`) or
  conclude; one that reaches the tool-call limit ends with a forced plain-text answer. A tool call the
  model writes as text (untagged, unreadable, or cut off at the output limit) is reported and the model
  is asked, at most twice, to send it properly; arguments that arrive as unreadable JSON never run the
  tool. An answer that stops mid-sentence while tools are in play is continued once.
- **Why it ended.** Every answer keeps the server's finish reason, its stop reason and its output tokens;
  the UI shows them on hover and flags an answer that did not end normally.

Notes to the model (the nudges above) are stored as user-role messages marked `meta.note`: the
conversation stays valid for every provider, and the UI draws them as a quiet line, not a bubble.

## Per-chat settings and the prompt library

`conversations.settings` holds a chat's own instructions, temperature and max output tokens (cleaned on
the server). The engine appends the instructions after the assistant prompt, marked as taking priority,
and lets the two numbers override the assistant's. Saved prompts live in `config.prompts`; the composer
inserts one with `/name` and asks for each `{{blank}}` first.

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
(masked); sending the masked placeholder back keeps the stored secret. Columns added after the first
release (`head_id`, `style_id`, `pinned`, `settings` …) are added on start when missing, so an existing
database upgrades in place. `tool_audit` is read a page at a time (`/api/audit/page`, filters and a total)
and exported as CSV (`/api/audit/export`).

## Interface language

Screens are written in English and every visible string goes through `T('…')`, which looks the text up in
`static/i18n.js` (Korean) and fills `{name}` slots. Static HTML uses `data-i18n` attributes. The choice is
kept per browser and defaults to the browser's language; dates follow it too. `tests/test_i18n.py` fails
when a string passed to `T()` has no Korean entry.

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

**Studio users.** Accounts with role `user` (sign-ups, accounts made as users) and `chat` tokens are
studio users. `conversations.owner` is `''` for the admins' chats (every chat from before owners
existed) and the user's name otherwise; a user lists, opens, searches, audits and answers approvals
only in their own chats, and anyone else's chat answers 404. Their turns carry
`TurnRequest.user_tools` (admin setting `user_tools`: `none` / `web` / `read-only`, default `web`):
`Engine.user_may` decides which tools are offered and `decide()` refuses the rest, always in read-only
mode, so the local shell, file tools and `fetch_url`, the memories and the knowledge base never reach a
user's chat (memory recall and knowledge excerpts are skipped too). The workspace, memory, knowledge
and MCP export routes are admin-only, and `/api/state` lists only the tools the principal can use.
For a user, `/api/state`, `/api/providers`, `/api/mcp`, `/api/policy`, `/api/wake` and `/api/bridge`
return a trimmed view (allowed providers and models without addresses or keys, MCP servers by name
only and only at `read-only`, no paths); `/api/health` shows the data folder to admins only. The chat
route picks a user's model itself (`user_targets` / `pick_user_target`: their pick when the admin's
`user_models` allows it, else the first allowed one, skipping providers the health probe marks down)
and refuses a turn past `user_daily_turns`, `user_concurrent_turns` or `user_storage_mb`. A user's
image uploads are not written to the workspace.

**Sessions.** The session JWT carries `t` (issue time with fractions). An account row with
`disabled = 1`, or whose `sessions_after` is later than `t` (set by a password change, an admin reset or
*sign out everywhere*), is no session. Forwarded-IP headers count for the login limit only when the
peer is on this machine (a tunnel or reverse proxy), so a direct client cannot rotate them.

**Backups.** `admin.backup_loop` checks every 10 minutes and, when the newest backup is older than
`backup_interval_hours`, runs `run_backup`: `Store.backup_to` (SQLite online backup) plus `config.json`
and `secret.key` into a dated folder, pruning to `backup_keep`. The last result is kept in the settings
table (`backup_last`) for the dashboard warning and the System page.

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
- Everything a tool did is in the audit log (`/api/audit/page`, Settings → Audit log).
