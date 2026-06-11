import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AgentEvent, AgentRun } from '../../agent/types';

// --- module mocks -----------------------------------------------------------
// We drive the *real* startMcpServer (so its handler wiring is exercised), but
// swap two seams:
//   1. StdioServerTransport → an InMemoryTransport half, so an in-process MCP
//      Client can speak to the server without touching real stdio.
//   2. ClaudeAdapter → a mock AgentAdapter, so `claude` is never spawned.
// Both class constructors return a pre-seeded object (a returned object from a
// constructor overrides `new`), wired through a hoisted holder.
const h = vi.hoisted(() => ({
  serverTransport: null as unknown,
  mockAdapter: null as unknown,
  notifyCalls: [] as Array<{ target: unknown; kind: string; status: string }>,
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {
    constructor() {
      return h.serverTransport as object;
    }
  },
}));

vi.mock('../../agent/claude/adapter', () => ({
  ClaudeAdapter: class {
    constructor() {
      return h.mockAdapter as object;
    }
  },
}));

// Swap the real notifier so no lark-cli subprocess is ever spawned; record calls.
vi.mock('./notifier', () => ({
  fireFeishuNotification: vi.fn(async (target: unknown, snapshot: { status: string }, kind: string) => {
    h.notifyCalls.push({ target, kind, status: snapshot.status });
  }),
}));

import { startMcpServer, type McpServerOptions } from './server';

// --- controllable mock run / adapter ---------------------------------------
class ControlledRun implements AgentRun {
  private readonly buffer: AgentEvent[] = [];
  private pendingResolve: ((v: IteratorResult<AgentEvent>) => void) | null = null;
  private exited = false;
  stopped = false;

  events: AsyncIterable<AgentEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<AgentEvent>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.exited) {
          return Promise.resolve({ value: undefined as unknown as AgentEvent, done: true });
        }
        return new Promise((resolve) => {
          this.pendingResolve = resolve;
        });
      },
    }),
  };

  push(event: AgentEvent): void {
    if (this.pendingResolve) {
      const r = this.pendingResolve;
      this.pendingResolve = null;
      r({ value: event, done: false });
    } else {
      this.buffer.push(event);
    }
  }

  end(): void {
    this.exited = true;
    if (this.pendingResolve) {
      const r = this.pendingResolve;
      this.pendingResolve = null;
      r({ value: undefined as unknown as AgentEvent, done: true });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.end();
  }

  async waitForExit(): Promise<boolean> {
    return this.exited;
  }
}

interface MockAdapter {
  id: string;
  displayName: string;
  isAvailable(): Promise<boolean>;
  run(opts: unknown): AgentRun;
  runs: ControlledRun[];
}

function makeMockAdapter(): MockAdapter {
  const runs: ControlledRun[] = [];
  return {
    id: 'mock',
    displayName: 'mock',
    isAvailable: async () => true,
    run() {
      const run = new ControlledRun();
      runs.push(run);
      return run;
    },
    runs,
  };
}

// --- harness ----------------------------------------------------------------
const openRuns: ControlledRun[] = [];
const openClients: Client[] = [];

process.setMaxListeners(50); // startMcpServer registers SIGINT/SIGTERM per call

async function connect(
  opts: McpServerOptions,
): Promise<{ client: Client; adapter: MockAdapter }> {
  const adapter = makeMockAdapter();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  h.serverTransport = serverTransport;
  h.mockAdapter = adapter;

  await startMcpServer(opts);

  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  openClients.push(client);
  // Track runs so we can drain them in teardown.
  const origRun = adapter.run.bind(adapter);
  adapter.run = (o: unknown) => {
    const r = origRun(o) as ControlledRun;
    openRuns.push(r);
    return r;
  };
  return { client, adapter };
}

function parse(res: { content: Array<{ type: string; text?: string }> }): any {
  const block = res.content.find((c) => c.type === 'text');
  return JSON.parse(block!.text!);
}

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  return (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text?: string }>;
  };
}

afterEach(async () => {
  for (const r of openRuns.splice(0)) r.end();
  for (const c of openClients.splice(0)) await c.close().catch(() => {});
  h.notifyCalls.length = 0;
});

describe('MCP server — tool registration', () => {
  it('lists the claude_* tools with input schemas', async () => {
    const { client } = await connect({});
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'claude_cancel',
        'claude_forget',
        'claude_list',
        'claude_run',
        'claude_session_forget',
        'claude_session_get',
        'claude_sessions',
        'claude_status',
        'claude_wait',
      ].sort(),
    );
    const run = tools.find((t) => t.name === 'claude_run')!;
    expect(run.inputSchema.required).toContain('prompt');
    // notify_target is additive and optional — present in properties, not required.
    const props = run.inputSchema.properties as Record<string, unknown>;
    expect(props.notify_target).toBeDefined();
    expect(run.inputSchema.required).not.toContain('notify_target');
  });
});

describe('MCP server — notify_target', () => {
  it('claude_run accepts notify_target without a schema error', async () => {
    const { client } = await connect({});
    const started = parse(
      await callTool(client, 'claude_run', {
        prompt: 'hi',
        notify_target: { type: 'feishu', chat_id: 'oc_xyz', notify_on_start: true },
      }),
    );
    expect(started.status).toBe('running');
    // notify_on_start fires a 'start' notification synchronously during start().
    expect(h.notifyCalls.some((c) => c.kind === 'start')).toBe(true);
  });

  it('fires an end notification when the task reaches a terminal state', async () => {
    const { client, adapter } = await connect({});
    const started = parse(
      await callTool(client, 'claude_run', {
        prompt: 'hi',
        notify_target: { type: 'feishu', anchor_msg_id: 'om_abc', reply_in_thread: true },
      }),
    );
    const taskId = started.task_id as string;
    const run = adapter.runs[0]!;
    run.push({ type: 'done', sessionId: 's' });
    run.end();
    // Drain to terminal so consumeEvents' finally runs.
    await callTool(client, 'claude_wait', { task_id: taskId, from_seq: -1, timeout_ms: 1000 });

    const endCall = h.notifyCalls.find((c) => c.kind === 'end');
    expect(endCall).toBeDefined();
    expect(endCall!.status).toBe('done');
  });

  it('does not notify when no notify_target is given', async () => {
    const { client, adapter } = await connect({});
    const started = parse(await callTool(client, 'claude_run', { prompt: 'hi' }));
    const taskId = started.task_id as string;
    const run = adapter.runs[0]!;
    run.push({ type: 'done', sessionId: 's' });
    run.end();
    await callTool(client, 'claude_wait', { task_id: taskId, from_seq: -1, timeout_ms: 1000 });
    expect(h.notifyCalls).toHaveLength(0);
  });
});

describe('MCP server — requireNotifyTarget enforcement', () => {
  it('rejects claude_run without notify_target when requireNotifyTarget=true', async () => {
    const { client, adapter } = await connect({ requireNotifyTarget: true });
    await expect(callTool(client, 'claude_run', { prompt: 'hi' })).rejects.toThrow(
      /notify_target is REQUIRED/,
    );
    // No task should have been spawned on the adapter.
    expect(adapter.runs).toHaveLength(0);
  });

  it('rejects notify_target with no routing target (no anchor_msg_id, no chat_id)', async () => {
    const { client, adapter } = await connect({ requireNotifyTarget: true });
    await expect(
      callTool(client, 'claude_run', {
        prompt: 'hi',
        notify_target: { type: 'feishu' },
      }),
    ).rejects.toThrow(/routing target/);
    await expect(
      callTool(client, 'claude_run', {
        prompt: 'hi',
        notify_target: { type: 'feishu', reply_in_thread: true, notify_on_start: true },
      }),
    ).rejects.toThrow(/routing target/);
    expect(adapter.runs).toHaveLength(0);
  });

  it('accepts notify_target with anchor_msg_id', async () => {
    const { client } = await connect({ requireNotifyTarget: true });
    const started = parse(
      await callTool(client, 'claude_run', {
        prompt: 'hi',
        notify_target: { type: 'feishu', anchor_msg_id: 'om_xxx', reply_in_thread: true },
      }),
    );
    expect(started.status).toBe('running');
  });

  it('accepts claude_run with notify_target when requireNotifyTarget=true', async () => {
    const { client } = await connect({ requireNotifyTarget: true });
    const started = parse(
      await callTool(client, 'claude_run', {
        prompt: 'hi',
        notify_target: { type: 'feishu', chat_id: 'oc_xyz' },
      }),
    );
    expect(started.status).toBe('running');
  });

  it('default (requireNotifyTarget unset) still accepts bare claude_run', async () => {
    const { client } = await connect({});
    const started = parse(await callTool(client, 'claude_run', { prompt: 'hi' }));
    expect(started.status).toBe('running');
  });
});

describe('MCP server — full task lifecycle through one in-process client', () => {
  it('run → wait → status → list → cancel → forget', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccmb-life-')));
    const { client, adapter } = await connect({ cwdRoots: [root] });

    // 1. run → immediate snapshot, status running, seq baseline.
    const started = parse(await callTool(client, 'claude_run', { prompt: 'hello', cwd: root }));
    expect(started.status).toBe('running');
    expect(typeof started.task_id).toBe('string');
    const taskId = started.task_id as string;
    expect(adapter.runs).toHaveLength(1);

    // Feed events into the underlying run.
    const run = adapter.runs[0]!;
    run.push({ type: 'system', sessionId: 'sess-1', model: 'claude-opus-4-8' });
    run.push({ type: 'text', delta: 'hello ' });
    run.push({ type: 'text', delta: 'world' });

    // 2. wait → stream the queued events the way a real client would: start at
    // from_seq=-1 (claude_wait is *strictly after* the cursor, so 0 would skip
    // seq 0), then advance the cursor past the highest seq seen each round.
    // The task stays running, so loop until we've drained the three pushed
    // events (with a guard) rather than blocking a full timeout on round 4.
    const drained: Array<{ seq: number; event: AgentEvent }> = [];
    let cursor = -1;
    for (let i = 0; i < 10 && drained.length < 3; i++) {
      const waited = parse(
        await callTool(client, 'claude_wait', {
          task_id: taskId,
          from_seq: cursor,
          timeout_ms: 1000,
        }),
      );
      for (const r of waited.events) {
        drained.push(r);
        cursor = Math.max(cursor, r.seq);
      }
    }
    expect(drained.map((e) => e.event.type)).toEqual(['system', 'text', 'text']);
    expect(drained.map((e) => e.seq)).toEqual([0, 1, 2]); // 0-based, monotonic, gapless

    // 3. status → accumulated text + session captured from the system event.
    const status = parse(await callTool(client, 'claude_status', { task_id: taskId }));
    expect(status.status).toBe('running');
    expect(status.text).toBe('hello world');
    expect(status.session_id).toBe('sess-1');

    // 4. list → the task is visible.
    const listed = parse(await callTool(client, 'claude_list'));
    expect(listed.tasks.map((t: any) => t.task_id)).toContain(taskId);

    // 5. cancel → status flips to cancelled and the run was stopped.
    const cancelled = parse(await callTool(client, 'claude_cancel', { task_id: taskId }));
    expect(cancelled.cancelled).toBe(true);
    expect(run.stopped).toBe(true);
    const afterCancel = parse(await callTool(client, 'claude_status', { task_id: taskId }));
    expect(afterCancel.status).toBe('cancelled');

    // 6. forget → drops the (now terminal) task.
    const forgotten = parse(await callTool(client, 'claude_forget', { task_id: taskId }));
    expect(forgotten.forgotten).toBe(true);
    await expect(callTool(client, 'claude_status', { task_id: taskId })).rejects.toThrow(
      /unknown task_id/,
    );
  });

  it('claude_wait returns immediately (empty) once a task is terminal', async () => {
    const { client, adapter } = await connect({});
    const started = parse(await callTool(client, 'claude_run', { prompt: 'p' }));
    const taskId = started.task_id as string;
    const run = adapter.runs[0]!;
    run.push({ type: 'done', sessionId: 's' });
    run.end();
    // Drain to terminal.
    await callTool(client, 'claude_wait', { task_id: taskId, from_seq: 0, timeout_ms: 1000 });

    const start = Date.now();
    const again = parse(
      await callTool(client, 'claude_wait', { task_id: taskId, from_seq: 999, timeout_ms: 5000 }),
    );
    expect(Date.now() - start).toBeLessThan(1000); // did NOT block the full timeout
    expect(again.events).toEqual([]);
    expect(again.snapshot.status).toBe('done');
  });
});

describe('MCP server — cwd whitelist enforcement', () => {
  let rootA: string;
  let rootB: string;
  let outside: string;
  let client: Client;

  beforeEach(async () => {
    rootA = realpathSync(mkdtempSync(join(tmpdir(), 'ccmb-rootA-')));
    rootB = realpathSync(mkdtempSync(join(tmpdir(), 'ccmb-rootB-')));
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'ccmb-out-')));
    ({ client } = await connect({ cwdRoots: [rootA, rootB] }));
  });

  it('rejects a cwd outside every root, never starting a task', async () => {
    await expect(
      callTool(client, 'claude_run', { prompt: 'p', cwd: outside }),
    ).rejects.toThrow(/outside the allowed roots/);
  });

  it('rejects a ../ traversal that escapes a root', async () => {
    const escape = join(rootA, '..', 'totally-elsewhere');
    await expect(
      callTool(client, 'claude_run', { prompt: 'p', cwd: escape }),
    ).rejects.toThrow(/outside the allowed roots/);
  });

  it('allows a cwd under any configured root (multi-root)', async () => {
    const subA = join(rootA, 'pkg');
    const subB = join(rootB, 'svc');
    mkdirSync(subA);
    mkdirSync(subB);

    const a = parse(await callTool(client, 'claude_run', { prompt: 'p', cwd: subA }));
    expect(a.status).toBe('running');
    const b = parse(await callTool(client, 'claude_run', { prompt: 'p', cwd: subB }));
    expect(b.status).toBe('running');
  });

  // Regression: resolveCwd() must resolve the real path (fs.realpath) of both
  // candidate and roots before the prefix check. A symlink physically located
  // under a root but pointing outside it must NOT pass — otherwise Claude could
  // spawn with a cwd outside every allowed root. (PRD §7 / §11.)
  it('rejects a symlink inside a root that resolves outside every root', async () => {
    // A symlink physically located under rootA but pointing at `outside`.
    // path.resolve alone won't catch this — the whitelist must resolve the
    // real path (fs.realpath) before the prefix check.
    const link = join(rootA, 'escape-link');
    symlinkSync(outside, link);
    await expect(
      callTool(client, 'claude_run', { prompt: 'p', cwd: link }),
    ).rejects.toThrow(/outside the allowed roots/);
  });
});

describe('MCP server — durable sessions', () => {
  let storeFile: string;
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'srv-sess-'));
    storeFile = join(dir, 'sessions.json');
  });

  async function drainToTerminal(client: Client, taskId: string) {
    let fromSeq = 0;
    for (let i = 0; i < 50; i++) {
      const out = parse(await callTool(client, 'claude_wait', { task_id: taskId, from_seq: fromSeq, timeout_ms: 200 }));
      for (const e of out.events) if (e.seq > fromSeq) fromSeq = e.seq;
      if (out.snapshot.status !== 'running') return out.snapshot;
    }
    throw new Error('task never reached terminal');
  }

  it('records a finished run in claude_sessions and persists to disk', async () => {
    const { client, adapter } = await connect({ sessionStorePath: storeFile });
    const started = parse(await callTool(client, 'claude_run', { prompt: 'do a thing', cwd: tmpdir() }));

    const run = adapter.runs[0]!;
    run.push({ type: 'system', sessionId: 'sess-1', model: 'claude-x' });
    run.push({ type: 'text', delta: 'all done' });
    run.end();
    await drainToTerminal(client, started.task_id);

    const sessions = parse(await callTool(client, 'claude_sessions', {})).sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].session_id).toBe('sess-1');
    expect(sessions[0].status).toBe('done');
    expect(sessions[0].run_count).toBe(1);
    expect(sessions[0].last_prompt).toBe('do a thing');

    // A fresh server pointed at the same file sees the session (durability).
    const { client: client2 } = await connect({ sessionStorePath: storeFile });
    const got = parse(await callTool(client2, 'claude_session_get', { session_id: 'sess-1' }));
    expect(got.session_id).toBe('sess-1');
    expect(got.last_text_excerpt).toBe('all done');
  });

  it('claude_session_get throws on unknown id; claude_session_forget drops it', async () => {
    const { client, adapter } = await connect({ sessionStorePath: storeFile });
    await expect(callTool(client, 'claude_session_get', { session_id: 'nope' })).rejects.toThrow(/unknown session_id/);

    const started = parse(await callTool(client, 'claude_run', { prompt: 'p', cwd: tmpdir() }));
    const run = adapter.runs[0]!;
    run.push({ type: 'system', sessionId: 'sess-x' });
    run.end();
    await drainToTerminal(client, started.task_id);

    expect(parse(await callTool(client, 'claude_session_forget', { session_id: 'sess-x' })).forgotten).toBe(true);
    expect(parse(await callTool(client, 'claude_sessions', {})).sessions).toHaveLength(0);
  });
});
