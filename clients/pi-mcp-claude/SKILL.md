---
name: pi-mcp-claude
description: 让 Pi 通过 MCP 调用本地 Claude Code（claude-code-mcp-bridge）。当爸爸说「派给 claude / 让 claude code 跑一下 / 用 MCP 调 claude / 后台让 claude 改代码 / dispatch to claude code」等，需要把一个编码任务交给本地 claude CLI 后台执行并拿回结果时使用。Pi 运行时本身没有 MCP 客户端，本 skill 的脚本就是那个客户端：spawn bridge、做 JSON-RPC initialize 握手、把 6 个 claude_* 工具暴露成子命令。不负责：直接编辑文件（用 edit/write）、飞书相关操作（走 lark-* skills）。
---

# pi-mcp-claude

Pi 的运行时（pi-coding-agent）没有内置 MCP 客户端，所以这个 skill 的脚本
`scripts/mcp_claude.mjs` 自己就是一个 **真正的 MCP stdio 客户端**：spawn
`claude-code-mcp-bridge`，完成 JSON-RPC `initialize` 握手，调用它的工具。

底层 = 本地 `claude` CLI 被 bridge 包成异步任务模型（run/status/wait/cancel/list/forget）。

## 关键事实

- bridge 的任务注册表是**内存级、绑定单条 stdio 连接**：进程退出任务即丢失。
- 因此每次跑脚本是一条新连接，唯一跨调用有意义的模式是 `run` —— 它在**同一条连接里**
  阻塞 + 流式 `claude_wait` 直到任务 terminal，把全文打印出来。
- `claude` CLI 在 nvm v22 路径下；脚本会自动 `command -v claude` 找到它的目录并注入子进程 PATH。
- bridge 默认 `--cwd-root ~/projects`，任务的 cwd 必须落在白名单内（脚本用 `CWD_ROOT` 控制，默认 `~/projects`）。

## 怎么跑

### 短任务：阻塞 + 流式（几十秒级）

派一个编码任务并流式拿结果：

```bash
node ~/.pi/agent/skills/pi-mcp-claude/scripts/mcp_claude.mjs run "<prompt>" \
  --cwd <项目目录，须在 ~/projects 下> --timeout-ms 120000
```

- 文本默认边跑边流到 stdout；`tool_use`/`error`/状态打到 stderr。
- 加 `--json` 改为只在结束时输出 `{task_id,status,session_id,text}`。
- 续接上一轮 claude 会话：`--session <session_id>`（从上次输出的 session 拿）。
- 换模型：`--model claude-opus-4-8`。

### 会话续接（上下文连续）

bridge 用 `--resume <session_id>` 按身份续接（**不是** `-c`，避免同 cwd 串台）。
同一任务要让 CC 接着上一轮上下文：第一轮结束拿到 `session=xxx`，第二轮传 `--session xxx`。

bridge 还维护一个**落盘的会话注册表**（`~/.claude-code-mcp-bridge/sessions.json`，跨重启/跨客户端共享）：

```bash
node ~/.agents/skills/pi-mcp-claude/scripts/mcp_claude.mjs sessions            # 列出所有会话
node ~/.agents/skills/pi-mcp-claude/scripts/mcp_claude.mjs sessions --get <id>  # 某个会话详情
```

每条含 session_id / 最近一轮状态 / cwd / model / run_count / 首末提示与正文节选。由于是落盘的，
**我跨回合也能查回上次的 session_id 再 `--session` 续接**。

### 长任务：dispatch 后台派单（分钟~小时级，不卡回合）

```bash
node ~/.agents/skills/pi-mcp-claude/scripts/mcp_claude.mjs dispatch "<prompt>" \
  --cwd <项目目录> \
  --thread-id <omt_xxx 从系统提示里拿>     # 在话题里聊时
# 或，在主会话（非话题）里聊时：
#   ... dispatch "<prompt>" --cwd <项目目录> --main
```

**硬规矩（决定通知发哪里，必须显式传）**：
- 在话题里 → 传 `--thread-id <omt_xxx>`（从系统提示头部 `Source: Feishu (... thread: omt_xxx)` 取），通知 reply 进那个话题。
- 在主会话（系统提示没有 thread）→ 传 `--main`，通知发主聊天流。
- **两个都不传** → 脚本拒绝猜测，`anchor=NONE`，bridge 无处通知。以前的"取最新话题"兜底已删除——那会把主会话的任务误投到不相干的话题里。

- 脚本会**自我 detach** 成后台 worker 立刻返回，我的回合马上结束、不占用。
- worker 持有连接直到任务 terminal；`claude_run` 带了 `notify_target`，
  所以 **bridge 自己**在「派出」和「完成/失败」两个时刻直接回帖。
- anchor 解析：`--anchor <om_xxx>` 显式 > `--thread-id <omt_xxx>`（reply-in-thread）> `--main`（主聊天流，不 reply-in-thread）。不猜测。
- worker 日志写在 `/tmp/mcp_claude_dispatch_<ts>.log`，调试看它。
- 通知用 `--as bot` 回帖，需要 `lark-cli` 在 PATH 上。Pi 的 daemon 默认身份（`~/.lark-cli`，即 Pi 的 app）本就在 Pi 话题里，所以无需 `lark_home`。

列出 bridge 暴露的工具（验证握手是否通）：

```bash
node ~/.pi/agent/skills/pi-mcp-claude/scripts/mcp_claude.mjs tools
```

## 环境变量

- `BRIDGE_DIR`     bridge 仓库位置，默认 `~/projects/claude-code-mcp-bridge`
- `CWD_ROOT`       bridge 的 cwd 白名单根，默认 `~/projects`
- `CLAUDE_BIN_DIR` 手动指定 claude 所在目录（默认自动探测）

## 前提

- `~/projects/claude-code-mcp-bridge` 已 `npm install` 且有 `dist/`（否则先 `npm run build`）。
- MCP SDK 复用 bridge 自己的 `node_modules/@modelcontextprotocol/sdk`，无需额外安装。

## Pitfalls

1. cwd 必须在 `~/projects` 下，否则 bridge 在 spawn claude 前就拒绝。
2. 退出码：`done`→0，其它（error/cancelled）→2。
3. 任务跨脚本调用不可见（内存态）；想要长任务后台跑完再通知，应在 bridge 端用
   `notify_target`（飞书），那是给纯 MCP 客户端用的，本 skill 默认走阻塞-流式。
4. 文件名是 `mcp_claude.mjs`（下划线），不是 `mcp-claude`。
5. dispatch 若提示 `anchor=NONE`，说明没传 `--thread-id` / `--main`，bridge 将无处通知；
   按上面"硬规矩"补传（话题里用 `--thread-id`，主会话用 `--main`）。
