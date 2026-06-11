#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import pkg from '../../package.json';
import { runMcp } from './commands/mcp';
import { startHttpServer } from '../transports/http/server';

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

program
  .command('serve')
  .description('Start a long-lived HTTP MCP server (Streamable HTTP) plus a status dashboard. Meant to run once under launchd and be shared by every client.')
  .option('--port <n>', 'TCP port to listen on (default 8787)', (v) => parseInt(v, 10))
  .option('--host <addr>', 'bind address (default 127.0.0.1)')
  .option('--mcp-path <path>', 'path for the MCP JSON-RPC endpoint (default /mcp)')
  .option('--cwd <path>', 'default working directory for tasks when a caller omits one')
  .option(
    '--cwd-root <path>',
    'restrict task cwds to this root (repeatable). Defaults to ~/Projects.',
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
  )
  .option(
    '--session-store <path>',
    'path to the durable session registry JSON file. Defaults to ~/.claude-code-mcp-bridge/sessions.json. Pass "none" to disable persistence.',
    DEFAULT_SESSION_STORE,
  )
  .action(async (opts: { port?: number; host?: string; mcpPath?: string; cwd?: string; cwdRoot: string[]; sessionStore: string }) => {
    const cwdRoot = opts.cwdRoot.length > 0 ? opts.cwdRoot : [DEFAULT_CWD_ROOT];
    const sessionStorePath = opts.sessionStore === 'none' ? undefined : opts.sessionStore;
    await startHttpServer({
      port: opts.port,
      host: opts.host,
      mcpPath: opts.mcpPath,
      defaultCwd: opts.cwd,
      cwdRoots: cwdRoot,
      sessionStorePath,
    });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
