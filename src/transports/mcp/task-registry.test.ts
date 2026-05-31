import { describe, expect, it } from 'vitest';
import { TaskRegistry } from './task-registry';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../../agent/types';

/** Push-driven controllable AgentRun for testing. */
class ControlledRun implements AgentRun {
  private readonly buffer: AgentEvent[] = [];
  private pendingResolve: ((v: IteratorResult<AgentEvent>) => void) | null = null;
  private pendingReject: ((err: unknown) => void) | null = null;
  private exited = false;
  private stopRequested = false;
  private pendingFailure: Error | null = null;

  events: AsyncIterable<AgentEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<AgentEvent>> => {
        if (this.pendingFailure) {
          const err = this.pendingFailure;
          this.pendingFailure = null;
          return Promise.reject(err);
        }
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.exited) {
          return Promise.resolve({ value: undefined as unknown as AgentEvent, done: true });
        }
        return new Promise((resolve, reject) => {
          this.pendingResolve = resolve;
          this.pendingReject = reject;
        });
      },
    }),
  };

  push(event: AgentEvent): void {
    if (this.pendingResolve) {
      const r = this.pendingResolve;
      this.pendingResolve = null;
      this.pendingReject = null;
      r({ value: event, done: false });
    } else {
      this.buffer.push(event);
    }
  }

  fail(err: Error): void {
    if (this.pendingReject) {
      const rj = this.pendingReject;
      this.pendingResolve = null;
      this.pendingReject = null;
      rj(err);
    } else {
      this.pendingFailure = err;
    }
  }

  end(): void {
    this.exited = true;
    if (this.pendingResolve) {
      const r = this.pendingResolve;
      this.pendingResolve = null;
      this.pendingReject = null;
      r({ value: undefined as unknown as AgentEvent, done: true });
    }
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.end();
  }

  async waitForExit(): Promise<boolean> {
    return this.exited;
  }

  get wasStopped(): boolean {
    return this.stopRequested;
  }
}

function makeAdapter(): { adapter: AgentAdapter; runs: ControlledRun[] } {
  const runs: ControlledRun[] = [];
  return {
    runs,
    adapter: {
      id: 'fake',
      displayName: 'fake',
      isAvailable: async () => true,
      run(_opts: AgentRunOptions): AgentRun {
        const run = new ControlledRun();
        runs.push(run);
        return run;
      },
    },
  };
}

const microtask = () => new Promise<void>((r) => setImmediate(r));

describe('TaskRegistry', () => {
  it('seq stays monotonic and unique across buffer truncation (>MAX_EVENT_BUFFER events)', async () => {
    const { adapter, runs } = makeAdapter();
    const reg = new TaskRegistry(adapter);
    const snap = reg.start({ prompt: 'x' });
    const run = runs[0]!;

    const TOTAL = 5200; // > MAX_EVENT_BUFFER (5000)
    for (let i = 0; i < TOTAL; i++) run.push({ type: 'text', delta: 'x' });
    run.end();

    // Wait until consumer drains and task reaches terminal state.
    for (let i = 0; i < 50; i++) {
      await microtask();
      if (reg.get(snap.taskId)!.status !== 'running') break;
    }
    const final = reg.get(snap.taskId)!;
    expect(final.status).toBe('done');
    expect(final.counters.events).toBe(TOTAL);

    // Pull whatever is still in the (truncated) buffer and verify seqs.
    const tail = await reg.waitForEvents(snap.taskId, -1, 100);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.length).toBeLessThanOrEqual(5000);
    const seqs = tail.map((r) => r.seq);
    const dedup = new Set(seqs);
    expect(dedup.size).toBe(seqs.length); // no duplicates
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]!).toBe(seqs[i - 1]! + 1); // strictly +1
    }
    // Latest event must have seq = TOTAL - 1 (proves no collision after trim).
    expect(seqs[seqs.length - 1]).toBe(TOTAL - 1);
  });

  it('cancel() locks status as cancelled even if iterator later throws', async () => {
    const { adapter, runs } = makeAdapter();
    const reg = new TaskRegistry(adapter);
    const snap = reg.start({ prompt: 'x' });
    const run = runs[0]!;

    run.push({ type: 'text', delta: 'hi' });
    await microtask();

    // Cancel before iterator throws.
    await reg.cancel(snap.taskId);
    expect(reg.get(snap.taskId)!.status).toBe('cancelled');

    // Now simulate the underlying iterator dying with an error.
    run.fail(new Error('process died after cancel'));
    for (let i = 0; i < 10; i++) await microtask();

    const s = reg.get(snap.taskId)!;
    expect(s.status).toBe('cancelled'); // must NOT have been overwritten to 'error'
    expect(run.wasStopped).toBe(true);
  });

  /** Drive the consumer until the task leaves the running state. */
  async function drainToTerminal(reg: TaskRegistry, taskId: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
      await microtask();
      if (reg.get(taskId)!.status !== 'running') return;
    }
    throw new Error('task did not reach a terminal state');
  }

  it('waitForEvents honours oldestSeq after ring-buffer trimming', async () => {
    const { adapter, runs } = makeAdapter();
    const reg = new TaskRegistry(adapter);
    const snap = reg.start({ prompt: 'x' });
    const run = runs[0]!;

    const TOTAL = 5200; // > MAX_EVENT_BUFFER (5000) → 200 oldest events trimmed
    for (let i = 0; i < TOTAL; i++) run.push({ type: 'text', delta: 'x' });
    run.end();
    await drainToTerminal(reg, snap.taskId);

    // from_seq below the trimmed window: you get the surviving buffer only —
    // dropped events are NOT replayed, the window simply starts at oldestSeq.
    const fromBelow = await reg.waitForEvents(snap.taskId, -1, 50);
    expect(fromBelow).toHaveLength(5000);
    expect(fromBelow[0]!.seq).toBe(200); // oldestSeq, not 0
    expect(fromBelow.at(-1)!.seq).toBe(TOTAL - 1);

    // from_seq sitting above oldestSeq, mid-buffer: a precise tail slice.
    const tail = await reg.waitForEvents(snap.taskId, 5000, 50);
    expect(tail.map((r) => r.seq)).toEqual(
      Array.from({ length: 199 }, (_, i) => 5001 + i),
    );

    // from_seq at/after the latest seq on a terminal task: empty, no blocking.
    expect(await reg.waitForEvents(snap.taskId, TOTAL - 1, 50)).toEqual([]);
    expect(await reg.waitForEvents(snap.taskId, 99999, 50)).toEqual([]);
  });

  it('waitForEvents resolves empty after timeout when no new events arrive', async () => {
    const { adapter, runs } = makeAdapter();
    const reg = new TaskRegistry(adapter);
    const snap = reg.start({ prompt: 'x' });
    const run = runs[0]!;

    run.push({ type: 'text', delta: 'first' });
    await microtask(); // let the single event get recorded (seq 0)

    const started = Date.now();
    const out = await reg.waitForEvents(snap.taskId, 0, 80); // nothing with seq > 0
    const elapsed = Date.now() - started;

    expect(out).toEqual([]);
    expect(elapsed).toBeGreaterThanOrEqual(60); // actually waited out the timer
    expect(reg.get(snap.taskId)!.status).toBe('running'); // still running, not terminal

    run.end(); // cleanup the pending consumer
    await drainToTerminal(reg, snap.taskId);
  });

  it('a burst of concurrent waiters on the same cursor are all woken by one event', async () => {
    const { adapter, runs } = makeAdapter();
    const reg = new TaskRegistry(adapter);
    const snap = reg.start({ prompt: 'x' });
    const run = runs[0]!;

    // No events yet + running → each call parks a waiter.
    const waiters = [
      reg.waitForEvents(snap.taskId, -1, 1000),
      reg.waitForEvents(snap.taskId, -1, 1000),
      reg.waitForEvents(snap.taskId, -1, 1000),
    ];
    await microtask(); // ensure all three are registered before the event lands

    run.push({ type: 'text', delta: 'wake' });
    const results = await Promise.all(waiters);

    for (const r of results) {
      expect(r).toHaveLength(1);
      expect(r[0]!.seq).toBe(0);
      expect(r[0]!.event).toEqual({ type: 'text', delta: 'wake' });
    }

    run.end();
    await drainToTerminal(reg, snap.taskId);
  });

  it('cancelled status is sticky and gates double-cancel / forget', async () => {
    const { adapter, runs } = makeAdapter();
    const reg = new TaskRegistry(adapter);
    const snap = reg.start({ prompt: 'x' });
    const run = runs[0]!;

    run.push({ type: 'text', delta: 'hi' });
    await microtask();

    // forget is a no-op while running.
    expect(reg.forget(snap.taskId)).toBe(false);

    expect(await reg.cancel(snap.taskId)).toBe(true);
    expect(reg.get(snap.taskId)!.status).toBe('cancelled');

    // A *natural* end of the stream after cancel must not flip it to 'done'.
    run.end();
    await drainToTerminal(reg, snap.taskId);
    expect(reg.get(snap.taskId)!.status).toBe('cancelled');

    // Cancelling an already-terminal task is a no-op (returns false).
    expect(await reg.cancel(snap.taskId)).toBe(false);

    // forget now succeeds; a second forget finds nothing.
    expect(reg.forget(snap.taskId)).toBe(true);
    expect(reg.forget(snap.taskId)).toBe(false);
    expect(reg.get(snap.taskId)).toBeUndefined();
  });
});
