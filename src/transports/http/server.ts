import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { log } from '../../core/logger';
import { ClaudeAdapter } from '../../agent/claude/adapter';
import { TaskRegistry } from '../mcp/task-registry';
import { SessionStore } from '../mcp/session-store';
import { buildServer, snapshotToWire, type McpServerOptions } from '../mcp/server';
import { renderDashboard } from './dashboard';

export interface HttpServerOptions extends McpServerOptions {
  port?: number;
  host?: string;
  /** Path the MCP JSON-RPC endpoint is served at. Default '/mcp'. */
  mcpPath?: string;
}

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '127.0.0.1';

/**
 * Build the live state the dashboard + /api/state expose: one shared task
 * registry (in-progress + finished tasks) and one shared session store.
 */
function buildState(registry: TaskRegistry, store: SessionStore) {
  const tasks = registry.list().map(snapshotToWire);
  return {
    server: { name: 'claude-code-bridge', version: '0.1.0', now: Date.now() },
    counts: {
      sessions: store.list().length,
      tasks: tasks.length,
      running: tasks.filter((t) => t.status === 'running').length,
    },
    tasks,
    sessions: store.list(),
  };
}

function send(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

/**
 * Start the bridge as a long-lived HTTP service. Unlike stdio (one process per
 * client), this is meant to run once (e.g. under launchd) and be shared by
 * every MCP client over Streamable HTTP. All MCP sessions share ONE registry
 * and ONE session store, so tasks and sessions are globally visible. A small
 * dashboard at GET / shows live status; GET /api/state returns it as JSON.
 */
export async function startHttpServer(opts: HttpServerOptions = {}): Promise<void> {
  const port = opts.port ?? DEFAULT_PORT;
  const host = opts.host ?? DEFAULT_HOST;
  const mcpPath = opts.mcpPath ?? '/mcp';

  const adapter = new ClaudeAdapter();
  const sessionStore = new SessionStore(opts.sessionStorePath);
  const registry = new TaskRegistry(adapter, (snapshot, prompt) =>
    sessionStore.upsert(snapshot, prompt),
  );

  // One transport per MCP session id; every transport's Server shares the
  // registry + store singletons above.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  async function handleMcp(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    let transport = sid ? transports.get(sid) : undefined;

    if (!transport) {
      if (req.method !== 'POST' || !isInitializeRequest(body)) {
        send(res, 400, JSON.stringify({ error: 'no valid session; send an initialize request first' }), 'application/json');
        return;
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport!);
          log.info('http', 'mcp-session-open', { id, sessions: transports.size });
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) {
          transports.delete(transport!.sessionId);
          log.info('http', 'mcp-session-close', { id: transport!.sessionId, sessions: transports.size });
        }
      };
      const server = buildServer(registry, sessionStore, opts);
      await server.connect(transport);
    }

    await transport.handleRequest(req, res, body);
  }

  const httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? host}`);

    // Dashboard + state API
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      send(res, 200, renderDashboard({ mcpPath, port, host }), 'text/html; charset=utf-8');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      send(res, 200, JSON.stringify(buildState(registry, sessionStore)), 'application/json');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/healthz') {
      send(res, 200, JSON.stringify({ ok: true }), 'application/json');
      return;
    }

    // MCP endpoint (POST to call, GET for SSE stream, DELETE to end session)
    if (url.pathname === mcpPath) {
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          let body: unknown;
          try {
            body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
          } catch {
            send(res, 400, JSON.stringify({ error: 'invalid JSON body' }), 'application/json');
            return;
          }
          void handleMcp(req, res, body).catch((err) => {
            log.warn('http', 'mcp-handle-failed', { err: err instanceof Error ? err.message : String(err) });
            if (!res.headersSent) send(res, 500, JSON.stringify({ error: 'internal error' }), 'application/json');
          });
        });
        return;
      }
      // GET (SSE) / DELETE go straight through to the transport.
      void handleMcp(req, res, undefined).catch((err) => {
        log.warn('http', 'mcp-handle-failed', { err: err instanceof Error ? err.message : String(err) });
        if (!res.headersSent) send(res, 500, JSON.stringify({ error: 'internal error' }), 'application/json');
      });
      return;
    }

    send(res, 404, JSON.stringify({ error: 'not found' }), 'application/json');
  });

  const shutdown = async () => {
    try {
      await registry.shutdown();
      httpServer.close();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await new Promise<void>((resolve) => httpServer.listen(port, host, resolve));
  log.info('http', 'listening', { url: `http://${host}:${port}`, mcpPath, dashboard: `http://${host}:${port}/` });
}
