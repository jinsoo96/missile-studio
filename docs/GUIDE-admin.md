# Admin console (`/admin`)

A separate console for the person who runs the studio. It lives at `/admin` on the same server and has
its own login (username + password), so it works for a team even when the chat UI is opened with a
shared `chat`-scoped token.

## First login

`ms serve` creates the user `admin` with a generated password on first start and prints it once
(it is also in `<home>/logs/serve.log` when the server runs as a service). Sign in at `/admin`; you are
taken to **Account** until you set your own password. From a shell:

```bash
ms admin list
ms admin reset-password admin            # prints a new generated password
ms admin reset-password admin --password 'my-own-one'
ms admin add ops                         # another admin
```

Sessions are httpOnly cookies (12 h). Mutating calls made with the cookie must carry
`X-Requested-With: missile-admin`; the console does that for you, a cross-site page cannot. Login is
rate limited per IP (10/min by default). The owner API token from `config.json` and tokens with the
`admin` scope can call the same `/api/admin/*` endpoints with `Authorization: Bearer …` for scripts.

## Pages

| page | what |
|---|---|
| Dashboard | warnings with a *Go* link (generated password, no providers, provider without key, failed MCP server, public bind without token, maintenance mode), stat tiles (24 h messages, tool calls, success rate, denied/blocked, running turns, waiting approvals, uptime), 24 h chart, providers & MCP health with **Test** / **Restart**, top tools and model usage for 7 days, recent events. Refreshes every 10 s. |
| Chats | every conversation with search and paging, open to read messages and tool audit, delete. |
| Access tokens | create tokens with scope `chat` (talk, own conversations, approvals, uploads) or `admin` (everything). Shown once; revoke immediately; last-used is tracked. |
| Settings | typed registry, saved values apply immediately: studio name, maintenance mode, max upload, default provider/model, policy defaults, local tool switches, workspace, owner token rotation, login rate limit, retention days for chats / events / audit. Only changed keys are sent. Data actions: run retention now, vacuum, export config (secrets stripped). |
| Events | admin and system log (auth, settings, access, data, system) with level filter and keyset paging; click a row for details. Secrets never appear in details. |
| System | uptime, process and system memory, disk, database size, bind address, log files with a tail viewer (MCP server stderr lands here). Refreshes every 15 s. |
| Account | change password, manage admin users. |

## Retention

A background task runs every 6 hours and deletes chats idle longer than `retention_days` (0 = keep),
events older than `event_retention_days` and tool audit rows older than `audit_retention_days`.
Each run that deletes something writes a `system` event.

## Maintenance mode

While on, `/api/chat` answers 503 for everyone except admins, and the dashboard shows a warning.
