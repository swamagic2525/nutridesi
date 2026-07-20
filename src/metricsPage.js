function metricsPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>NutriDesi Metrics</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    :root { color-scheme: dark; --bg:#0d1210; --panel:#151d19; --muted:#9baca2; --line:#29362f; --accent:#72dc9a; --warm:#e5bc69; }
    * { box-sizing:border-box } body { margin:0; background:var(--bg); color:#f2f7f3; font:14px/1.45 Inter,ui-sans-serif,system-ui,sans-serif; }
    main { max-width:1180px; margin:auto; padding:36px 22px 54px; } h1 { margin:0; font-size:30px } h2 { margin:0 0 14px; font-size:16px } .sub { color:var(--muted); margin:5px 0 28px }
    .cards { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:18px } .card,.section { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:18px; }
    .metric-label,.note { color:var(--muted); font-size:12px }.metric { font-size:30px; font-weight:750; margin:5px 0 }.hint { color:var(--muted); font-size:12px; margin:0 }
    .grid { display:grid; grid-template-columns:1fr 1fr; gap:18px; margin-bottom:18px }.section { min-width:0 } canvas { max-height:240px } table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums } th,td { text-align:right; padding:9px 5px; border-bottom:1px solid var(--line) } th:first-child,td:first-child { text-align:left } th { color:var(--muted); font-weight:500 }.list { margin:0; padding-left:21px }.list li { padding:5px 0 }.pill { display:inline-block; color:#092012; background:var(--accent); border-radius:999px; padding:2px 8px; font-size:11px; font-weight:700 }.warn { color:var(--warm) } footer { color:var(--muted); font-size:12px; margin-top:20px } button { background:transparent; color:var(--accent); border:1px solid var(--accent); border-radius:8px; padding:7px 10px; cursor:pointer; float:right } .error { color:#ffae9e }
    .convo th,.convo td { text-align:left; vertical-align:top; font-size:12px } .convo td:nth-child(4) { white-space:pre-wrap; color:var(--muted) }
    .liveness { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--muted); margin-left:12px; font-weight:400 } .liveness-dot { width:8px; height:8px; border-radius:50%; display:inline-block } .live-ok { background:#72dc9a } .live-warn { background:var(--warm) } .live-stale { background:#ef8f84 }
    .milestones { grid-template-columns:repeat(3,1fr) } .milestones .card { border-color:#33513f; background:linear-gradient(180deg,#17231c,#141c18) } .milestones .metric { font-size:38px; color:var(--accent) }
    .divider { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.09em; margin:26px 0 10px } .ops { grid-template-columns:repeat(3,1fr) } .ops .metric { font-size:24px }
    @media (max-width:760px) { main { padding:24px 14px } .cards { grid-template-columns:1fr 1fr }.milestones,.ops { grid-template-columns:1fr 1fr }.grid { grid-template-columns:1fr } }
  </style>
</head>
<body><main>
  <button id="refresh">Refresh</button><h1>NutriDesi metrics</h1><p class="sub" id="sub">Founder dashboard · join-cohort retention is the decision metric</p>
  <div id="error" class="error"></div>
  <section class="cards milestones">
    <div class="card"><div class="metric-label">Total users</div><div class="metric" id="totalUsers">—</div><p class="hint">real humans, excludes test numbers</p></div>
    <div class="card"><div class="metric-label">Days since launch</div><div class="metric" id="dayNumber">—</div><p class="hint" id="launchHint">since first public share</p></div>
    <div class="card"><div class="metric-label">Foods logged</div><div class="metric" id="foodsLogged">—</div><p class="hint">individual items across all meals</p></div>
    <div class="card"><div class="metric-label">Founding members</div><div class="metric" id="foundingMembers">—</div><p class="hint">of 50 free-for-life spots</p></div>
    <div class="card"><div class="metric-label">Matched from database</div><div class="metric" id="directMatch">—</div><p class="hint">exact dish match, not an estimate</p></div>
    <div class="card"><div class="metric-label">Corrections handled</div><div class="metric" id="corrections">—</div><p class="hint">users fixing a log in one reply</p></div>
  </section>
  <h2 class="divider">Operating health</h2>
  <section class="cards ops">
    <div class="card"><div class="metric-label">Active today</div><div class="metric" id="activeToday">—</div><p class="hint">logged at least one food</p></div>
    <div class="card"><div class="metric-label">D7 join-cohort retention</div><div class="metric" id="d7">—</div><p class="hint" id="d7Hint">eligible cohorts only</p></div>
    <div class="card"><div class="metric-label">Estimate rate</div><div class="metric" id="estimateRate">—</div><p class="hint">assumed or estimated rows</p></div>
  </section>
  <section class="grid"><div class="section"><h2>Daily active users</h2><canvas id="dau"></canvas></div><div class="section"><h2>New users / day</h2><canvas id="newUsers"></canvas></div></section>
  <section class="section" style="margin-bottom:18px"><h2>Join cohorts <span class="pill">D7 = North Star</span></h2><p class="note">Sandbox expiry can make D7 understate true product retention: lockout and churn are currently indistinguishable.</p><div style="overflow:auto"><table><thead><tr><th>Joined</th><th>Users</th><th>D1</th><th>D3</th><th>D7</th></tr></thead><tbody id="cohorts"></tbody></table></div></section>
  <section class="grid"><div class="section"><h2>Next-day return</h2><canvas id="nextDay"></canvas></div><div class="section"><h2>Food items / active user / day</h2><p class="note">Food rows, not incoming WhatsApp messages.</p><canvas id="engagement"></canvas></div></section>
  <section class="grid"><div class="section"><h2>Quality signals</h2><p class="note">Estimate rate = confidence/assumption signal · Uncurated rate = food-coverage gap.</p><canvas id="quality"></canvas></div><div class="section"><h2>Top uncurated foods · last 7 days</h2><ol class="list" id="uncurated"></ol></div></section>
  <section class="section"><h2>Goal adoption</h2><div class="metric" id="goalAdoption">—</div><p class="hint" id="goalHint">users with a protein goal set</p></section>
  <section class="section convo" style="margin-top:18px"><h2>Recent conversations <span class="liveness" id="liveness"></span></h2><p class="note">Last 24 hours (max 200) · phones masked · live (not cached) · test numbers excluded.</p><div style="overflow:auto;max-height:480px"><table><thead><tr><th style="width:52px">When</th><th style="width:110px">User</th><th>Message</th><th>Reply</th></tr></thead><tbody id="recent"></tbody></table></div></section>
  <footer id="footer">excludes test numbers · IST · loading…</footer>
</main>
<script>
  const charts = {};
  const pct = value => value == null ? '—' : value + '%';
  const shortDate = value => new Date(value + 'T00:00:00Z').toLocaleDateString('en-IN',{day:'numeric',month:'short',timeZone:'UTC'});
  const text = (id, value) => document.getElementById(id).textContent = value;
  function chart(id, type, labels, datasets, options={}) {
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(document.getElementById(id), { type, data:{labels,datasets}, options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#c9d6ce'}},tooltip:{mode:'index',intersect:false}},scales:{x:{ticks:{color:'#9baca2',maxTicksLimit:6},grid:{color:'#29362f'}},y:{ticks:{color:'#9baca2'},grid:{color:'#29362f'},...options.y}}} });
  }
  function render(data) {
    text('totalUsers', data.totalUsers); text('activeToday', data.activeToday); text('d7', pct(data.d7.rate)); text('estimateRate', pct(data.estimate.overallRate));
    const m = data.milestone || {};
    text('dayNumber', m.dayNumber == null ? '—' : 'Day ' + m.dayNumber);
    text('launchHint', m.launchDate ? 'since launch on ' + shortDate(m.launchDate) : 'since first public share');
    text('foodsLogged', m.foodsLogged == null ? '—' : m.foodsLogged.toLocaleString('en-IN'));
    text('foundingMembers', m.foundingMembers == null ? '—' : m.foundingMembers + ' / 50');
    text('directMatch', pct(m.directMatchRate));
    text('corrections', m.corrections == null ? '—' : m.corrections);
    text('d7Hint', data.d7.eligibleUsers + ' eligible joined users');
    text('goalAdoption', data.goalAdoption.available ? pct(data.goalAdoption.rate) : '0%');
    text('goalHint', data.goalAdoption.available ? 'users with a protein goal set' : 'run the goal-column migration to enable this');
    const labels = data.growth.dau.map(x => shortDate(x.date));
    chart('dau','line',labels,[{label:'DAU',data:data.growth.dau.map(x=>x.value),borderColor:'#72dc9a',backgroundColor:'rgba(114,220,154,.12)',fill:true,tension:.25}]);
    chart('newUsers','bar',labels,[{label:'New users',data:data.growth.newUsers.map(x=>x.value),backgroundColor:'#72dc9a'}]);
    chart('nextDay','line',data.nextDayReturn.map(x=>shortDate(x.date)),[{label:'D+1 return %',data:data.nextDayReturn.map(x=>x.rate),borderColor:'#e5bc69',tension:.25}],{y:{min:0,max:100}});
    chart('engagement','line',data.engagement.map(x=>shortDate(x.date)),[{label:'Food items',data:data.engagement.map(x=>x.value),borderColor:'#8eb7ff',tension:.25}],{y:{beginAtZero:true}});
    chart('quality','line',data.estimate.daily.map(x=>shortDate(x.date)),[{label:'Estimate %',data:data.estimate.daily.map(x=>x.estimateRate),borderColor:'#e5bc69',tension:.25},{label:'Uncurated %',data:data.estimate.daily.map(x=>x.uncuratedRate),borderColor:'#ef8f84',tension:.25}],{y:{min:0,max:100}});
    const tbody = document.getElementById('cohorts'); tbody.replaceChildren();
    [...data.cohorts].slice(-12).reverse().forEach(row => { const tr=document.createElement('tr'); [shortDate(row.date),row.size,pct(row.d1),pct(row.d3),pct(row.d7)].forEach(v=>{const td=document.createElement('td');td.textContent=v;tr.appendChild(td)});tbody.appendChild(tr) });
    const list = document.getElementById('uncurated'); list.replaceChildren();
    if (!data.topUncurated.length) { const li=document.createElement('li');li.textContent='No uncurated foods in the last 7 days.';list.appendChild(li) }
    data.topUncurated.forEach(row => { const li=document.createElement('li');li.textContent=row.foodName + ' · ' + row.count;list.appendChild(li) });
    // Liveness indicator
    const lEl = document.getElementById('liveness');
    if (data.lastMessageAt) {
      const ago = Math.round((Date.now() - new Date(data.lastMessageAt).getTime()) / 60000);
      const label = ago < 1 ? 'just now' : ago < 60 ? ago + ' min ago' : Math.round(ago/60) + 'h ago';
      const hr = new Date().toLocaleString('en-IN',{timeZone:'Asia/Kolkata',hour:'numeric',hour12:false});
      const active = +hr >= 8 && +hr < 24;
      const cls = ago <= 30 ? 'live-ok' : (active && ago > 120) ? 'live-stale' : 'live-warn';
      lEl.innerHTML = '<span class="liveness-dot '+cls+'"></span>Last message: '+label;
    } else { lEl.innerHTML = '<span class="liveness-dot live-stale"></span>No messages in 24h'; }
    const rec = document.getElementById('recent'); rec.replaceChildren();
    if (!(data.recent || []).length) { const tr=document.createElement('tr'); const td=document.createElement('td'); td.colSpan=4; td.textContent='No conversations in the last 24 hours.'; tr.appendChild(td); rec.appendChild(tr); }
    (data.recent || []).forEach(x => { const tr=document.createElement('tr'); const when=new Date(x.at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}); [when,x.user,x.in,x.out].forEach(v=>{const td=document.createElement('td');td.textContent=v;tr.appendChild(td)}); rec.appendChild(tr); });
    text('footer','excludes test numbers · IST · data as of ' + new Date(data.asOf).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'}));
  }
  async function load() { const error=document.getElementById('error'); error.textContent=''; try { const response=await fetch('/metrics/data'); if(!response.ok) throw new Error('Could not load metrics ('+response.status+').'); render(await response.json()); } catch (err) { error.textContent=err.message; } }
  document.getElementById('refresh').addEventListener('click',load); load();
  // The dashboard is left open for long stretches; without these it silently
  // shows whatever was true when the tab was opened.
  setInterval(load, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
</script></body></html>`;
}

module.exports = { metricsPage };
