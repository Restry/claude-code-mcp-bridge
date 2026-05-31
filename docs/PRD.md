# PRD — `@restry/claude-code-mcp-bridge`

Status: v0.1 draft · Last updated: 2026-06-01 · Owner: Restry

## 1. Background

Anthropic ships an official Claude Code MCP integration, but it's
**synchronous** — the call blocks until Claude finishes. For a 5-minute
refactor or a multi-step build the client is pinned for the entire run,
which is unusable from an orchestrator that needs to fan out work and
keep responding to its user.

This package solves that one problem: wrap the local `claude` CLI as an
**async MCP server**. `claude_run` returns a `task_id` instantly, the
work continues in the background, and the client streams progress on
its own schedule.

Forked from the MCP server inside `lark-channel-bridge` with all the
Feishu / Lark transport code stripped out. This package is just the MCP
server.

## 2. Goals

- **G1.** Expose the local `claude` CLI as an MCP stdio server with six
  tools: `claude_run`, `claude_status`, `claude_wait`, `claude_cancel`,
  `claude_list`, `claude_forget`.
- **G2.** Async task model — `claude_run` is fire-and-forget, all
  blocking happens in `claude_wait(from_seq, timeout_ms)`.
- **G3.** Run multiple Claude tasks concurrently in one server process
  without cross-talk. Resume is always by explicit `session_id`
  (`--resume`), never `claude -c`.
- **G4.** Hard `cwd` whitelist (`--cwd-root`, repeatable, default
  `~/Projects`) enforced before spawning Claude. Path traversal
  rejected.
- **G5.** Drop-in for any MCP client (Cursor, Claude Desktop, Hermes,
  custom agents). Single binary published to npm. `npx
  @restry/claude-code-mcp-bridge mcp` just works.

## 3. Non-goals

- **NG1.** Durable / cross-process task state. State lives in memory,
  scoped to one server process. Server exits → tasks gone. A durable
  queue is a separate product.
- **NG2.** HTTP / SSE / WebSocket transports. stdio only.
- **NG3.** Bundling, hosting, or auth for the underlying `claude` CLI —
  caller's responsibility to have `claude` on `PATH` and logged in.
- **NG4.** Anything Feishu / Lark / messenger-shaped. That code stayed
  in `lark-channel-bridge`.
- **NG5.** Sandboxing of the Claude process. cwd whitelist is the only
  guardrail; Claude itself runs with the user's full permissions.

## 4. Users & use cases

| User                                       | Use case                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Hermes / orchestrator agent                | Spawn long Claude refactors in the background, poll while servicing other user turns           |
| Cursor / Claude Desktop power user         | Fire a multi-file task from chat, keep typing, get notified when it lands                      |
| Custom MCP client / CLI agent              | Run several Claude tasks in parallel against the same monorepo, each in its own subdirectory   |

## 5. Tool contracts

All tools are MCP `tools/call` over stdio. Snapshots are JSON; events
are typed `AgentEvent`s (see §6).

### 5.1 `claude_run(prompt, cwd?, model?, session_id?) → TaskSnapshot`

Starts a Claude task in the background. Returns immediately with the
initial snapshot (status=`running`, empty text, seq=0).

- `prompt` (string, required)
- `cwd` (string, optional) — defaults to `--cwd` flag, then server cwd.
  Must resolve under some `--cwd-root`.
- `model` (string, optional) — e.g. `claude-opus-4-8`
- `session_id` (string, optional) — resume by explicit id (`--resume
  <id>`), never `-c`.

### 5.2 `claude_status(task_id) → TaskSnapshot`

Returns the latest snapshot. No blocking.

### 5.3 `claude_wait(task_id, from_seq?=0, timeout_ms?=30000) → { events, snapshot }`

Blocks until either (a) new events with `seq > from_seq` arrive, (b)
the task reaches a terminal state, or (c) `timeout_ms` elapses
(returns whatever's accumulated, possibly empty). `timeout_ms` clamped
to `[100, 120000]`.

### 5.4 `claude_cancel(task_id) → TaskSnapshot`

SIGTERM, escalate to SIGKILL after a grace period. Status → `cancelled`.
No-op if already terminal.

### 5.5 `claude_list() → TaskSnapshot[]`

All known tasks (running + terminal) in this server process.

### 5.6 `claude_forget(task_id) → { dropped: boolean }`

Drops a finished task. No-op while running.

## 6. Status & event model

### Task statuses

`running` → `done` | `error` | `cancelled`. Terminal states are
sticky.

### Snapshot shape (canonical, see `task-registry.ts`)

```ts
{
  taskId, status, cwd, sessionId?, model?,
  startedAt, endedAt?, exitError?,
  text,                  // concatenated assistant text deltas
  currentTool?,          // last in-flight tool name
  counters: {
    events, toolUses, toolResults,
    inputTokens, outputTokens, costUsd
  }
}
```

### Event cursor (`seq`)

Each event has a monotonic per-task `seq`, 0-based, monotonically
increasing across the task's full lifetime — survives ring-buffer
trimming. Clients pass the highest `seq` they've seen back as
`from_seq` to resume streaming without gaps or replay.

If a task lives long enough that old events get trimmed, the registry
exposes `oldestSeq`. A client asking for `from_seq < oldestSeq` will
silently start from `oldestSeq` (events are dropped, not the snapshot).

## 7. Security model

- **cwd whitelist (enforced).** `--cwd-root` flags define allowed
  roots. Resolved with `path.resolve`, then prefix-checked. Default
  `~/Projects` if no flags. cwd outside every root → request rejected,
  Claude never spawned.
- **No shell.** Claude is spawned via `child_process.spawn(binary,
  args[])`, no `shell: true`, no string interpolation.
- **No secret handling.** This server doesn't read or store API keys.
  `claude` CLI handles its own auth (`claude login`).
- **stdio only.** No network listener. Only the parent process talks
  to this server.

Out of scope: sandboxing the Claude process itself, rate limiting,
multi-tenant isolation.

## 8. Lifecycle & persistence

- In-memory only. One registry per server process.
- Server exit → all task records gone. No journal, no SQLite, no FS
  spool.
- Event buffer is bounded per task (ring-trimmed); `seq` and
  `oldestSeq` together give callers honest semantics about what's
  still retrievable.

This is intentional — solves the 80% case (one orchestrator, one
stdio session, lifetime ≤ a workday). A durable queue is a separate
product.

## 9. Known limitations

- **L1.** Cron / scheduled callers that re-spawn a fresh MCP server
  per tick can't see tasks from prior ticks. Use long-lived parent
  process.
- **L2.** No backpressure on stdout from Claude — large outputs buffer
  in memory.
- **L3.** Cancel race: SIGTERM → SIGKILL grace not configurable.
- **L4.** `isAvailable()` only checks `claude --version` exit; doesn't
  detect "logged out" until the first run fails.
- **L5.** No structured error taxonomy yet — adapter surfaces raw
  Claude exit messages.

## 10. Test coverage (current state)

| Layer                           | LOC  | Tests           |
| ------------------------------- | ---- | --------------- |
| `task-registry.ts`              | 252  | 2 cases ✅      |
| `transports/mcp/server.ts`      | 217  | ❌ none         |
| `agent/claude/adapter.ts`       | 198  | ❌ none         |
| `agent/claude/stream-json.ts`   |  80  | ❌ none         |
| CLI / entrypoint                |  55  | ❌ none         |

Target for v0.2: adapter (spawn mocked), stream-json parser, MCP
server end-to-end via in-process client. See §11.

## 11. Roadmap

### v0.1.0 (current — unreleased on npm)

- Six tools, async task model, cwd whitelist, in-memory registry.
- Minimal test coverage (registry only).
- README + this PRD.

### v0.2.0 — test hardening

- Adapter tests: spawn mocked, verify args (`--resume` vs not,
  `--permission-mode`, `--output-format stream-json`), cancel race
  (SIGTERM → SIGKILL), stdout half-line handling, child crash.
- stream-json parser: golden-file tests against captured Claude stdout
  samples (incl. tool_use / tool_result / cost events).
- MCP server e2e: in-proc MCP client driving all six tools through one
  task lifecycle.
- Path-whitelist tests: traversal (`../`), symlinks, multi-root.

### v0.3.0 — quality of life

- Configurable cancel grace period.
- Structured error codes on the MCP error channel.
- `isAvailable()` includes a cheap "logged in?" probe.
- Optional per-task stdout cap with overflow signal (instead of
  unbounded buffering).

### v1.0.0 — stability commitment

- Tool signatures frozen.
- Snapshot shape frozen (additive only).
- Semver discipline on breaking changes.

## 12. Open questions

- **Q1.** Should we add a `claude_stream` SSE-style tool, or is
  `claude_wait` polling enough? (Current take: polling wins for stdio
  — keep it.)
- **Q2.** Per-task working-directory cleanup hook (e.g. `git stash` /
  worktree) — in scope, or a wrapper's job? (Current take: wrapper's.)
- **Q3.** Should `claude_forget` accept a `kill: boolean` to combine
  cancel + forget? (Maybe in v0.3.)
