#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import pkg from '../../package.json';
import { runMcp } from './commands/mcp';

const DEFAULT_CWD_ROOT = join(homedir(), 'Projects');

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
  .action(async (opts: { cwd?: string; cwdRoot: string[] }) => {
    const cwdRoot = opts.cwdRoot.length > 0 ? opts.cwdRoot : [DEFAULT_CWD_ROOT];
    await runMcp({ cwd: opts.cwd, cwdRoot });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
