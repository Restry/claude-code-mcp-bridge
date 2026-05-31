import { startMcpServer } from '../../transports/mcp/server';

export interface RunMcpOptions {
  cwd?: string;
  cwdRoot?: string[];
}

export async function runMcp(opts: RunMcpOptions): Promise<void> {
  // The MCP stdio transport owns stdout — any logger output on stdout would
  // corrupt the JSON-RPC stream. The shared logger writes to stderr in this
  // project (see core/logger.ts), so we don't need to silence it; just make
  // sure new code paths don't accidentally console.log.
  await startMcpServer({
    defaultCwd: opts.cwd,
    cwdRoots: opts.cwdRoot && opts.cwdRoot.length > 0 ? opts.cwdRoot : undefined,
  });
}
