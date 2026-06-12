import { readdirSync, statSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Scan Claude Code's on-disk session transcripts (`~/.claude/projects/<enc-cwd>/<session_id>.jsonl`).
 *
 * This is the GLOBAL truth source for *every* local Claude Code session —
 * interactive terminal runs, IDE sessions, and anything the bridge itself
 * dispatched — unlike the bridge's own SessionStore, which only records
 * sessions it spawned via claude_run. Read-only; never writes.
 *
 * Performance: there can be thousands of these files. We do a cheap stat-only
 * pass over all of them, sort by mtime, apply the limit, and only then read the
 * head of the files we will actually return (metadata like cwd / first prompt
 * lives in the first lines). So cost scales with `limit`, not the total count.
 */

export interface ScannedSession {
  session_id: string;
  cwd: string | null;
  project_dir: string;
  file: string;
  size_bytes: number;
  modified: number;          // file mtime, epoch ms
  created: number | null;    // first line's timestamp, epoch ms
  git_branch: string | null;
  version: string | null;
  first_prompt: string | null;
  summary: string | null;
}

export interface ScanResult {
  root: string;
  total: number;             // total sessions found (after cwd filter, before limit)
  returned: number;
  sessions: ScannedSession[];
}

export interface ScanOptions {
  projectsDir?: string;
  /** Max sessions to return (newest first). null → all. Default 200. */
  limit?: number | null;
  /** Substring filter on the cwd / project dir. */
  cwdFilter?: string;
}

const HEAD_BYTES = 65_536;   // metadata lives in the first lines; cap the read

function readHead(file: string, maxBytes = HEAD_BYTES): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function extractText(content: unknown): string | null {
  if (typeof content === 'string') return content.trim() || null;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b && typeof b === 'object' && (b as { type?: string }).type === 'text') {
        const t = (b as { text?: unknown }).text;
        if (typeof t === 'string' && t.trim()) return t.trim();
      }
    }
  }
  return null;
}

interface HeadMeta {
  cwd: string | null;
  gitBranch: string | null;
  version: string | null;
  created: number | null;
  firstPrompt: string | null;
  summary: string | null;
}

function parseHeadMeta(head: string): HeadMeta {
  const m: HeadMeta = { cwd: null, gitBranch: null, version: null, created: null, firstPrompt: null, summary: null };
  for (const line of head.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(s) as Record<string, unknown>;
    } catch {
      // Last line may be truncated by the HEAD_BYTES cap — skip it.
      continue;
    }
    if (m.created === null && typeof o.timestamp === 'string') {
      const t = Date.parse(o.timestamp);
      if (!Number.isNaN(t)) m.created = t;
    }
    if (m.cwd === null && typeof o.cwd === 'string') m.cwd = o.cwd;
    if (m.gitBranch === null && typeof o.gitBranch === 'string') m.gitBranch = o.gitBranch;
    if (m.version === null && typeof o.version === 'string') m.version = o.version;
    if (m.summary === null && o.type === 'summary' && typeof o.summary === 'string') {
      m.summary = o.summary.trim() || null;
    }
    if (m.firstPrompt === null && o.type === 'user' && o.message && typeof o.message === 'object') {
      const t = extractText((o.message as { content?: unknown }).content);
      if (t) m.firstPrompt = t.slice(0, 200);
    }
    if (m.cwd && m.firstPrompt && m.gitBranch && m.summary) break;
  }
  return m;
}

/**
 * Best-effort decode of an encoded project dir back to a cwd. Claude Code
 * replaces '/' with '-', which is lossy (real '-' in a path is indistinguishable),
 * so this is a display fallback only — the real `cwd` read from a session line
 * is always preferred when present.
 */
function decodeProjectDir(name: string): string | null {
  if (!name) return null;
  return name.replace(/-/g, '/');
}

export function scanAllSessions(opts: ScanOptions = {}): ScanResult {
  const root = opts.projectsDir ?? join(homedir(), '.claude', 'projects');
  const limit = opts.limit === undefined ? 200 : opts.limit;
  const cwdFilter = opts.cwdFilter?.trim();

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return { root, total: 0, returned: 0, sessions: [] };
  }

  // Cheap pass: stat every session file (no content read).
  interface Lite { session_id: string; project_dir: string; file: string; size: number; modified: number }
  let lite: Lite[] = [];
  const encFilter = cwdFilter ? cwdFilter.replace(/\//g, '-') : null;
  for (const pd of projectDirs) {
    // cwd filter is applied cheaply against the encoded dir name here.
    if (cwdFilter && !pd.includes(encFilter!) && !pd.includes(cwdFilter)) continue;
    const dirPath = join(root, pd);
    let entries: string[];
    try {
      entries = readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const file = join(dirPath, name);
      let st;
      try {
        st = statSync(file);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      lite.push({ session_id: name.slice(0, -6), project_dir: pd, file, size: st.size, modified: st.mtimeMs });
    }
  }

  lite.sort((a, b) => b.modified - a.modified);
  const total = lite.length;
  const slice = limit === null ? lite : lite.slice(0, Math.max(0, limit));

  // Expensive pass: read only the head of the files we will return.
  const sessions: ScannedSession[] = slice.map((l) => {
    let meta: HeadMeta = { cwd: null, gitBranch: null, version: null, created: null, firstPrompt: null, summary: null };
    try {
      meta = parseHeadMeta(readHead(l.file));
    } catch {
      /* unreadable file → emit what we have from stat */
    }
    return {
      session_id: l.session_id,
      cwd: meta.cwd ?? decodeProjectDir(l.project_dir),
      project_dir: l.project_dir,
      file: l.file,
      size_bytes: l.size,
      modified: Math.round(l.modified),
      created: meta.created,
      git_branch: meta.gitBranch,
      version: meta.version,
      first_prompt: meta.firstPrompt,
      summary: meta.summary,
    };
  });

  return { root, total, returned: sessions.length, sessions };
}

// ── transcript: tail-read + flatten one session's conversation ──────────────

export interface TranscriptBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  role: 'user' | 'assistant' | 'system';
  text: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_id?: string;
  ts: number | null;
}
export interface TranscriptResult {
  session_id: string;
  file: string;
  total_lines: number;
  returned: number;
  messages: TranscriptBlock[];
}

const TAIL_BYTES = 512 * 1024;          // never full-read multi-MB sessions
const PROJECTS_ROOT = join(homedir(), '.claude', 'projects');

/** Read the last `maxBytes` of a file. `truncated` means the first line is partial. */
function readTail(file: string, maxBytes = TAIL_BYTES): { text: string; truncated: boolean } {
  const fd = openSync(file, 'r');
  try {
    const { size } = fstatSync(fd);
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, start);
    return { text: buf.toString('utf8'), truncated: start > 0 };
  } finally {
    closeSync(fd);
  }
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (b && typeof b === 'object') {
        const t = (b as { text?: unknown; type?: string }).text;
        if (typeof t === 'string') parts.push(t);
        else parts.push(JSON.stringify(b));
      } else if (typeof b === 'string') parts.push(b);
    }
    return parts.join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

/** Parse a session jsonl into a flat list of conversation blocks (tail-only). */
export function scanTranscript(opts: { file: string; limit?: number }): TranscriptResult {
  const file = opts.file;
  // Path safety: must live under ~/.claude/projects and be a .jsonl.
  if (!file.endsWith('.jsonl') || !file.startsWith(PROJECTS_ROOT)) {
    throw new Error('file must be a .jsonl under ~/.claude/projects');
  }
  const limit = Math.min(1000, Math.max(1, opts.limit || 200));
  const session_id = file.slice(file.lastIndexOf('/') + 1, -'.jsonl'.length);

  const { text, truncated } = readTail(file);
  let lines = text.split('\n');
  if (truncated && lines.length) lines = lines.slice(1); // drop partial first line

  const out: TranscriptBlock[] = [];
  let total = 0;
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(s) as Record<string, unknown>; } catch { continue; }
    const type = o.type;
    if (type !== 'user' && type !== 'assistant' && type !== 'system') continue;
    total += 1;
    const msg = (o.message || {}) as { role?: string; content?: unknown };
    const role = (msg.role === 'assistant' ? 'assistant' : type === 'system' ? 'system' : 'user') as TranscriptBlock['role'];
    const ts = typeof o.timestamp === 'string' ? (Date.parse(o.timestamp) || null) : null;
    const content = msg.content;
    if (typeof content === 'string') {
      if (content.trim()) out.push({ type: 'text', role, text: content, ts });
    } else if (Array.isArray(content)) {
      for (const blk of content) {
        if (!blk || typeof blk !== 'object') continue;
        const b = blk as { type?: string; text?: string; name?: string; input?: unknown; id?: string; tool_use_id?: string; content?: unknown };
        if (b.type === 'text' && b.text) out.push({ type: 'text', role, text: b.text, ts });
        else if (b.type === 'tool_use') out.push({ type: 'tool_use', role, text: '', tool_name: b.name, tool_input: b.input, tool_id: b.id, ts });
        else if (b.type === 'tool_result') out.push({ type: 'tool_result', role, text: stringifyToolResult(b.content), tool_id: b.tool_use_id, ts });
      }
    }
  }

  const messages = out.slice(-limit);
  return { session_id, file, total_lines: total, returned: messages.length, messages };
}

