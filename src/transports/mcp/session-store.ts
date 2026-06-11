import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from '../../core/logger';
import type { TaskSnapshot, TaskStatus } from './task-registry';

/**
 * A durable record of a Claude Code session, keyed by the session_id that the
 * `claude` CLI assigns. Unlike a task (in-memory, per-connection, ephemeral),
 * a session survives bridge restarts and is shared across every MCP client
 * that points at the same store file. This is what lets any client discover
 * "which sessions exist, what's their last status, and what id to --resume".
 */
export interface SessionRecord {
  session_id: string;
  cwd: string;
  model?: string;
  /** Status of the most recent run on this session. */
  status: TaskStatus;
  /** task_id of the most recent run (lets us dedupe run counting). */
  last_task_id: string;
  /** How many distinct runs have touched this session. */
  run_count: number;
  created_at: number;
  updated_at: number;
  /** First slice of the most recent prompt, for human disambiguation. */
  last_prompt?: string;
  /** First slice of the last run's final text. */
  last_text_excerpt?: string;
  /** Last error message, when the most recent run failed. */
  last_error?: string;
}

interface PersistShape {
  version: 1;
  sessions: SessionRecord[];
}

const PROMPT_EXCERPT = 200;
const TEXT_EXCERPT = 500;

/**
 * Persistent, process-wide session registry. Backed by a JSON file written
 * atomically (temp + rename). When constructed without a path it stays purely
 * in-memory — handy for tests and for callers that opt out of persistence.
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(private readonly filePath?: string) {
    if (filePath) this.load();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath!, 'utf8');
      const parsed = JSON.parse(raw) as PersistShape;
      if (parsed && Array.isArray(parsed.sessions)) {
        for (const rec of parsed.sessions) {
          if (rec && typeof rec.session_id === 'string') this.sessions.set(rec.session_id, rec);
        }
      }
    } catch (err) {
      // Missing file is normal on first run; corrupt file shouldn't crash the
      // server — start empty and log so it's diagnosable.
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') {
        log.warn('session-store', 'load-failed', { err: e.message, path: this.filePath });
      }
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    const shape: PersistShape = {
      version: 1,
      sessions: Array.from(this.sessions.values()).sort((a, b) => b.updated_at - a.updated_at),
    };
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(shape, null, 2), 'utf8');
      renameSync(tmp, this.filePath);
    } catch (err) {
      log.warn('session-store', 'persist-failed', {
        err: err instanceof Error ? err.message : String(err),
        path: this.filePath,
      });
    }
  }

  /**
   * Insert or update the record for a snapshot's session. No-op when the
   * snapshot has no session_id yet (a brand-new run before claude assigns one).
   * Safe to call multiple times per run — run_count only increments when a new
   * task_id touches the session.
   */
  upsert(snapshot: TaskSnapshot, prompt?: string): void {
    const id = snapshot.sessionId;
    if (!id) return;
    const now = Date.now();
    const existing = this.sessions.get(id);
    const isNewRun = !existing || existing.last_task_id !== snapshot.taskId;
    const record: SessionRecord = {
      session_id: id,
      cwd: snapshot.cwd,
      model: snapshot.model ?? existing?.model,
      status: snapshot.status,
      last_task_id: snapshot.taskId,
      run_count: (existing?.run_count ?? 0) + (isNewRun ? 1 : 0),
      created_at: existing?.created_at ?? now,
      updated_at: now,
      last_prompt: prompt ? prompt.slice(0, PROMPT_EXCERPT) : existing?.last_prompt,
      last_text_excerpt: snapshot.text
        ? snapshot.text.trim().slice(0, TEXT_EXCERPT)
        : existing?.last_text_excerpt,
      last_error:
        snapshot.status === 'error' || snapshot.status === 'cancelled'
          ? snapshot.exitError ?? existing?.last_error
          : undefined,
    };
    this.sessions.set(id, record);
    this.persist();
  }

  list(): SessionRecord[] {
    return Array.from(this.sessions.values()).sort((a, b) => b.updated_at - a.updated_at);
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  forget(sessionId: string): boolean {
    const had = this.sessions.delete(sessionId);
    if (had) this.persist();
    return had;
  }
}
