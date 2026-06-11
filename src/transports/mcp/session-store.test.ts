import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore } from './session-store';
import type { TaskSnapshot } from './task-registry';

function snap(over: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    taskId: 'task-1',
    status: 'running',
    cwd: '/tmp/proj',
    sessionId: 'sess-abc',
    model: 'claude-x',
    startedAt: Date.now(),
    text: '',
    counters: { events: 0, toolUses: 0, toolResults: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    ...over,
  };
}

describe('SessionStore (in-memory)', () => {
  it('ignores snapshots without a session id', () => {
    const s = new SessionStore();
    s.upsert(snap({ sessionId: undefined }), 'hi');
    expect(s.list()).toHaveLength(0);
  });

  it('creates a record and slices prompt/text excerpts', () => {
    const s = new SessionStore();
    s.upsert(snap({ status: 'running', text: 'x'.repeat(900) }), 'p'.repeat(400));
    const rec = s.list()[0]!;
    expect(rec.session_id).toBe('sess-abc');
    expect(rec.status).toBe('running');
    expect(rec.run_count).toBe(1);
    expect(rec.last_prompt?.length).toBe(200);
    expect(rec.last_text_excerpt?.length).toBe(500);
  });

  it('does not double-count run_count across phases of one task', () => {
    const s = new SessionStore();
    s.upsert(snap({ status: 'running' }), 'p'); // session learned mid-run
    s.upsert(snap({ status: 'done', text: 'final' }), 'p'); // terminal, same task
    const rec = s.list()[0]!;
    expect(rec.run_count).toBe(1);
    expect(rec.status).toBe('done');
    expect(rec.last_text_excerpt).toBe('final');
  });

  it('increments run_count when a new task touches the same session', () => {
    const s = new SessionStore();
    s.upsert(snap({ taskId: 't1', status: 'done' }), 'p1');
    s.upsert(snap({ taskId: 't2', status: 'done' }), 'p2');
    const rec = s.list()[0]!;
    expect(rec.run_count).toBe(2);
    expect(rec.last_task_id).toBe('t2');
    expect(rec.last_prompt).toBe('p2');
  });

  it('preserves created_at but advances updated_at', async () => {
    const s = new SessionStore();
    s.upsert(snap({ taskId: 't1', status: 'done' }), 'p1');
    const first = s.get('sess-abc')!;
    await new Promise((r) => setTimeout(r, 5));
    s.upsert(snap({ taskId: 't2', status: 'done' }), 'p2');
    const second = s.get('sess-abc')!;
    expect(second.created_at).toBe(first.created_at);
    expect(second.updated_at).toBeGreaterThanOrEqual(first.updated_at);
  });

  it('records last_error only for failed/cancelled runs', () => {
    const s = new SessionStore();
    s.upsert(snap({ status: 'error', exitError: 'boom' }), 'p');
    expect(s.get('sess-abc')!.last_error).toBe('boom');
    s.upsert(snap({ taskId: 't2', status: 'done', text: 'ok' }), 'p');
    expect(s.get('sess-abc')!.last_error).toBeUndefined();
  });

  it('forgets a session', () => {
    const s = new SessionStore();
    s.upsert(snap(), 'p');
    expect(s.forget('sess-abc')).toBe(true);
    expect(s.forget('sess-abc')).toBe(false);
    expect(s.list()).toHaveLength(0);
  });

  it('sorts list by updated_at desc', async () => {
    const s = new SessionStore();
    s.upsert(snap({ sessionId: 'a', taskId: 'ta', status: 'done' }), 'p');
    await new Promise((r) => setTimeout(r, 5));
    s.upsert(snap({ sessionId: 'b', taskId: 'tb', status: 'done' }), 'p');
    expect(s.list().map((r) => r.session_id)).toEqual(['b', 'a']);
  });
});

describe('SessionStore (persistent)', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sess-store-'));
    file = join(dir, 'nested', 'sessions.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes to disk (creating parent dirs) and reloads on a fresh instance', () => {
    const a = new SessionStore(file);
    a.upsert(snap({ status: 'done', text: 'hello' }), 'do a thing');
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    expect(onDisk.version).toBe(1);
    expect(onDisk.sessions[0].session_id).toBe('sess-abc');

    const b = new SessionStore(file);
    const rec = b.get('sess-abc');
    expect(rec?.status).toBe('done');
    expect(rec?.last_text_excerpt).toBe('hello');
  });

  it('starts empty on a missing file and survives a corrupt file', () => {
    const fresh = new SessionStore(join(dir, 'does-not-exist.json'));
    expect(fresh.list()).toHaveLength(0);

    const corrupt = join(dir, 'corrupt.json');
    writeFileSync(corrupt, '{not valid json', 'utf8');
    const loaded = new SessionStore(corrupt);
    expect(loaded.list()).toHaveLength(0);
  });
});
