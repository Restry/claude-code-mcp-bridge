# claude-code-mcp-bridge

Wrap the local **Claude Code CLI** (`claude`) as an **MCP server** over stdio.
Any MCP client — Cursor, Claude Desktop, Hermes, your own agent — can spawn
Claude Code tasks, poll them, stream their output, and cancel them through six
plain tools.

The key idea is the **async task model**: `claude_run` returns immediately with
a `task_id` instead of blocking until Claude finishes. A long task (a multi-file
refactor, a test run, a build) keeps streaming in the background while your MCP
client stays responsive. You poll with `claude_status`, stream chunk-by-chunk
with `claude_wait`, and `claude_cancel` when you want to stop.

> Forked from the MCP server inside `lark-channel-bridge`, with all the
> Feishu / Lark messenger code stripped out. This package is the MCP server,
> nothing else.

## Install & run

```bash
npm install
npm run build
node bin/claude-code-mcp-bridge.mjs mcp
```

Or, once published:

```bash
npx claude-code-mcp-bridge mcp
```

## HTTP mode (shared, long-lived daemon)

`mcp` (stdio) is one-process-per-client. For a single long-lived server that
**every** MCP client shares — and a status page — use `serve`:

```bash
node bin/claude-code-mcp-bridge.mjs serve --port 8787 --cwd-root ~/projects
```

- MCP endpoint (Streamable HTTP): `http://127.0.0.1:8787/mcp`. Point any client's
  `mcpServers` at it with `{ "type": "streamable-http", "url": "http://127.0.0.1:8787/mcp" }`.
- All MCP sessions share **one** task registry and **one** session store, so
  `claude_list` / `claude_sessions` are globally visible across clients.
- Dashboard: open `http://127.0.0.1:8787/` — a brief usage intro plus a live
  panel of sessions / tasks / in-progress status (polls `GET /api/state`).
- `GET /api/state` returns that state as JSON; `GET /healthz` is a liveness probe.

Run it as a system-managed daemon (macOS launchd) so it's not started by any
client — see [`deploy/com.restry.claude-code-mcp-bridge.plist`](deploy/com.restry.claude-code-mcp-bridge.plist)
(edit paths, copy to `~/Library/LaunchAgents/`, `launchctl load -w ...`).

The `claude` CLI must be installed and on `PATH` (the adapter spawns
`claude --version` to check availability and `claude -p ... --output-format
stream-json` to run tasks).

### CLI flags

```
claude-code-mcp-bridge mcp [options]

  --cwd <path>        Default working directory when a caller omits one.
  --cwd-root <path>   Restrict task cwds to this root. Repeatable.
                      Defaults to ~/Projects.
```

## MCP client config

Point your MCP client at the stdio server. Example (Claude Desktop /
Cursor `mcpServers` block):

```json
{
  "mcpServers": {
    "claude-code": {
      "command": "npx",
      "args": ["claude-code-mcp-bridge", "mcp", "--cwd-root", "/Users/me/Projects"]
    }
  }
}
```

For a real, working client integration (HTTP transport, background dispatch,
Feishu reply-in-thread notifications), see [`clients/pi-mcp-claude/`](clients/README.md).

## The six tools

| Tool | Signature | What it does |
| --- | --- | --- |
| `claude_run` | `(prompt, cwd?, model?, session_id?, notify_target?)` | Start a Claude task async. Returns a snapshot with `task_id`. |
| `claude_status` | `(task_id)` | Snapshot: status, accumulated text, counters, in-flight tool. |
| `claude_wait` | `(task_id, from_seq?, timeout_ms?)` | Block briefly for new events after `from_seq`; returns immediately on terminal state. |
| `claude_cancel` | `(task_id)` | SIGTERM (then SIGKILL) a running task and mark it cancelled. |
| `claude_list` | `()` | List all known tasks in this server (running and terminal). |
| `claude_forget` | `(task_id)` | Drop a finished task from memory. No-op while running. |

### Argument detail

- **`claude_run`**
  - `prompt` (string, required) — the prompt to send to Claude.
  - `cwd` (string, optional) — working directory; defaults to `--cwd`, then the
    server's own cwd. Subject to the cwd-root whitelist (below).
  - `model` (string, optional) — override the Claude model (e.g. `claude-opus-4-8`).
  - `session_id` (string, optional) — resume a prior Claude session by its id
    (returned from a previous run). Resume is always by explicit id (`--resume`),
    never `-c`, so concurrent tasks sharing a cwd never cross-talk.
  - `notify_target` (object, optional) — fire a one-shot notification when the
    task reaches a terminal state (`done` / `error` / `cancelled`). See below.

### Feishu notifications (`notify_target`)

When a caller (e.g. an orchestrator that dispatched the task) wants to be told
the moment a task finishes — instead of polling `claude_wait` — it passes a
`notify_target`. On terminal state the bridge spawns the local `lark-cli`
(resolved from `$PATH`, or `$LARK_CLI_BIN`) once with a Markdown summary. It is
strictly fire-and-forget: a broken or missing `lark-cli` is logged to stderr and
never crashes the server or blocks task cleanup. The existing four-field
behaviour is unchanged when `notify_target` is omitted.

`notify_target` fields (only `type` is required):

| Field | Type | Meaning |
| --- | --- | --- |
| `type` | `"feishu"` | Required. Only `feishu` is supported today. |
| `chat_id` | string (`oc_…`) | Send to the main chat stream. Used when not replying into a thread. |
| `anchor_msg_id` | string (`om_…`) | A message id anywhere in the target thread. **Required to land inside a thread** — the Feishu API can only reply-to-message, not send-to-thread. |
| `reply_in_thread` | boolean | With `anchor_msg_id`, the notification appears inside that thread. |
| `as_identity` | `"bot"` \| `"user"` | `lark-cli --as` flag. Defaults to `bot`. |
| `notify_on_start` | boolean | Also fire immediately after spawn (a "派出了" pin). Default `false`. |

Routing: an end notification uses `+messages-reply --reply-in-thread` when both
`reply_in_thread` and `anchor_msg_id` are present; otherwise it falls back to
`+messages-send --chat-id`. If neither a thread anchor nor a `chat_id` resolves,
nothing is sent (logged as a warning).

Example — reply into a thread when the task completes:

```jsonc
{
  "prompt": "refactor the auth module",
  "cwd": "/Users/me/Projects/app",
  "notify_target": {
    "type": "feishu",
    "anchor_msg_id": "om_xxxxxxxxxxxxxxxx",
    "reply_in_thread": true,
    "notify_on_start": true
  }
}
```

- **`claude_wait`** — `from_seq` (default `0`) is an event cursor. Each event has
  a monotonic `seq`; pass the highest `seq` you've seen back as `from_seq` on the
  next call to stream progress chunk-by-chunk. `timeout_ms` defaults to `30000`
  (clamped 100–120000).

### Streaming pattern

```
run  -> { task_id }
wait(task_id, from_seq=0)   -> events [seq 0..n], snapshot
wait(task_id, from_seq=n)   -> events [seq n+1..], snapshot
...repeat until snapshot.status != "running"...
```

## cwd whitelist

`--cwd-root` (repeatable, default `~/Projects`) restricts where tasks may run.
On every `claude_run`, the requested `cwd` is resolved with `path.resolve` (so
`/root/../etc` can't sneak out) and must equal, or sit under, one of the roots.
A cwd outside every root is rejected before Claude is ever spawned. Pass
multiple `--cwd-root` flags to allow several trees.

## Lifecycle & persistence boundary

Task state lives entirely in memory, scoped to one stdio connection. When the
server process exits, every task record is gone; a second client connection
gets a fresh, empty registry. There is no cross-process or cross-restart
visibility — this is a session-scoped scheduler, not a durable queue.

## Why not the official Claude Code MCP?

Anthropic ships an official `claude-code` MCP integration, but it follows a
synchronous request/response shape: the call blocks until Claude is done. That
is fine for short prompts and awkward for long ones — a 5-minute refactor pins
your client for 5 minutes.

This bridge is built around an **async task model** instead: `claude_run`
returns a `task_id` instantly and the work continues in the background. Your
client streams progress with `claude_wait`, checks in with `claude_status`,
runs several tasks concurrently, and cancels mid-flight — none of which blocks
the client. If you want fire-and-forget long-running Claude Code tasks behind
MCP, that's what this is for.

## License

MIT
