#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import pkg from '../../package.json';
import { runMcp } from './commands/mcp';

const DEFAULT_CWD_ROOT = join(homedir(), 'Projects');
const DEFAULT_SESSION_STORE = join(homedir(), '.claude-code-mcp-bridge', 'sessions.json');

const program = new Command();

program
  .name('claude-code-mcp-bridge')
  .description('Expose the local Claude Code CLI as MCP tools over stdio')
  .version(pkg.version, '-v, --version');

program
  .command('mcp')
  .description('Start a stdio MCP server exposing claude_run / status / wait / cancel / list / forget')
  .option(
    '--cwd <path>',
    'default working directory for tasks when a caller omits one',
  )
  .option(
    '--cwd-root <path>',
    'restrict task cwds to this root (repeatable). Defaults to ~/Projects.',
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
  )
  .option(
    '--require-notify-target',
    'reject claude_run calls that omit notify_target (forces callers to wire up end-of-task notifications)',
    false,
  )
  .option(
    '--session-store <path>',
    'path to the durable session registry JSON file. Defaults to ~/.claude-code-mcp-bridge/sessions.json. Pass "none" to disable persistence.',
    DEFAULT_SESSION_STORE,
  )
  .action(async (opts: { cwd?: string; cwdRoot: string[]; requireNotifyTarget?: boolean; sessionStore: string }) => {
    const cwdRoot = opts.cwdRoot.length > 0 ? opts.cwdRoot : [DEFAULT_CWD_ROOT];
    const sessionStorePath = opts.sessionStore === 'none' ? undefined : opts.sessionStore;
    await runMcp({ cwd: opts.cwd, cwdRoot, requireNotifyTarget: opts.requireNotifyTarget, sessionStorePath });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
