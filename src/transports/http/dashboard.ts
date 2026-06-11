interface DashboardOptions {
  mcpPath: string;
  port: number;
  host: string;
}

/**
 * A single self-contained HTML page: a brief usage intro plus a live status
 * panel (sessions / tasks / running) that polls GET /api/state every few
 * seconds. No build step, no external assets — just a string.
 */
export function renderDashboard(o: DashboardOptions): string {
  const endpoint = `http://${o.host}:${o.port}${o.mcpPath}`;
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>claude-code-mcp-bridge</title>
<style>
  :root { --bg:#0f1419; --card:#1a2230; --line:#2a3547; --fg:#e6edf3; --muted:#8b97a7; --accent:#4f86f7; --ok:#34a853; --run:#f5a623; --err:#e25555; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; background:var(--bg); color:var(--fg); }
  .wrap { max-width: 980px; margin: 0 auto; padding: 28px 18px 60px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 26px 0 10px; color:var(--muted); text-transform: uppercase; letter-spacing:.04em; }
  .sub { color:var(--muted); margin: 0 0 18px; }
  code { background:#0b0f14; border:1px solid var(--line); border-radius:6px; padding:2px 6px; font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px; }
  pre { background:#0b0f14; border:1px solid var(--line); border-radius:8px; padding:12px 14px; overflow:auto; }
  .cards { display:flex; gap:12px; flex-wrap:wrap; }
  .stat { flex:1; min-width:120px; background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .stat .n { font-size:26px; font-weight:600; }
  .stat .l { color:var(--muted); font-size:12px; }
  table { width:100%; border-collapse: collapse; background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  th,td { text-align:left; padding:9px 12px; border-bottom:1px solid var(--line); font-size:13px; vertical-align:top; }
  th { color:var(--muted); font-weight:500; background:#151c28; }
  tr:last-child td { border-bottom:0; }
  .pill { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11.5px; border:1px solid; }
  .s-running { color:var(--run); border-color:var(--run); }
  .s-done { color:var(--ok); border-color:var(--ok); }
  .s-error,.s-cancelled { color:var(--err); border-color:var(--err); }
  .mono { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
  .empty { color:var(--muted); padding:14px 12px; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--ok); margin-right:6px; }
  .foot { color:var(--muted); font-size:12px; margin-top:8px; }
  a { color:var(--accent); }
</style>
</head>
<body>
<div class="wrap">
  <h1>claude-code-mcp-bridge</h1>
  <p class="sub">把本地 Claude Code CLI 包装成 MCP 工具，异步任务模型（run / status / wait / cancel / list / forget）。本页是这台常驻 bridge 的实时状态面板。</p>

  <h2>怎么连</h2>
  <p>MCP 客户端用 Streamable HTTP 连接这个端点：</p>
  <pre>${endpoint}</pre>
  <p>客户端配置示例（mcpServers）：</p>
  <pre>{
  "mcpServers": {
    "claude-code": {
      "type": "streamable-http",
      "url": "${endpoint}"
    }
  }
}</pre>
  <p class="sub">工具：<code>claude_run</code> · <code>claude_status</code> · <code>claude_wait</code> · <code>claude_cancel</code> · <code>claude_list</code> · <code>claude_forget</code> · <code>claude_sessions</code> · <code>claude_session_get</code> · <code>claude_session_forget</code></p>

  <h2><span class="dot"></span>实时状态</h2>
  <div class="cards">
    <div class="stat"><div class="n" id="c-sessions">–</div><div class="l">会话总数</div></div>
    <div class="stat"><div class="n" id="c-tasks">–</div><div class="l">任务总数</div></div>
    <div class="stat"><div class="n" id="c-running">–</div><div class="l">进行中</div></div>
  </div>

  <h2>任务（本进程内存）</h2>
  <div id="tasks"></div>

  <h2>会话（落盘，跨重启/跨客户端共享）</h2>
  <div id="sessions"></div>

  <p class="foot" id="foot">加载中…</p>
</div>
<script>
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const short = (s) => s ? esc(String(s).slice(0,8)) : '–';
const ago = (ms) => { if(!ms) return '–'; const d=Date.now()-ms; const s=Math.round(d/1000); if(s<60) return s+'s 前'; const m=Math.floor(s/60); if(m<60) return m+'m 前'; return Math.floor(m/60)+'h 前'; };
const pill = (st) => '<span class="pill s-'+esc(st)+'">'+esc(st)+'</span>';

function renderTasks(tasks) {
  if (!tasks.length) return '<div class="empty">暂无任务</div>';
  let r = '<table><tr><th>task_id</th><th>状态</th><th>cwd</th><th>session</th><th>tools</th><th>started</th></tr>';
  for (const t of tasks) r += '<tr><td class="mono">'+short(t.task_id)+'</td><td>'+pill(t.status)+'</td><td class="mono">'+esc(t.cwd)+'</td><td class="mono">'+short(t.session_id)+'</td><td>'+(t.counters?t.counters.toolUses:0)+'</td><td>'+ago(t.started_at)+'</td></tr>';
  return r + '</table>';
}
function renderSessions(ss) {
  if (!ss.length) return '<div class="empty">暂无会话</div>';
  let r = '<table><tr><th>session_id</th><th>最近状态</th><th>cwd</th><th>runs</th><th>最近 prompt</th><th>更新</th></tr>';
  for (const s of ss) r += '<tr><td class="mono">'+short(s.session_id)+'</td><td>'+pill(s.status)+'</td><td class="mono">'+esc(s.cwd)+'</td><td>'+esc(s.run_count)+'</td><td>'+esc((s.last_prompt||'').slice(0,60))+'</td><td>'+ago(s.updated_at)+'</td></tr>';
  return r + '</table>';
}
async function tick() {
  try {
    const r = await fetch('/api/state'); const d = await r.json();
    document.getElementById('c-sessions').textContent = d.counts.sessions;
    document.getElementById('c-tasks').textContent = d.counts.tasks;
    document.getElementById('c-running').textContent = d.counts.running;
    document.getElementById('tasks').innerHTML = renderTasks(d.tasks);
    document.getElementById('sessions').innerHTML = renderSessions(d.sessions);
    document.getElementById('foot').textContent = '更新于 ' + new Date().toLocaleTimeString() + ' · 每 3s 自动刷新';
  } catch (e) {
    document.getElementById('foot').textContent = '状态获取失败：' + e;
  }
}
tick(); setInterval(tick, 3000);
</script>
</body>
</html>`;
}
