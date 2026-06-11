#!/usr/bin/env node
/**
 * pi-mcp-claude — a real MCP client for claude-code-mcp-bridge.
 *
 * Pi's runtime has no built-in MCP client, so this script IS the client:
 * it spawns the bridge over stdio, does the JSON-RPC initialize handshake,
 * and exposes the six claude_* tools as plain subcommands.
 *
 * The bridge's task registry is in-memory and scoped to ONE stdio connection.
 * Because each invocation of this script is a fresh connection, the only
 * mode that survives across calls is `run` (which blocks-and-streams a whole
 * task to completion inside a single connection). status/wait/list/cancel are
 * exposed too, but only meaningful within a single `run` lifetime — they are
 * here mostly for debugging.
 *
 * Usage:
 *   mcp_claude.mjs run "<prompt>" [--cwd <dir>] [--model <m>] [--session <id>]
 *                                 [--timeout-ms <n>] [--json]
 *   mcp_claude.mjs tools          # list tools exposed by the bridge
 *
 * Env:
 *   BRIDGE_DIR     default ~/projects/claude-code-mcp-bridge
 *   CWD_ROOT       default ~/projects   (bridge --cwd-root whitelist)
 *   CLAUDE_BIN_DIR dir to prepend to PATH so the server can spawn `claude`
 *                  default: dir of `which claude` resolved at call time
 */

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { existsSync, readFileSync, openSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';

const HOME = homedir();
const BRIDGE_DIR = process.env.BRIDGE_DIR || join(HOME, 'projects', 'claude-code-mcp-bridge');
const CWD_ROOT = process.env.CWD_ROOT || join(HOME, 'projects');

function die(msg, code = 1) {
  process.stderr.write(`[mcp_claude] ${msg}\n`);
  process.exit(code);
}

// --- locate the MCP SDK inside the bridge's node_modules ---
const sdkBase = join(BRIDGE_DIR, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client');
const clientPath = join(sdkBase, 'index.js');
const stdioPath = join(sdkBase, 'stdio.js');
if (!existsSync(clientPath)) die(`MCP SDK not found at ${clientPath} — run \`npm install\` in ${BRIDGE_DIR}`);

const { Client } = await import(pathToFileURL(clientPath).href);
const { StdioClientTransport } = await import(pathToFileURL(stdioPath).href);
const httpPath = join(sdkBase, 'streamableHttp.js');
const { StreamableHTTPClientTransport } = await import(pathToFileURL(httpPath).href);

// --- ensure the spawned server can find `claude` on PATH ---
let claudeDir = process.env.CLAUDE_BIN_DIR;
if (!claudeDir) {
  try {
    const p = execSync('command -v claude', { encoding: 'utf8' }).trim();
    if (p) claudeDir = p.replace(/\/claude$/, '');
  } catch { /* leave PATH as-is */ }
}
const childPath = claudeDir ? `${claudeDir}:${process.env.PATH || ''}` : process.env.PATH || '';

// --- arg parsing ---
const [, , cmd, ...rest] = process.argv;
function flag(name, def) {
  const i = rest.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < rest.length) return rest[i + 1];
  return def;
}
function has(name) {
  return rest.includes(`--${name}`);
}
const wantJson = rest.includes('--json');

function unwrap(res) {
  // tool results come back as { content: [{ type:'text', text: '<json>' }] }
  const txt = res?.content?.find((c) => c.type === 'text')?.text;
  if (txt == null) return res;
  try { return JSON.parse(txt); } catch { return txt; }
}

// --- resolve a Feishu notify anchor (om_...) deterministically ---
// Routing must be explicit: pass --thread-id <omt_xxx> (reply INTO that thread)
// or --main (reply in the main p2p chat). No "latest thread" guessing — that
// silently misroutes a main-chat task into an unrelated thread.
function resolveAnchor() {
  const wantMain = has('main');
  const threadId = flag('thread-id');
  const explicit = flag('anchor');
  if (explicit) return { anchor: explicit, threadId: wantMain ? undefined : threadId, replyInThread: !wantMain };
  const bridgePath = join(HOME, '.pi', 'agent', 'feishu', 'bridge.json');
  if (!existsSync(bridgePath)) return {};
  const routes = JSON.parse(readFileSync(bridgePath, 'utf8')).routes || {};
  const entries = Object.values(routes);
  if (wantMain) {
    // main p2p route = sessionKey p2p:<id> with NO :thread: segment
    const pick = entries
      .filter((r) => r.sessionKey && r.sessionKey.startsWith('p2p:') && !r.sessionKey.includes(':thread:'))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    if (!pick) return {};
    return { anchor: pick.lastMessageId, threadId: undefined, replyInThread: false };
  }
  if (threadId) {
    const pick = entries.find((r) => r.sessionKey?.endsWith(`:thread:${threadId}`));
    if (!pick) return {};
    return { anchor: pick.lastMessageId, threadId, replyInThread: true };
  }
  // Neither flag: refuse to guess. Caller must say where the notification goes.
  return {};
}

async function connect() {
  // Prefer the shared, long-lived HTTP daemon (one registry/store for all
  // clients). Fall back to spawning a private stdio server only if the daemon
  // isn't reachable. Set MCP_HTTP_URL='none' to force stdio.
  const httpUrl = process.env.MCP_HTTP_URL || 'http://127.0.0.1:8787/mcp';
  if (httpUrl !== 'none') {
    try {
      const probe = httpUrl.replace(/\/mcp$/, '/healthz');
      const r = await fetch(probe, { signal: AbortSignal.timeout(1500) });
      if (r.ok) {
        const transport = new StreamableHTTPClientTransport(new URL(httpUrl));
        const client = new Client({ name: 'pi-mcp-claude', version: '0.1.0' }, { capabilities: {} });
        await client.connect(transport);
        return { client, transport, mode: 'http' };
      }
    } catch { /* daemon down — fall through to stdio */ }
  }
  const transport = new StdioClientTransport({
    command: process.execPath, // current node
    args: [join(BRIDGE_DIR, 'bin', 'claude-code-mcp-bridge.mjs'), 'mcp', '--cwd-root', CWD_ROOT],
    env: { ...process.env, PATH: childPath },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'pi-mcp-claude', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport, mode: 'stdio' };
}

async function cmdTools() {
  const { client, transport } = await connect();
  const { tools } = await client.listTools();
  for (const t of tools) process.stdout.write(`- ${t.name}: ${t.description}\n`);
  await client.close(); await transport.close?.();
}

async function cmdRun() {
  const prompt = rest.find((a) => !a.startsWith('--'));
  if (!prompt) die('run needs a prompt: mcp_claude.mjs run "<prompt>"');
  const cwd = flag('cwd', process.cwd());
  const model = flag('model');
  const session = flag('session');
  const timeoutMs = Number(flag('timeout-ms', '60000'));

  const { client, transport } = await connect();

  const runArgs = { prompt, cwd };
  if (model) runArgs.model = model;
  if (session) runArgs.session_id = session;

  const started = unwrap(await client.callTool({ name: 'claude_run', arguments: runArgs }));
  const taskId = started.task_id;
  if (!taskId) { console.error(JSON.stringify(started, null, 2)); die('claude_run returned no task_id'); }
  process.stderr.write(`[mcp_claude] task ${taskId} started (cwd=${started.cwd})\n`);

  let fromSeq = 0;
  let lastStatus = 'running';
  let finalText = '';
  let finalSession = started.session_id;
  while (true) {
    const out = unwrap(await client.callTool({
      name: 'claude_wait',
      arguments: { task_id: taskId, from_seq: fromSeq, timeout_ms: 30000 },
    }));
    const events = out.events || [];
    for (const rec of events) {
      if (rec.seq > fromSeq) fromSeq = rec.seq;
      const ev = rec.event || {};
      if (ev.type === 'text' && !wantJson) process.stdout.write(ev.delta || '');
      if (ev.type === 'tool_use' && !wantJson) process.stderr.write(`\n[tool] ${ev.name}\n`);
      if (ev.type === 'error') process.stderr.write(`\n[error] ${ev.message}\n`);
      if (ev.type === 'done' && ev.sessionId) finalSession = ev.sessionId;
    }
    const snap = out.snapshot || {};
    lastStatus = snap.status || lastStatus;
    if (snap.text) finalText = snap.text;
    if (snap.session_id) finalSession = snap.session_id;
    if (lastStatus !== 'running') break;
  }

  await client.close(); await transport.close?.();

  if (wantJson) {
    process.stdout.write(JSON.stringify({ task_id: taskId, status: lastStatus, session_id: finalSession, text: finalText }, null, 2) + '\n');
  } else {
    process.stdout.write(`\n\n[mcp_claude] status=${lastStatus} session=${finalSession || '-'}\n`);
  }
  process.exit(lastStatus === 'done' ? 0 : 2);
}

// dispatch: fire-and-forget. Self-detach into a background worker that holds
// the connection alive until the task is terminal; the bridge then fires the
// notify_target (a Feishu reply-in-thread) on its own. My turn returns now.
async function cmdDispatch() {
  const prompt = rest.find((a) => !a.startsWith('--'));
  if (!prompt) die('dispatch needs a prompt');

  if (process.env.MCP_CLAUDE_WORKER !== '1') {
    // parent: re-exec self detached, then exit immediately
    const logFile = join(tmpdir(), `mcp_claude_dispatch_${Date.now()}.log`);
    const fd = openSync(logFile, 'a');
    const child = spawn(process.execPath, [process.argv[1], ...process.argv.slice(2)], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { ...process.env, MCP_CLAUDE_WORKER: '1' },
    });
    child.unref();
    const { anchor, threadId, replyInThread } = resolveAnchor();
    const dest = replyInThread ? `thread=${threadId}` : (anchor ? 'main-chat' : 'NONE');
    process.stdout.write(`[mcp_claude] dispatched (worker pid=${child.pid}); will reply into ${dest} anchor=${anchor || 'NONE'}\nlog: ${logFile}\n`);
    if (!anchor) process.stderr.write('[mcp_claude] WARN no anchor resolved — pass --thread-id <omt_xxx> or --main; bridge will have nowhere to notify\n');
    process.exit(0);
  }

  // worker: hold the connection until terminal; bridge fires notify itself
  const { anchor, replyInThread } = resolveAnchor();
  const cwd = flag('cwd', process.cwd());
  const model = flag('model');
  const session = flag('session');
  const { client, transport } = await connect();
  const notify_target = anchor
    ? { type: 'feishu', anchor_msg_id: anchor, reply_in_thread: !!replyInThread, as_identity: 'bot', notify_on_start: true }
    : undefined;
  const runArgs = { prompt, cwd, ...(model ? { model } : {}), ...(session ? { session_id: session } : {}), ...(notify_target ? { notify_target } : {}) };
  const started = unwrap(await client.callTool({ name: 'claude_run', arguments: runArgs }));
  const taskId = started.task_id;
  process.stderr.write(`[worker] task ${taskId} started, holding until terminal\n`);
  let fromSeq = 0, status = 'running';
  while (status === 'running') {
    const out = unwrap(await client.callTool({ name: 'claude_wait', arguments: { task_id: taskId, from_seq: fromSeq, timeout_ms: 60000 } }));
    for (const r of (out.events || [])) if (r.seq > fromSeq) fromSeq = r.seq;
    status = out.snapshot?.status || status;
  }
  process.stderr.write(`[worker] task ${taskId} terminal: ${status}\n`);
  await client.close(); await transport.close?.();
  process.exit(0);
}

async function cmdSessions() {
  const { client, transport } = await connect();
  const id = flag('get');
  if (id) {
    const rec = unwrap(await client.callTool({ name: 'claude_session_get', arguments: { session_id: id } }));
    process.stdout.write(JSON.stringify(rec, null, 2) + '\n');
  } else {
    const out = unwrap(await client.callTool({ name: 'claude_sessions', arguments: {} }));
    const sessions = out.sessions || [];
    if (wantJson) process.stdout.write(JSON.stringify(sessions, null, 2) + '\n');
    else for (const s of sessions)
      process.stdout.write(`${s.session_id}  [${s.status}] runs=${s.run_count} cwd=${s.cwd}\n    ${(s.last_prompt || '').replace(/\n/g, ' ')}\n`);
  }
  await client.close(); await transport.close?.();
}

async function cmdStatus() {
  const taskId = rest.find((a) => !a.startsWith('--'));
  if (!taskId) die('status needs a task_id: mcp_claude.mjs status <task_id>');
  const { client, transport } = await connect();
  const s = unwrap(await client.callTool({ name: 'claude_status', arguments: { task_id: taskId } }));
  if (wantJson) process.stdout.write(JSON.stringify(s, null, 2) + '\n');
  else {
    const c = s.counters || {};
    process.stdout.write(`task ${s.taskId || taskId}  [${s.status}]  cwd=${s.cwd || '?'}\n`);
    if (s.currentTool) process.stdout.write(`  in-flight tool: ${s.currentTool}\n`);
    process.stdout.write(`  tools=${c.toolUses ?? 0} results=${c.toolResults ?? 0} tokens=${(c.inputTokens ?? 0)}/${(c.outputTokens ?? 0)} cost=$${(c.costUsd ?? 0)}\n`);
    if (s.exitError) process.stdout.write(`  error: ${s.exitError}\n`);
    process.stdout.write(`--- text so far ---\n${s.text || '(none yet)'}\n`);
  }
  await client.close(); await transport.close?.();
}

async function cmdWatch() {
  const taskId = rest.find((a) => !a.startsWith('--'));
  if (!taskId) die('watch needs a task_id: mcp_claude.mjs watch <task_id>');
  let fromSeq = Number(flag('from-seq', '0'));
  const { client, transport } = await connect();
  let status = 'running';
  while (true) {
    const out = unwrap(await client.callTool({
      name: 'claude_wait',
      arguments: { task_id: taskId, from_seq: fromSeq, timeout_ms: 30000 },
    }));
    for (const rec of (out.events || [])) {
      if (rec.seq > fromSeq) fromSeq = rec.seq;
      const ev = rec.event || {};
      if (ev.type === 'text' && !wantJson) process.stdout.write(ev.delta || '');
      else if (ev.type === 'tool_use' && !wantJson) process.stderr.write(`\n[tool] ${ev.name}\n`);
      else if (ev.type === 'error') process.stderr.write(`\n[error] ${ev.message}\n`);
      else if (wantJson) process.stdout.write(JSON.stringify(rec) + '\n');
    }
    status = out.snapshot?.status || status;
    if (status !== 'running') break;
  }
  process.stderr.write(`\n[watch] task ${taskId} terminal: ${status}\n`);
  await client.close(); await transport.close?.();
}

switch (cmd) {
  case 'tools': await cmdTools(); break;
  case 'run': await cmdRun(); break;
  case 'dispatch': await cmdDispatch(); break;
  case 'sessions': await cmdSessions(); break;
  case 'status': await cmdStatus(); break;
  case 'watch': await cmdWatch(); break;
  default:
    die('usage: mcp_claude.mjs <run|dispatch|status|watch|sessions|tools> ...  (see header for flags)');
}
