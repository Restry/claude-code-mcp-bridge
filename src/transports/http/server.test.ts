import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttpServer } from './server';
import { renderDashboard } from './dashboard';

describe('renderDashboard', () => {
  it('embeds the MCP endpoint and lists the tools', () => {
    const html = renderDashboard({ mcpPath: '/mcp', port: 9000, host: '127.0.0.1' });
    expect(html).toContain('http://127.0.0.1:9000/mcp');
    expect(html).toContain('claude_sessions');
    expect(html).toContain('streamable-http');
    expect(html).toContain('/api/state');
  });
});

describe('HTTP server (live, ephemeral port)', () => {
  let base: string;
  let stop: (() => Promise<void>) | undefined;
  let storeDir: string;

  beforeEach(async () => {
    storeDir = mkdtempSync(join(tmpdir(), 'http-srv-'));
    const port = 8000 + Math.floor(Math.random() * 1500);
    base = `http://127.0.0.1:${port}`;
    await startHttpServer({
      port,
      host: '127.0.0.1',
      cwdRoots: [tmpdir()],
      sessionStorePath: join(storeDir, 'sessions.json'),
    });
    // startHttpServer registers SIGINT/SIGTERM that call process.exit; for tests
    // we just leave the listener up and rely on the process ending. No explicit
    // close handle is exposed, so we don't set `stop` — the OS reclaims the port
    // when vitest's worker exits. Each test uses a fresh random port.
    stop = undefined;
  });

  afterEach(() => {
    rmSync(storeDir, { recursive: true, force: true });
    return stop?.();
  });

  it('serves /healthz and /api/state', async () => {
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true });
    const state = (await (await fetch(`${base}/api/state`)).json()) as any;
    expect(state.counts).toEqual({ sessions: 0, tasks: 0, running: 0 });
    expect(state.server.name).toBe('claude-code-bridge');
  });

  it('serves the dashboard HTML at /', async () => {
    const res = await fetch(`${base}/`);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('claude-code-mcp-bridge');
  });

  it('speaks MCP over Streamable HTTP and exposes all 9 tools', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
    const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toContain('claude_run');
    expect(names).toContain('claude_sessions');
    expect(names).toHaveLength(9);
    await client.close();
  });

  it('rejects a non-initialize MCP POST without a session', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(400);
  });
});
