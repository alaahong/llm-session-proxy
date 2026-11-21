/**
 * 本地看板（v0.4）。
 *
 * 一个手写 HTML 字符串，由代理在 /__llm_session_proxy__/dashboard 提供。
 * 无打包器、无框架、无 CDN、无 npm 依赖；JS 只 fetch 本地只读端点，
 * 所有动态内容用 textContent 写入，避免上游数据变成 HTML。
 */

const PREFIX = '/__llm_session_proxy__';

export function renderDashboard() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'none'">
<title>llm-session-proxy · local dashboard</title>
<style>
:root{color-scheme:light;--bg:#f6f7fb;--card:#fff;--ink:#151a26;--muted:#5a6478;--line:#dfe4ee;--accent:#2c5cff;--bad:#c62828;--good:#1b7f4b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
header{background:#111827;color:#fff;padding:18px 28px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
header h1{font-size:17px;margin:0;font-weight:650;letter-spacing:.2px}
header small{color:#aab3c5;margin-left:10px;font-weight:400}
button{background:#2c5cff;color:#fff;border:0;border-radius:7px;padding:7px 13px;font:inherit;cursor:pointer}
main{max-width:1180px;margin:0 auto;padding:24px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card b{display:block;font-size:24px;font-variant-numeric:tabular-nums;margin-top:4px}
.card span{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.6px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin-bottom:18px}
section h2{font-size:15px;margin:0 0 12px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:7px 9px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.4px}
tr:last-child td{border-bottom:0}
pre{margin:0;white-space:pre-wrap;word-break:break-all;font:12px/1.5 ui-monospace,Consolas,monospace;color:#374151;max-height:280px;overflow:auto}
.bar{height:8px;background:#e8ecf5;border-radius:4px;overflow:hidden;min-width:70px}
.bar i{display:block;height:100%;background:var(--accent)}
.ok{color:var(--good)}.bad{color:var(--bad)}
footer{color:var(--muted);font-size:12px;text-align:center;padding:10px 0 28px}
a{color:var(--accent)}
</style>
</head>
<body>
<header>
  <h1>llm-session-proxy <small>local observability · auto-refresh 5s</small></h1>
  <button id="refresh" type="button">Refresh now</button>
</header>
<main>
  <div class="cards" id="cards"></div>
  <section><h2>Requests by status</h2><table><thead><tr><th>Status</th><th>Count</th><th>Share</th></tr></thead><tbody id="status"></tbody></table></section>
  <section><h2>Sessions</h2><table><thead><tr><th>ID</th><th>Source key</th><th>Requests</th><th>Last used</th></tr></thead><tbody id="sessions"></tbody></table></section>
  <section><h2>Prefix / prompt-cache estimate</h2><table><thead><tr><th>Session</th><th>Prefix hash</th><th>Requests</th><th>Cache-read rate</th><th>Reusable</th></tr></thead><tbody id="prefix"></tbody></table>
  <p style="color:var(--muted);font-size:12px;margin:10px 0 0" id="prefixNote"></p></section>
  <section><h2>Raw Prometheus metrics</h2><pre id="raw">loading…</pre></section>
</main>
<footer>Read-only page served by the proxy itself. No external scripts, no CDN.</footer>
<script>
(function(){
  var P=${JSON.stringify(PREFIX)};
  var $=function(id){return document.getElementById(id)};
  function num(v){var n=Number(v);return isFinite(n)?n:0}
  function fmt(n){return n.toLocaleString('en-US')}
  function cell(row,values){var tr=document.createElement('tr');values.forEach(function(v){var td=document.createElement('td');td.textContent=v===null||v===undefined?'-':String(v);tr.appendChild(td)});return tr}
  function get(path){return fetch(P+path,{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error(path+' -> '+r.status);return r.json()})}
  function text(path){return fetch(P+path,{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error(path+' -> '+r.status);return r.text()})}
  function value(lines,name){for(var i=0;i<lines.length;i++){if(lines[i].indexOf('#')===0)continue;if(lines[i].indexOf(name+' ')===0)return num(lines[i].slice(name.length).trim())}return 0}
  function series(lines,metric,label){var out=[];var re=new RegExp('^'+metric+'\\\\{'+label+'="([^"]*)"\\\\}\\\\s+([0-9.eE+-]+)$');for(var i=0;i<lines.length;i++){var m=re.exec(lines[i]);if(m)out.push([m[1],num(m[2])])}return out}
  function drawCards(status,lines){
    var uptime=value(lines,'llm_session_proxy_upptime_seconds');
    var failures=0;series(lines,'llm_session_proxy_failures_total','reason').forEach(function(x){failures+=x[1]});
    var bytesIn=value(lines,'llm_session_proxy_bytes_in_total'),bytesOut=value(lines,'llm_session_proxy_bytes_out_total');
    var items=[['Requests',fmt(status.stats.requests)],['Failures',fmt(failures)],['Sessions',fmt(status.sessions.active)],['Uptime',fmt(uptime)+'s'],['Bytes in',fmt(bytesIn)],['Bytes out',fmt(bytesOut)]];
    var host=$('cards');host.textContent='';items.forEach(function(it){var d=document.createElement('div');d.className='card';var s=document.createElement('span');s.textContent=it[0];var b=document.createElement('b');b.textContent=it[1];d.appendChild(s);d.appendChild(b);host.appendChild(d)});
  }
  function drawStatus(lines){
    var rows=series(lines,'llm_session_proxy_requests_by_status_total','status');var total=0;rows.forEach(function(r){total+=r[1]});
    var host=$('status');host.textContent='';rows.forEach(function(r){var pct=total?((r[1]/total)*100).toFixed(1)+'%':'0%';var tr=cell(r[0],r[1],pct);var td=tr.insertCell();var bar=document.createElement('div');bar.className='bar';var fill=document.createElement('i');fill.style.width=pct;bar.appendChild(fill);td.appendChild(bar);host.appendChild(tr)});
    if(!rows.length)host.appendChild(cell('(none)','0','0%',''));
  }
  function drawSessions(data){var host=$('sessions');host.textContent='';(data.items||[]).slice(0,50).forEach(function(s){host.appendChild(cell(s.id,s.key,s.count,s.lastUsed?new Date(s.lastUsed).toLocaleString():''))});if(!(data.items||[]).length)host.appendChild(cell('(none)','','',''))}
  function drawPrefix(data){var host=$('prefix');host.textContent='';(data.items||[]).slice(0,50).forEach(function(s){var tr=cell(s.sessionId,s.prefixHash,s.requests,(s.cacheReadRate*100).toFixed(1)+'%',s.cacheReusable);if(s.cacheReusable==='likely')tr.cells[4].className='ok';host.appendChild(tr)});if(!(data.items||[]).length)host.appendChild(cell('(none)','','','',''));$('prefixNote').textContent=data.note||''}
  function load(){return Promise.all([get('/status'),get('/sessions'),get('/sessions/prefix'),text('/metrics')]).then(function(all){
    var lines=all[3].split('\\n');drawCards(all[0],lines);drawStatus(lines);drawSessions(all[1]);drawPrefix(all[2]);$('raw').textContent=all[3];
  }).catch(function(e){$('raw').textContent='load failed: '+e.message})}
  $('refresh').addEventListener('click',load);load();setInterval(load,5000);
})();
</script>
</body>
</html>
`;
}
