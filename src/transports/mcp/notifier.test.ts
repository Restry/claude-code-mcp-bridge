import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock child_process.spawn before importing the module under test.
const h = vi.hoisted(() => ({
  spawnCalls: [] as Array<{ bin: string; args: string[] }>,
  exitCode: 0 as number | null,
  emitError: false,
}));

vi.mock('node:child_process', () => ({
  spawn: (bin: string, args: string[]) => {
    h.spawnCalls.push({ bin, args });
    const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
    child.stderr = new EventEmitter();
    // Fire async so the .on() handlers are attached first.
    queueMicrotask(() => {
      if (h.emitError) {
        child.emit('error', new Error('spawn failed'));
      } else {
        child.emit('exit', h.exitCode);
      }
    });
    return child;
  },
}));

import { fireFeishuNotification, renderMessage, type NotifyTarget } from './notifier';
import type { TaskSnapshot } from './task-registry';

function snapshot(over: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    taskId: 'task-1',
    status: 'done',
    cwd: '/tmp/work',
    startedAt: 1000,
    endedAt: 4000,
    text: 'final answer',
    counters: { events: 5, toolUses: 2, toolResults: 2, inputTokens: 100, outputTokens: 50, costUsd: 0.0123 },
    ...over,
  };
}

afterEach(() => {
  h.spawnCalls.length = 0;
  h.exitCode = 0;
  h.emitError = false;
});

describe('fireFeishuNotification — lark-cli arg assembly', () => {
  it('reply_in_thread + anchor_msg_id → +messages-reply --reply-in-thread', async () => {
    const target: NotifyTarget = {
      type: 'feishu',
      anchor_msg_id: 'om_abc',
      reply_in_thread: true,
    };
    await fireFeishuNotification(target, snapshot(), 'end');
    expect(h.spawnCalls).toHaveLength(1);
    const { args } = h.spawnCalls[0]!;
    expect(args.slice(0, 5)).toEqual([
      'im',
      '+messages-reply',
      '--message-id',
      'om_abc',
      '--reply-in-thread',
    ]);
    expect(args).toContain('--as');
    expect(args[args.indexOf('--as') + 1]).toBe('bot');
    expect(args).toContain('--markdown');
  });

  it('only chat_id → +messages-send --chat-id', async () => {
    const target: NotifyTarget = { type: 'feishu', chat_id: 'oc_xyz' };
    await fireFeishuNotification(target, snapshot(), 'end');
    expect(h.spawnCalls).toHaveLength(1);
    const { args } = h.spawnCalls[0]!;
    expect(args.slice(0, 4)).toEqual(['im', '+messages-send', '--chat-id', 'oc_xyz']);
    expect(args).not.toContain('--reply-in-thread');
  });

  it('honours as_identity = user', async () => {
    const target: NotifyTarget = { type: 'feishu', chat_id: 'oc_xyz', as_identity: 'user' };
    await fireFeishuNotification(target, snapshot(), 'end');
    const { args } = h.spawnCalls[0]!;
    expect(args[args.indexOf('--as') + 1]).toBe('user');
  });

  it('no chat_id and no anchor → logs warn, does not spawn', async () => {
    const target: NotifyTarget = { type: 'feishu' };
    await fireFeishuNotification(target, snapshot(), 'end');
    expect(h.spawnCalls).toHaveLength(0);
  });

  it('non-feishu type → no-op', async () => {
    const target = { type: 'slack' } as unknown as NotifyTarget;
    await fireFeishuNotification(target, snapshot(), 'end');
    expect(h.spawnCalls).toHaveLength(0);
  });

  it('reply_in_thread without anchor falls back to chat_id send', async () => {
    const target: NotifyTarget = { type: 'feishu', chat_id: 'oc_xyz', reply_in_thread: true };
    await fireFeishuNotification(target, snapshot(), 'end');
    const { args } = h.spawnCalls[0]!;
    expect(args.slice(0, 4)).toEqual(['im', '+messages-send', '--chat-id', 'oc_xyz']);
  });

  it('kind=start with anchor replies to anchor (no thread unless requested)', async () => {
    const target: NotifyTarget = { type: 'feishu', anchor_msg_id: 'om_abc' };
    await fireFeishuNotification(target, snapshot({ status: 'running' }), 'start');
    const { args } = h.spawnCalls[0]!;
    expect(args.slice(0, 4)).toEqual(['im', '+messages-reply', '--message-id', 'om_abc']);
    expect(args).not.toContain('--reply-in-thread');
    const md = args[args.indexOf('--markdown') + 1]!;
    expect(md).toContain('已派出');
  });

  it('never throws when lark-cli exits non-zero', async () => {
    h.exitCode = 2;
    const target: NotifyTarget = { type: 'feishu', chat_id: 'oc_xyz' };
    await expect(fireFeishuNotification(target, snapshot(), 'end')).resolves.toBeUndefined();
  });

  it('never throws when spawn emits error', async () => {
    h.emitError = true;
    const target: NotifyTarget = { type: 'feishu', chat_id: 'oc_xyz' };
    await expect(fireFeishuNotification(target, snapshot(), 'end')).resolves.toBeUndefined();
  });
});

describe('renderMessage', () => {
  it('start message mentions 已派出 with task_id and cwd', () => {
    const md = renderMessage(snapshot({ status: 'running', model: 'claude-opus-4-8' }), 'start');
    expect(md).toContain('🚀');
    expect(md).toContain('已派出');
    expect(md).toContain('task-1');
    expect(md).toContain('/tmp/work');
    expect(md).toContain('claude-opus-4-8');
  });

  it('end message done → ✅ 完成 with counters and tail', () => {
    const md = renderMessage(snapshot(), 'end');
    expect(md).toContain('✅');
    expect(md).toContain('CC 任务完成');
    expect(md).toContain('duration: 3s');
    expect(md).toContain('2 use / 2 result');
    expect(md).toContain('$0.0123');
    expect(md).toContain('final answer');
  });

  it('end message error → ❌ 失败 with error line', () => {
    const md = renderMessage(snapshot({ status: 'error', exitError: 'boom', text: '' }), 'end');
    expect(md).toContain('❌');
    expect(md).toContain('CC 任务失败');
    expect(md).toContain('error: `boom`');
  });

  it('end message cancelled → ⛔ 被取消', () => {
    const md = renderMessage(snapshot({ status: 'cancelled' }), 'end');
    expect(md).toContain('⛔');
    expect(md).toContain('CC 任务被取消');
  });

  it('truncates a long tail', () => {
    const long = 'x'.repeat(3000);
    const md = renderMessage(snapshot({ text: long }), 'end');
    expect(md).toContain('truncated, total 3000 chars');
    expect(md.length).toBeLessThan(3000);
  });
});
