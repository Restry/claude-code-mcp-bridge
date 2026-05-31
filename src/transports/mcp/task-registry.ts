import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../../agent/types';

export type TaskStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface TaskEventRecord {
  /** Monotonic per-task sequence, 0-based. Lets callers ask for events > cursor. */
  seq: number;
  ts: number;
  event: AgentEvent;
}

export interface TaskSnapshot {
  taskId: string;
  status: TaskStatus;
  cwd: string;
  sessionId?: string;
  model?: string;
  startedAt: number;
  endedAt?: number;
  exitError?: string;
  /** Concatenated assistant text deltas so far (final answer when done). */
  text: string;
  /** Most recent in-flight tool name, or undefined. */
  currentTool?: string;
  /** Counters useful for UIs. */
  counters: {
    events: number;
    toolUses: number;
    toolResults: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
}

interface InternalTask {
  snapshot: TaskSnapshot;
  events: TaskEventRecord[];
  /** Monotonic across the task's lifetime — survives buffer truncation. */
  nextSeq: number;
  /** Lowest seq still retained in `events` after trimming. */
  oldestSeq: number;
  run: AgentRun;
  /** Resolves when consumeEvents() finishes draining the AsyncIterable. */
  finished: Promise<void>;
  /** Resolvers waiting on new events / completion (used by claude_wait). */
  waiters: Array<{
    fromSeq: number;
    resolve: (records: TaskEventRecord[]) => void;
    timer?: NodeJS.Timeout;
  }>;
}

const MAX_EVENT_BUFFER = 5000;

/**
 * In-memory registry of async Claude tasks for the MCP stdio server.
 *
 * IMPORTANT — lifecycle & persistence boundary (verified by integration tests):
 * task state lives entirely in `this.tasks` (a plain Map). The MCP server is
 * stdio, so this registry's lifetime is bound to a single client connection —
 * when the server process exits, every task record is gone. A second client
 * connection gets a fresh, empty registry; there is NO cross-process or
 * cross-restart visibility, and two clients never share a task view.
 *
 * This is a session-scoped scheduler, not a durable queue. Making tasks
 * survive restarts (or be shared across clients) means spilling this Map to
 * disk/SQLite and rehydrating on startup — intentionally out of scope here.
 */
export class TaskRegistry {
  private readonly tasks = new Map<string, InternalTask>();

  constructor(private readonly adapter: AgentAdapter) {}

  start(opts: AgentRunOptions): TaskSnapshot {
    const taskId = randomUUID();
    const run = this.adapter.run(opts);

    const snapshot: TaskSnapshot = {
      taskId,
      status: 'running',
      cwd: opts.cwd ?? process.cwd(),
      model: opts.model,
      sessionId: opts.sessionId,
      startedAt: Date.now(),
      text: '',
      counters: { events: 0, toolUses: 0, toolResults: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    };

    const task: InternalTask = {
      snapshot,
      events: [],
      nextSeq: 0,
      oldestSeq: 0,
      run,
      waiters: [],
      finished: Promise.resolve(),
    };
    this.tasks.set(taskId, task);

    task.finished = this.consumeEvents(task);
    return snapshot;
  }

  get(taskId: string): TaskSnapshot | undefined {
    return this.tasks.get(taskId)?.snapshot;
  }

  list(): TaskSnapshot[] {
    return Array.from(this.tasks.values()).map((t) => t.snapshot);
  }

  /**
   * Return events strictly after `fromSeq`. If none are available and the task
   * is still running, wait up to `timeoutMs` for new events. Returns immediately
   * when the task reaches a terminal state, with whatever events are available.
   */
  waitForEvents(taskId: string, fromSeq: number, timeoutMs: number): Promise<TaskEventRecord[]> {
    const task = this.tasks.get(taskId);
    if (!task) return Promise.resolve([]);

    const available = task.events.filter((e) => e.seq > fromSeq);
    if (available.length > 0 || task.snapshot.status !== 'running') {
      return Promise.resolve(available);
    }

    return new Promise((resolve) => {
      const waiter: InternalTask['waiters'][number] = { fromSeq, resolve };
      waiter.timer = setTimeout(() => {
        const idx = task.waiters.indexOf(waiter);
        if (idx !== -1) task.waiters.splice(idx, 1);
        resolve(task.events.filter((e) => e.seq > fromSeq));
      }, timeoutMs);
      task.waiters.push(waiter);
    });
  }

  async cancel(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.snapshot.status !== 'running') return false;
    task.snapshot.status = 'cancelled';
    await task.run.stop();
    return true;
  }

  /** Drop a finished task from memory. */
  forget(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.snapshot.status === 'running') return false;
    this.tasks.delete(taskId);
    return true;
  }

  async shutdown(): Promise<void> {
    const running = Array.from(this.tasks.values()).filter((t) => t.snapshot.status === 'running');
    await Promise.all(running.map((t) => t.run.stop()));
    await Promise.all(Array.from(this.tasks.values()).map((t) => t.finished));
  }

  private async consumeEvents(task: InternalTask): Promise<void> {
    try {
      for await (const event of task.run.events) {
        this.recordEvent(task, event);
      }
      if (task.snapshot.status === 'running') task.snapshot.status = 'done';
    } catch (err) {
      // Don't clobber a terminal status set by cancel() or an inline 'error' event.
      if (task.snapshot.status === 'running') {
        task.snapshot.status = 'error';
      }
      if (!task.snapshot.exitError) {
        task.snapshot.exitError = err instanceof Error ? err.message : String(err);
      }
    } finally {
      // Give the child process a moment to exit cleanly after the terminal
      // stream event. The adapter already implements this graceful wait.
      try {
        await task.run.waitForExit(2000);
      } catch {
        /* ignore */
      }
      task.snapshot.endedAt = Date.now();
      this.flushWaiters(task);
    }
  }

  private recordEvent(task: InternalTask, event: AgentEvent): void {
    const seq = task.nextSeq++;
    const record: TaskEventRecord = { seq, ts: Date.now(), event };
    task.events.push(record);
    if (task.events.length > MAX_EVENT_BUFFER) {
      const dropCount = task.events.length - MAX_EVENT_BUFFER;
      task.events.splice(0, dropCount);
      task.oldestSeq = task.events[0]?.seq ?? task.nextSeq;
    }
    this.updateSnapshot(task, event);
    this.flushWaiters(task);
  }

  private updateSnapshot(task: InternalTask, event: AgentEvent): void {
    const s = task.snapshot;
    s.counters.events += 1;
    switch (event.type) {
      case 'system':
        if (event.sessionId) s.sessionId = event.sessionId;
        if (event.model) s.model = event.model;
        if (event.cwd) s.cwd = event.cwd;
        break;
      case 'text':
        s.text += event.delta;
        break;
      case 'tool_use':
        s.counters.toolUses += 1;
        s.currentTool = event.name;
        break;
      case 'tool_result':
        s.counters.toolResults += 1;
        s.currentTool = undefined;
        break;
      case 'usage':
        if (event.inputTokens) s.counters.inputTokens += event.inputTokens;
        if (event.outputTokens) s.counters.outputTokens += event.outputTokens;
        if (event.costUsd) s.counters.costUsd += event.costUsd;
        break;
      case 'done':
        if (event.sessionId) s.sessionId = event.sessionId;
        break;
      case 'error':
        if (s.status === 'running') s.status = 'error';
        s.exitError = event.message;
        break;
    }
  }

  private flushWaiters(task: InternalTask): void {
    if (task.waiters.length === 0) return;
    const stillWaiting: InternalTask['waiters'] = [];
    for (const waiter of task.waiters) {
      const newer = task.events.filter((e) => e.seq > waiter.fromSeq);
      if (newer.length > 0 || task.snapshot.status !== 'running') {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.resolve(newer);
      } else {
        stillWaiting.push(waiter);
      }
    }
    task.waiters = stillWaiting;
  }
}
