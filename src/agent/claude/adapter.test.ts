import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../types';

// --- mock node:child_process.spawn ------------------------------------------
// The adapter imports { spawn } from 'node:child_process'. We replace it with a
// vi.fn whose behaviour each test configures. Real `claude` is NEVER spawned.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

// Imported after the mock is registered (vi.mock is hoisted, but keep it tidy).
import { ClaudeAdapter } from './adapter';

/**
 * Minimal stand-in for a Node ChildProcess that the adapter pokes at:
 * stdout/stderr Readable streams, pid/exitCode/signalCode, kill(), and the
 * 'error'/'exit' events. Tests drive it explicitly.
 */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  signalCode: string | null = null;
  readonly killSignals: string[] = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(String(signal));
    return true;
  }

  /** Simulate the process writing stdout lines (may be partial). */
  writeStdout(chunk: string): void {
    this.stdout.write(chunk);
  }

  /** Simulate normal/abnormal termination: closes streams, sets codes, emits exit. */
  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    // Defer the 'exit' a tick so the readline 'close' is processed first, the
    // way a real child behaves (stdio EOF before the exit notification).
    process.nextTick(() => this.emit('exit', code, signal));
  }
}

let children: FakeChild[] = [];

beforeEach(() => {
  children = [];
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Return the argv passed to the Nth spawn call. */
function spawnArgs(call = 0): string[] {
  return spawnMock.mock.calls[call]![1] as string[];
}

/** Value immediately following `flag` in an argv array, or undefined. */
function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

/** Drain an AgentRun's event stream into an array. */
async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('ClaudeAdapter.run — argv construction', () => {
  it('builds the baseline argv: -p, stream-json, --verbose, --permission-mode', () => {
    const adapter = new ClaudeAdapter();
    adapter.run({ prompt: 'do the thing' });

    const args = spawnArgs();
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe('do the thing');
    expect(valueAfter(args, '--output-format')).toBe('stream-json');
    expect(args).toContain('--verbose');
    // Defaults to bypassPermissions when caller omits permissionMode.
    expect(valueAfter(args, '--permission-mode')).toBe('bypassPermissions');
    // No resume / continue / model when not requested.
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('-c');
    expect(args).not.toContain('--continue');
    expect(args).not.toContain('--model');
  });

  it('honours an explicit permissionMode', () => {
    new ClaudeAdapter().run({ prompt: 'p', permissionMode: 'plan' });
    expect(valueAfter(spawnArgs(), '--permission-mode')).toBe('plan');
  });

  it('with session_id uses --resume <id> and never -c/--continue', () => {
    new ClaudeAdapter().run({ prompt: 'p', sessionId: 'sess-xyz' });
    const args = spawnArgs();
    expect(valueAfter(args, '--resume')).toBe('sess-xyz');
    expect(args).not.toContain('-c');
    expect(args).not.toContain('--continue');
  });

  it('with model passes --model <model>', () => {
    new ClaudeAdapter().run({ prompt: 'p', model: 'claude-opus-4-8' });
    expect(valueAfter(spawnArgs(), '--model')).toBe('claude-opus-4-8');
  });

  it('binary resolves: explicit > CLAUDE_BIN env > default "claude"', () => {
    const orig = process.env.CLAUDE_BIN;
    try {
      // 1. no env, no opts → defaults to bare 'claude' (PATH lookup)
      delete process.env.CLAUDE_BIN;
      new ClaudeAdapter().run({ prompt: 'p' });
      expect(spawnMock.mock.calls[0]![0]).toBe('claude');

      // 2. CLAUDE_BIN env wins over the default
      spawnMock.mockClear();
      process.env.CLAUDE_BIN = '/opt/nvm/bin/claude';
      new ClaudeAdapter().run({ prompt: 'p' });
      expect(spawnMock.mock.calls[0]![0]).toBe('/opt/nvm/bin/claude');

      // 3. explicit opts.binary wins over env
      spawnMock.mockClear();
      process.env.CLAUDE_BIN = '/opt/nvm/bin/claude';
      new ClaudeAdapter({ binary: '/usr/local/bin/claude-custom' }).run({ prompt: 'p' });
      expect(spawnMock.mock.calls[0]![0]).toBe('/usr/local/bin/claude-custom');
    } finally {
      if (orig === undefined) delete process.env.CLAUDE_BIN;
      else process.env.CLAUDE_BIN = orig;
    }
  });

  it('with appendSystemPrompt passes the flag; null/undefined skip it', () => {
    new ClaudeAdapter().run({ prompt: 'p', appendSystemPrompt: 'be terse' });
    expect(valueAfter(spawnArgs(0), '--append-system-prompt')).toBe('be terse');

    new ClaudeAdapter().run({ prompt: 'p', appendSystemPrompt: null });
    expect(spawnArgs(1)).not.toContain('--append-system-prompt');

    new ClaudeAdapter().run({ prompt: 'p' });
    expect(spawnArgs(2)).not.toContain('--append-system-prompt');
  });

  it('passes cwd and a custom binary through to spawn', () => {
    new ClaudeAdapter({ binary: '/opt/claude' }).run({ prompt: 'p', cwd: '/tmp/work' });
    expect(spawnMock.mock.calls[0]![0]).toBe('/opt/claude');
    const opts = spawnMock.mock.calls[0]![2] as { cwd?: string; stdio?: unknown };
    expect(opts.cwd).toBe('/tmp/work');
  });
});

describe('ClaudeAdapter.run — stdout parsing', () => {
  it('reassembles a stream-json line split across stdout chunks', async () => {
    const adapter = new ClaudeAdapter();
    const run = adapter.run({ prompt: 'p' });
    const child = children[0]!;

    const collected = collect(run.events);

    // A single JSON line delivered as two chunks split mid-line (before the
    // newline). readline must stitch them back into one line.
    child.writeStdout('{"type":"system","subtype":"init","sess');
    child.writeStdout('ion_id":"s1","model":"claude-opus-4-8"}\n');
    // A second event, also split.
    child.writeStdout('{"type":"assistant","message":{"content":[{"type":"text","te');
    child.writeStdout('xt":"hi"}]}}\n');
    child.finish(0);

    const events = await collected;
    expect(events).toEqual([
      { type: 'system', sessionId: 's1', cwd: undefined, model: 'claude-opus-4-8' },
      { type: 'text', delta: 'hi' },
    ]);
  });

  it('ignores blank and non-JSON stdout lines', async () => {
    const adapter = new ClaudeAdapter();
    const run = adapter.run({ prompt: 'p' });
    const child = children[0]!;
    const collected = collect(run.events);

    child.writeStdout('\n');
    child.writeStdout('not json at all\n');
    child.writeStdout('{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n');
    child.finish(0);

    const events = await collected;
    expect(events).toEqual([{ type: 'text', delta: 'ok' }]);
  });
});

describe('ClaudeAdapter.run — exit / error handling', () => {
  it('non-zero exit yields a trailing error event including stderr detail', async () => {
    const adapter = new ClaudeAdapter();
    const run = adapter.run({ prompt: 'p' });
    const child = children[0]!;
    const collected = collect(run.events);

    child.stderr.write('something broke\n');
    child.finish(2);

    const events = await collected;
    expect(events).toHaveLength(1);
    const err = events[0] as Extract<AgentEvent, { type: 'error' }>;
    expect(err.type).toBe('error');
    expect(err.message).toContain('code 2');
    expect(err.message).toContain('something broke');
  });

  it('clean exit (code 0) yields no error event', async () => {
    const adapter = new ClaudeAdapter();
    const run = adapter.run({ prompt: 'p' });
    const child = children[0]!;
    const collected = collect(run.events);

    child.writeStdout('{"type":"result","subtype":"success","session_id":"s9"}\n');
    child.finish(0);

    const events = await collected;
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'done', sessionId: 's9' });
  });

  it('spawn failure (no pid + error event) surfaces a single error event', async () => {
    const adapter = new ClaudeAdapter();
    spawnMock.mockImplementationOnce(() => {
      const child = new FakeChild();
      child.pid = undefined; // fork failed synchronously
      children.push(child);
      process.nextTick(() => child.emit('error', new Error('spawn claude ENOENT')));
      return child;
    });

    const run = adapter.run({ prompt: 'p' });
    // Let the deferred 'error' land before draining.
    await new Promise((r) => setTimeout(r, 5));
    const events = await collect(run.events);

    expect(events).toHaveLength(1);
    const err = events[0] as Extract<AgentEvent, { type: 'error' }>;
    expect(err.type).toBe('error');
    expect(err.message).toContain('failed to spawn claude');
    expect(err.message).toContain('ENOENT');
  });
});

describe('ClaudeAdapter.run — stop() signal escalation', () => {
  it('escalates SIGTERM → SIGKILL when the child ignores the grace period', async () => {
    const adapter = new ClaudeAdapter();
    const run = adapter.run({ prompt: 'p', stopGraceMs: 30 });
    const child = children[0]!;

    // Child never exits → grace timer must fire and escalate.
    await run.stop();
    expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('sends only SIGTERM when the child exits within the grace period', async () => {
    const adapter = new ClaudeAdapter();
    const run = adapter.run({ prompt: 'p', stopGraceMs: 1000 });
    const child = children[0]!;

    const stopping = run.stop();
    // Exit promptly, before the (long) grace timer fires.
    child.finish(143, 'SIGTERM');
    await stopping;

    expect(child.killSignals).toEqual(['SIGTERM']);
  });

  it('stop() is a no-op once the child has already exited', async () => {
    const adapter = new ClaudeAdapter();
    const run = adapter.run({ prompt: 'p' });
    const child = children[0]!;

    child.finish(0);
    await new Promise((r) => setTimeout(r, 5)); // let exit land
    await run.stop();
    expect(child.killSignals).toEqual([]);
  });
});

describe('ClaudeAdapter.isAvailable', () => {
  it('resolves true when `claude --version` exits 0', async () => {
    const adapter = new ClaudeAdapter();
    const p = adapter.isAvailable();
    const child = children[0]!;
    expect(spawnArgs()).toEqual(['--version']);
    child.emit('exit', 0, null);
    expect(await p).toBe(true);
  });

  it('resolves false on a non-zero version exit', async () => {
    const adapter = new ClaudeAdapter();
    const p = adapter.isAvailable();
    children[0]!.emit('exit', 1, null);
    expect(await p).toBe(false);
  });

  it('resolves false when spawn errors (binary missing)', async () => {
    const adapter = new ClaudeAdapter();
    const p = adapter.isAvailable();
    children[0]!.emit('error', new Error('ENOENT'));
    expect(await p).toBe(false);
  });
});
