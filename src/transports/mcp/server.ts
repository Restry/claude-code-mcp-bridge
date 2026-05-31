import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { resolve as resolvePath, sep as pathSep } from 'node:path';
import { ClaudeAdapter } from '../../agent/claude/adapter';
import { TaskRegistry, type TaskEventRecord, type TaskSnapshot } from './task-registry';

export interface McpServerOptions {
  /** Default cwd applied when the caller does not specify one. */
  defaultCwd?: string;
  /** Optional restriction: tasks must run under one of these roots. */
  cwdRoots?: string[];
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

function resolveCwd(opts: McpServerOptions, requested?: string): string {
  const raw = requested?.trim() || opts.defaultCwd?.trim() || process.cwd();
  // Normalize ./.. away so the whitelist check can't be bypassed via "/root/../etc".
  const candidate = resolvePath(raw);
  if (opts.cwdRoots && opts.cwdRoots.length > 0) {
    const normalizedRoots = opts.cwdRoots.map((r) => resolvePath(r));
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
        const cwd = resolveCwd(opts, typeof args.cwd === 'string' ? args.cwd : undefined);
        const sessionId = typeof args.session_id === 'string' ? args.session_id : undefined;
        const model = typeof args.model === 'string' ? args.model : undefined;
        const snap = registry.start({
          prompt,
          cwd,
          sessionId,
          model,
          permissionMode: 'bypassPermissions',
          appendSystemPrompt: null,
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
