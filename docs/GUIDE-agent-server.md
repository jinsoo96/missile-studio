# Agent servers: chat with remote agents, or lend your PC to them

Some agent platforms host agents (workflows) behind an HTTP API and can accept "devices" that
offer tools over a WebSocket. missile-studio speaks to such a platform in two directions.

## A. Chat with hosted agents (provider kind `agentserver`)

```bash
ms p add --preset agentserver --id corp --base-url https://agents.example.com \
    --email me@corp.com --password '...'
ms p models corp          # agents appear as "<id>|<name>"
ms chat -p corp -m "wf_123|My agent"
```

In the web UI: Providers → preset "Agent server" → save, then Agents tab → *List agents* →
*Chat with this agent*.

- Login is e-mail + password; the access token is refreshed automatically on 401/403.
- Each local conversation maps to one server-side interaction, so follow-up turns continue the same
  thread on the server.
- Tool execution happens on the server. missile shows the server's tool events as status lines and
  never runs local tools for an agent-server turn; that is what the bridge is for.

## B. Lend this machine to the platform's agents (device bridge)

```bash
ms bridge --provider corp            # Ctrl-C to stop
ms bridge --provider corp --trust    # also run tools whose policy says "ask"
```

Or in the web UI: Agents tab → *Start bridge*.

missile opens the platform's device WebSocket with the bearer token and sends a `hello` with the
full catalog: local tools under server `local` and every MCP server under its own name, each with
`inputSchema` and `annotations` (`readOnlyHint` / `destructiveHint` / `openWorldHint`). The server
acknowledges with `ready`, then sends `mcp_call {request_id, server, tool, args, context,
deadline_ms}`; missile replies `mcp_result {request_id, ok, result: {content, isError}}`.
`mcp_cancel` aborts a running call, a `ping` goes out every 20 s, and reconnects back off
5 s × 1.8 up to 60 s. The device shows up on the platform as `<hostname> · missile-studio`.

Safety: the policy applies. Tools that resolve to `ask` are refused with a clear message unless the
bridge runs with `--trust`; `block` is always refused; every call is in the audit log. If the
platform forgets the device after a while, toggling the bridge re-sends the catalog.

## C. Feed any MCP client from missile: the hub

```bash
ms hub                       # stdio: all local tools + all MCP servers as one server
ms hub --http --port 7701    # Streamable HTTP at http://127.0.0.1:7701/mcp
```

Standard JSON for Claude Desktop / Cursor / Cherry Studio and any client that takes `mcpServers`:

```json
{"mcpServers": {"missile": {"command": "ms", "args": ["hub"]}}}
```

Add `--trust` to the args if you want ask-level tools to run without a human; otherwise set allow
rules in missile (`ms policy set <tool> allow`).
