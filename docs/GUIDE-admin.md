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
| Dashboard | warnings with a *Go* link (generated password, weak admin password, no providers, provider without key, failed MCP server, public bind without token, maintenance mode, backups off or failing, a studio-user model naming a missing provider), stat tiles (24 h messages, tool calls, success rate, denied/blocked, running turns, waiting approvals, uptime), 24 h chart, providers & MCP health with **Test** / **Restart**, top tools and model usage for 7 days, turns / tokens / chats / stored size per account for 7 days, recent events. Refreshes every 10 s. |
| Chats | every conversation with search and paging (a studio user's chats carry their name), open to read messages and tool audit, delete. |
| Access tokens | create tokens with scope `chat` (a studio user: talk in its own conversations, approvals, uploads) or `admin` (everything). Shown once; revoke immediately; last-used is tracked. |
| Settings | typed registry, saved values apply immediately: studio name, maintenance mode, max upload, default provider/model, policy defaults, local tool switches, workspace, owner token rotation, login rate limit, a **Studio users** group (sign-up mode, invite code and sign-up cap, the models and tools users get, their per-user limits), retention days for chats / events / audit, backup interval / count / folder. Only changed keys are sent. Data actions: run retention now, vacuum, export config (secrets stripped). |
| Events | admin and system log (auth, settings, access, data, system) with level filter and keyset paging; click a row for details. Secrets never appear in details. |
| System | uptime, process and system memory, disk, database size, bind address, log files with a tail viewer (MCP server stderr lands here), backups with **Back up now**. Refreshes every 15 s. |
| Account | change password, manage accounts: reset a password, **Lock** / **Unlock** (a locked account cannot sign in and its open sessions stop at once), **Sign out everywhere** (ends every session, keeps the password), delete. |

## Sharing the studio (studio users)

Accounts with role `user` chat in their own conversations only. What they get is set under
Settings → Studio users:

- `user_models`: the models they may use, comma-separated, either a provider id (all of its models) or
  `provider:model`, e.g. `dashscope, anthropic:claude-haiku-5-5`. The first is the default for their new
  chats; when the one they picked is down, the next reachable one answers. Empty = only the default
  model. Their screen lists only these, without addresses, keys or headers.
- `user_tools`: `none` / `web` / `read-only` (see below). They never see MCP commands, paths or
  environment, the policy rules, this machine's paths, bridges or wake jobs.
- limits per user: `user_daily_turns` (messages in 24 h, default 100), `user_concurrent_turns`
  (answers running at once across their chats, default 2), `user_storage_mb` (what their chats take,
  attachments included, default 200). A refused message tells them which limit they hit.
- `signup_max_users`: sign-ups stop at this many user accounts (default 50); accounts you add are not
  counted against it.

Their image uploads go to the model only, not into the workspace. Each account changes its own
password under Settings → General; a password change, a reset by an admin or *Sign out everywhere*
ends that account's other sessions.

## Backups

Every `backup_interval_hours` (default 24, 0 = off) the server copies the database (SQLite online
backup, safe while it runs), `config.json` and `secret.key` into `<backup_dir>/studio-YYYYmmdd-HHMMSS/`
(`backup_dir` empty = `<MISSILE_HOME>/backups`) and keeps the newest `backup_keep` (default 7). Point
`backup_dir` at another disk to survive this one failing. To restore, stop the server and copy the
three files back into the data folder.

## Retention

A background task runs every 6 hours and deletes chats idle longer than `retention_days` (0 = keep),
events older than `event_retention_days` and tool audit rows older than `audit_retention_days`.
Each run that deletes something writes a `system` event.

## Maintenance mode

While on, `/api/chat` answers 503 for everyone except admins, and the dashboard shows a warning.
