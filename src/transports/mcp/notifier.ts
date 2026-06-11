import { spawn } from 'node:child_process';
import { log } from '../../core/logger';
import type { TaskSnapshot } from './task-registry';

export interface NotifyTarget {
  type: 'feishu';
  chat_id?: string;
  anchor_msg_id?: string;
  reply_in_thread?: boolean;
  as_identity?: 'bot' | 'user';
  notify_on_start?: boolean;
  /**
   * Which lark-cli credential store to notify from. lark-cli picks its config
   * dir from HERMES_HOME, so different clients (Pi, Hermes) authenticate as
   * different Feishu apps/bots. In a SHARED daemon the notifier runs in one
   * process, so each task must carry the home of the identity that is actually
   * a member of the target chat — otherwise Feishu rejects with 230002
   * "Bot/User can NOT be out of the chat". When omitted, the daemon's own
   * environment is used.
   */
  lark_home?: string;
}

const LARK_BIN = process.env.LARK_CLI_BIN ?? 'lark-cli';

/**
 * Fire-and-forget notification. Logs failures but never throws — a broken
 * notifier must not crash the MCP server or block task cleanup.
 */
export async function fireFeishuNotification(
  target: NotifyTarget,
  snapshot: TaskSnapshot,
  kind: 'start' | 'end',
): Promise<void> {
  if (target.type !== 'feishu') return;

  const content = renderMessage(snapshot, kind);
  const asWho = target.as_identity ?? 'user';

  const args: string[] = ['im'];
  if (kind === 'end' && target.reply_in_thread && target.anchor_msg_id) {
    args.push('+messages-reply', '--message-id', target.anchor_msg_id, '--reply-in-thread');
  } else if (kind === 'start' && target.anchor_msg_id) {
    // Start notification: reply to anchor (in thread if requested) — gives a thread-anchored "task started" pin
    args.push('+messages-reply', '--message-id', target.anchor_msg_id);
    if (target.reply_in_thread) args.push('--reply-in-thread');
  } else if (target.chat_id) {
    args.push('+messages-send', '--chat-id', target.chat_id);
  } else {
    log.warn('notifier', 'no-target-resolved', { target, kind });
    return;
  }
  args.push('--as', asWho, '--markdown', content);

  await runLarkCli(args, target.lark_home).catch((err) => {
    log.warn('notifier', 'lark-cli-failed', {
      err: err instanceof Error ? err.message : String(err),
      taskId: snapshot.taskId,
      kind,
    });
  });
}

export function renderMessage(s: TaskSnapshot, kind: 'start' | 'end'): string {
  if (kind === 'start') {
    return [
      `🚀 **CC 任务已派出**`,
      ``,
      `- task_id: \`${s.taskId}\``,
      `- cwd: \`${s.cwd}\``,
      s.model ? `- model: \`${s.model}\`` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  // end
  const durMs = (s.endedAt ?? Date.now()) - s.startedAt;
  const dur = formatDuration(durMs);
  const icon = s.status === 'done' ? '✅' : s.status === 'error' ? '❌' : '⛔';
  const title =
    s.status === 'done'
      ? 'CC 任务完成'
      : s.status === 'error'
        ? 'CC 任务失败'
        : 'CC 任务被取消';

  const head = [
    `${icon} **${title}**`,
    ``,
    `- task_id: \`${s.taskId}\``,
    `- status: \`${s.status}\``,
    `- duration: ${dur}`,
    `- tools: ${s.counters.toolUses} use / ${s.counters.toolResults} result`,
    `- tokens: ${s.counters.inputTokens} in / ${s.counters.outputTokens} out`,
    s.counters.costUsd > 0 ? `- cost: $${s.counters.costUsd.toFixed(4)}` : '',
    s.exitError ? `- error: \`${truncate(s.exitError, 200)}\`` : '',
  ]
    .filter(Boolean)
    .join('\n');

  // Tail: 1-2KB of final text so 爸爸不用再点开 status
  const tail = s.text.trim();
  if (!tail) return head;

  const tailExcerpt =
    tail.length > 1500
      ? tail.slice(0, 1500) + `\n\n_... (truncated, total ${tail.length} chars)_`
      : tail;

  return `${head}\n\n---\n\n${tailExcerpt}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m${rs}s`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

function runLarkCli(args: string[], larkHome?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = larkHome ? { ...process.env, HERMES_HOME: larkHome } : process.env;
    const child = spawn(LARK_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`lark-cli exited ${code}: ${stderr.trim().slice(0, 500)}`));
    });
  });
}
