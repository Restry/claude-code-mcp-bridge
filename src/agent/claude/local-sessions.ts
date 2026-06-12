import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
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
