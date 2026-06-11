# Clients

Reference client integrations for the bridge. These are vendored copies kept
in sync with where they actually run, so the bridge ships with a working
example of how a real MCP client drives it.

## `pi-mcp-claude/`

The Pi (pi-coding-agent) skill that turns this bridge into a set of
`claude_*` subcommands. Lives at runtime in `~/.agents/skills/pi-mcp-claude/`.

- `SKILL.md` — when/how Pi loads it; dispatch rules and pitfalls.
- `scripts/mcp_claude.mjs` — the MCP client itself: connects over HTTP
  (`:8787/mcp`, falls back to stdio), exposes `run` / `tools` / `dispatch` /
  `status` / `watch` / `sessions`, and self-detaches long tasks so the agent
  turn doesn't block.

### Watching a running task

`dispatch` returns a `task_id` (in the worker log's first line). Peek at a
running task with `status <task_id>` (one-shot snapshot: accumulated text,
in-flight tool, counters) or `watch <task_id>` (live `claude_wait` long-poll
stream of text/tool/error events until terminal). Both are read-only and
multiple clients can watch the same task concurrently.

### Notification routing (the important bit)

`dispatch` builds the Feishu `notify_target` so the bridge replies when a long
task finishes. Routing is **explicit** — no guessing:

- in a thread → pass `--thread-id <omt_xxx>` (reply into that thread)
- in the main chat → pass `--main` (reply in the main p2p stream)
- neither → the script refuses to resolve an anchor (`anchor=NONE`) rather
  than misrouting a main-chat task into an unrelated thread.

Pi's daemon identity (`~/.lark-cli`) is already a member of Pi's chats, so no
`lark_home` override is needed. Other clients (e.g. Hermes) that share the
daemon must pass `lark_home` in `notify_target` to notify as their own bot —
see the main README's HTTP mode section.
