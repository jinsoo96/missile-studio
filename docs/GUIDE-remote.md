# Remote use: SSH, Tailscale, Cloudflare Tunnel, Docker, services

missile-studio is one Python process. Wherever it runs, the web UI, the terminal UI and the API
share the same `~/.missile-studio` (or `MISSILE_HOME`), so you can switch between them freely.

## 1. Authentication

- Bound to `127.0.0.1` (default): no token, anyone on the machine can use it.
- Bound to anything else (`--host 0.0.0.0`, a LAN or Tailscale address): a token is **required**.
  If you do not pass one, `missile serve` generates it, stores it in `config.json` (`server.token`)
  and prints the URL with `?token=...`. Set it explicitly with `--token`, `MISSILE_TOKEN` or
  `missile config set-token <value>`.
- The browser keeps the token in `localStorage` after the first visit; API clients send
  `Authorization: Bearer <token>`.

## 2. SSH only (nothing exposed)

```bash
# server
missile serve                              # 127.0.0.1:7700
# laptop
ssh -N -L 7700:127.0.0.1:7700 user@server  # then open http://127.0.0.1:7700
ssh -t user@server missile chat            # terminal UI over SSH (approvals are answered inline)
ssh user@server 'missile ask --json "list files with local__list_dir"'
```

Terminal tips: `missile chat --raw` streams raw text instead of re-rendering markdown (better on slow
links); `/model <provider> [model]`, `/tools`, `/mcp`, `/new` inside the chat.

## 3. Tailscale / LAN

```bash
missile serve --host 0.0.0.0 --port 7700 --token "$(openssl rand -hex 16)"
# open http://<tailscale-ip>:7700/?token=...
```

## 4. Cloudflare Tunnel (public URL, PC stays closed)

1. Run missile on the server (`--host 127.0.0.1` is enough; the tunnel connects locally).
2. Create a tunnel (`cloudflared tunnel create missile`) and route `missile.example.com` to
   `http://localhost:7700`.
3. **Put Cloudflare Access (Zero Trust) in front of the hostname** with an e-mail / OTP policy.
   missile's token is a second factor, not a replacement for Access on a public hostname.

## 5. Docker

```bash
docker run -d --name missile --restart unless-stopped \
  -p 7700:7700 -v missile-data:/data -e MISSILE_TOKEN=change-me \
  --add-host host.docker.internal:host-gateway \
  ghcr.io/jinsoo96/missile-studio:latest
```

- Config and the SQLite DB live in the `/data` volume.
- Reach Ollama / vLLM / LM Studio on the host as `http://host.docker.internal:11434/v1`.
- The image ships Node 22 so `npx -y <mcp-server>` stdio servers work inside the container.
- `docker compose up -d` with the provided `docker-compose.yml` does the same.

## 6. Run as a service

**Linux (systemd)**: `scripts/missile-studio.service` is a template unit
(`systemctl enable --now missile-studio@<user>` after copying it to `/etc/systemd/system/missile-studio@.service`).

**Windows (Task Scheduler, starts at boot without login)**:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\register-task.ps1 `
  -MissileExe "C:\Users\me\.local\bin\missile.exe" -BindHost 0.0.0.0 -Port 7700
```

The task runs `scripts\windows\missile-serve.cmd` as an S4U principal with restart-on-failure and
logs to `%USERPROFILE%\.missile-studio\logs\serve.log`.

**macOS (launchd)**: a `~/Library/LaunchAgents/com.missile.studio.plist` with
`ProgramArguments = [/path/to/missile, serve]` and `KeepAlive = true`.

## 7. Several machines, one studio

- Keep the studio on the always-on box; use everything else as a client (browser, SSH, `missile hub`).
- To let **another MCP client** (Claude Code, Cursor, Claude Desktop) use this studio's tools, add a stdio server
  `missile hub` on that client, or run `missile hub --http --host 0.0.0.0 --port 7701` and point the client at
  `http://server:7701/mcp`.
- To let **remote agents** use this machine, run `missile bridge --provider <agent-server-provider>`
  (see GUIDE-agent-server.md).

## 8. Troubleshooting

| symptom | check |
|---|---|
| 401 in the browser | token mismatch: open `/?token=<value>` once, or clear `localStorage` |
| Login screen on every visit | sign in with an admin username / password and leave *Stay signed in* on (30-day cookie). Set the password with `ms admin reset-password admin --password …`. The token field is under *Use an access token instead*. |
| provider test fails | `missile provider test <id>`; for Ollama/vLLM confirm `/v1/models` responds from the server itself |
| MCP server `failed` | `missile mcp test <name>`; stderr is in `~/.missile-studio/logs/mcp-<name>.log`; on Windows `npx` needs Node in PATH of the service user |
| tools never run, always "requires approval" in hub/bridge | add allow rules (`missile policy set <tool> allow`) or start with `--trust` |
| slow first token on self-hosted Qwen | add `{"chat_template_kwargs": {"enable_thinking": false}}` as the provider's extra body |
