import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { realpathSync } from 'node:fs';
import { resolve as resolvePath, sep as pathSep } from 'node:path';
import { ClaudeAdapter } from '../../agent/claude/adapter';
import { TaskRegistry, type TaskEventRecord, type TaskSnapshot } from './task-registry';
import type { NotifyTarget } from './notifier';

export interface McpServerOptions {
  /** Default cwd applied when the caller does not specify one. */
  defaultCwd?: string;
  /** Optional restriction: tasks must run under one of these roots. */
  cwdRoots?: string[];
  /**
   * When true, claude_run rejects calls that omit notify_target, so a forgetful
   * LLM caller can't fire-and-forget a long task with no end-of-run signal.
   * Default false (back-compat: existing bridges keep accepting bare calls).
   */
  requireNotifyTarget?: boolean;
}

const TOOL_DEFINITIONS = [
  {
    name: 'claude_run',
    description:
      'Start a Claude Code task asynchronously. Returns immediately with a task_id; the task runs in the background. Use claude_status / claude_wait to track progress, claude_cancel to abort.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The prompt to send to Claude.' },
        cwd: {
          type: 'string',
          description: 'Working directory for Claude to run in. Defaults to the MCP server default.',
        },
        session_id: {
          type: 'string',
          description: 'Resume a prior Claude session (its session_id from a previous run).',
        },
        model: { type: 'string', description: 'Override the Claude model (e.g. claude-opus-4-7).' },
        notify_target: {
          type: 'object',
          description:
            'Optional. When the task reaches a terminal state (done/error/cancelled), bridge will fire a one-shot notification. Currently supports type="feishu".',
          properties: {
            type: { type: 'string', enum: ['feishu'] },
            chat_id: {
              type: 'string',
              description:
                'Feishu chat_id (oc_xxx). Used when reply_in_thread is false or no anchor_msg_id provided.',
            },
            anchor_msg_id: {
              type: 'string',
              description:
                'Feishu message_id (om_xxx) anywhere in the target thread. REQUIRED to reply into a thread, because Feishu API can only reply-to-message, not send-to-thread.',
            },
            reply_in_thread: {
              type: 'boolean',
              description:
                'When true and anchor_msg_id given, the notification appears inside that thread. When false, notification goes to the main chat stream via chat_id.',
            },
            as_identity: {
              type: 'string',
              enum: ['bot', 'user'],
              description: 'lark-cli --as flag. Defaults to "user" (the bot is usually not a member of the target chat).',
            },
            notify_on_start: {
              type: 'boolean',
              description:
                'When true, also fire a notification immediately after task spawn with the task_id (useful for "派出了" 提示). Default false.',
            },
          },
          required: ['type'],
          additionalProperties: false,
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'claude_status',
    description: 'Get a snapshot of a task: status, accumulated text, counters, tool in flight.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'claude_wait',
    description:
      'Block (briefly) for new events on a task. Returns event records strictly after `from_seq` (default 0). Returns immediately when the task reaches a terminal state. Use the highest returned `seq` as `from_seq` for the next call to stream progress chunk-by-chunk.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        from_seq: { type: 'number', default: 0 },
        timeout_ms: { type: 'number', default: 30000, minimum: 100, maximum: 120000 },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'claude_cancel',
    description: 'Send SIGTERM (then SIGKILL) to a running task and mark it cancelled.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'claude_list',
    description: 'List all known tasks in this MCP server (running and terminal).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'claude_forget',
    description: 'Drop a finished task from memory. No-op while a task is still running.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
] as const;

function jsonResult(value: unknown) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  };
}

function snapshotToWire(s: TaskSnapshot) {
  return {
    task_id: s.taskId,
    status: s.status,
    cwd: s.cwd,
    session_id: s.sessionId,
    model: s.model,
    started_at: s.startedAt,
    ended_at: s.endedAt,
    exit_error: s.exitError,
    text: s.text,
    current_tool: s.currentTool,
    counters: s.counters,
  };
}

function recordsToWire(records: TaskEventRecord[]) {
  return records.map((r) => ({ seq: r.seq, ts: r.ts, event: r.event }));
}

/**
 * Parse the opaque `notify_target` arg into a NotifyTarget. Returns undefined
 * when absent or malformed (notifications are best-effort, never required), so
 * a bad target never blocks the task from starting.
 */
function parseNotifyTarget(raw: unknown): NotifyTarget | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (o.type !== 'feishu') return undefined;
  const target: NotifyTarget = { type: 'feishu' };
  if (typeof o.chat_id === 'string') target.chat_id = o.chat_id;
  if (typeof o.anchor_msg_id === 'string') target.anchor_msg_id = o.anchor_msg_id;
  if (typeof o.reply_in_thread === 'boolean') target.reply_in_thread = o.reply_in_thread;
  if (o.as_identity === 'bot' || o.as_identity === 'user') target.as_identity = o.as_identity;
  if (typeof o.notify_on_start === 'boolean') target.notify_on_start = o.notify_on_start;
  return target;
}

function resolveCwd(opts: McpServerOptions, requested?: string): string {
  const raw = requested?.trim() || opts.defaultCwd?.trim() || process.cwd();
  // Normalize ./.. away, THEN resolve symlinks. path.resolve alone is purely
  // lexical, so a symlink physically located under a root but pointing outside
  // it would slip past the prefix check; fs.realpath collapses it to its real
  // target before we compare. Roots are realpath'd too, so a legitimate cwd
  // under a symlinked root (e.g. macOS /tmp → /private/tmp) still matches.
  const candidate = realpathOrLexical(resolvePath(raw));
  if (opts.cwdRoots && opts.cwdRoots.length > 0) {
    const normalizedRoots = opts.cwdRoots.map((r) => realpathOrLexical(resolvePath(r)));
    const ok = normalizedRoots.some(
      (root) => candidate === root || candidate.startsWith(root + pathSep),
    );
    if (!ok) {
      throw new Error(
        `cwd "${candidate}" is outside the allowed roots: ${normalizedRoots.join(', ')}`,
      );
    }
  }
  return candidate;
}

/**
 * Resolve symlinks to a real path. Falls back to the (already lexically
 * resolved) input when the path doesn't exist yet, so non-existent cwds keep
 * their previous lexical-only behaviour instead of throwing ENOENT here.
 */
function realpathOrLexical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export async function startMcpServer(opts: McpServerOptions = {}): Promise<void> {
  const adapter = new ClaudeAdapter();
  const registry = new TaskRegistry(adapter);

  const server = new Server(
    { name: 'claude-code-bridge', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((t) => ({ ...t })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    switch (req.params.name) {
      case 'claude_run': {
        const prompt = String(args.prompt ?? '').trim();
        if (!prompt) throw new Error('prompt is required');
        if (opts.requireNotifyTarget) {
          const nt = args.notify_target as Record<string, unknown> | undefined;
          const hasTarget = nt && typeof nt === 'object';
          const hasAnchor = hasTarget && typeof nt.anchor_msg_id === 'string' && nt.anchor_msg_id.length > 0;
          const hasChat = hasTarget && typeof nt.chat_id === 'string' && nt.chat_id.length > 0;
          if (!hasTarget || (!hasAnchor && !hasChat)) {
            throw new Error(
              [
                'notify_target is REQUIRED on this server (--require-notify-target),',
                'and must include at least one routing target: `anchor_msg_id` (to reply',
                'into a thread) or `chat_id` (to send into the main chat stream).',
                'Without one, the bridge has nowhere to send the completion notification.',
                '',
                '  notify_target: {',
                '    type: "feishu",',
                '    anchor_msg_id: "om_xxx",   // a message ID in the target Feishu thread',
                '    reply_in_thread: true,     // post into the thread, not the main chat',
                '    as_identity: "user",       // default; pass "bot" only if the bot is in the chat',
                '    notify_on_start: true      // optional: also notify when task is dispatched',
                '  }',
                '',
                "If you genuinely don't want a notification, the caller should not have enabled --require-notify-target on this bridge.",
              ].join('\n'),
            );
          }
        }
        const cwd = resolveCwd(opts, typeof args.cwd === 'string' ? args.cwd : undefined);
        const sessionId = typeof args.session_id === 'string' ? args.session_id : undefined;
        const model = typeof args.model === 'string' ? args.model : undefined;
        const notifyTarget = parseNotifyTarget(args.notify_target);
        const snap = registry.start({
          prompt,
          cwd,
          sessionId,
          model,
          permissionMode: 'bypassPermissions',
          appendSystemPrompt: null,
          notifyTarget,
        });
        return jsonResult(snapshotToWire(snap));
      }
      case 'claude_status': {
        const id = String(args.task_id ?? '');
        const snap = registry.get(id);
        if (!snap) throw new Error(`unknown task_id: ${id}`);
        return jsonResult(snapshotToWire(snap));
      }
      case 'claude_wait': {
        const id = String(args.task_id ?? '');
        const fromSeq = typeof args.from_seq === 'number' ? args.from_seq : 0;
        const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : 30000;
        if (!registry.get(id)) throw new Error(`unknown task_id: ${id}`);
        const records = await registry.waitForEvents(id, fromSeq, timeoutMs);
        const snap = registry.get(id)!;
        return jsonResult({
          snapshot: snapshotToWire(snap),
          events: recordsToWire(records),
        });
      }
      case 'claude_cancel': {
        const id = String(args.task_id ?? '');
        const ok = await registry.cancel(id);
        return jsonResult({ task_id: id, cancelled: ok });
      }
      case 'claude_list': {
        return jsonResult({ tasks: registry.list().map(snapshotToWire) });
      }
      case 'claude_forget': {
        const id = String(args.task_id ?? '');
        const ok = registry.forget(id);
        return jsonResult({ task_id: id, forgotten: ok });
      }
      default:
        throw new Error(`unknown tool: ${req.params.name}`);
    }
  });

  const shutdown = async () => {
    try {
      await registry.shutdown();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
