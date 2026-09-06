const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json());

const API_KEY   = process.env.API_KEY || '';
const DATA_FILE = path.join(__dirname, 'data.json');
const LOG_CAP   = 300;                          // keep last 300 calls in the file

const SEED = {
  counters: { cif: 1000000 },
  cifRegistry: [],
  watchlists: [
    { name: 'Ravi Malhotra', documentNumber: null, listName: 'PEP list',     reason: 'Politically exposed person', active: true },
    { name: 'Nadia Sheikh',  documentNumber: null, listName: 'UN sanctions', reason: 'Sanctions listing',           active: true },
    { name: null, documentNumber: 'AB1234567',     listName: 'Internal blacklist', reason: 'Fraud closure 2019',  active: true },
  ],
  callLog: [],
  screenings: []
};

// ---------- data layer: load-per-request, atomic write ----------
function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      return Object.assign({}, JSON.parse(JSON.stringify(SEED)), db);
    }
  } catch (e) { console.error('data.json unreadable — using seed:', e.message); }
  return JSON.parse(JSON.stringify(SEED));
}
function save(db) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// ---------- call log ----------
function logCall(db, entry) {
  db.callLog.unshift(entry);                              // newest first
  if (db.callLog.length > LOG_CAP) db.callLog = db.callLog.slice(0, LOG_CAP);
}
const fmtT = d => d.toISOString();
const esc  = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// handlers are synchronous → no interleaved writes, demo-safe
const guard = fn => (req, res) => {
  const started = Date.now();
  try {
    fn(req, res);
    // capture after handler ran (status known), but inside the same sync block
    const db = load();
    logCall(db, { t: fmtT(new Date()), method: req.method, path: req.path,
                  status: res.statusCode, ms: Date.now() - started,
                  req: bodyPreview(req.body), source: req.ip });
    save(db);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
};
function bodyPreview(b) {
  if (!b || typeof b !== 'object') return {};
  const out = {};
  for (const k of Object.keys(b).slice(0, 12)) {
    const v = b[k];
    out[k] = typeof v === 'string' && v.length > 60 ? v.slice(0, 57) + '…' : v;
  }
  return out;
}

// ---------- mod-11 check digit (identical to the C# side) ----------
function mod11(digits) {
  let sum = 0, w = 2;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += (digits.charCodeAt(i) - 48) * w;
    w = w >= 10 ? 2 : w + 1;
  }
  return (11 - (sum % 11)) % 11;
}

// ---------- DASHBOARD (no API key required — view only) ----------
app.get('/', guard((req, res) => {
  const db = load();
  const rows = db.callLog.map(c => `
    <tr class="${c.status >= 400 ? 'bad' : ''}">
      <td class="t">${esc(c.t.replace('T',' ').replace('Z',''))}</td>
      <td class="m ${esc(c.method)}">${esc(c.method)}</td>
      <td class="p">${esc(c.path)}</td>
      <td class="s">${esc(c.status)}</td>
      <td class="ms">${esc(c.ms)} ms</td>
      <td class="src">${esc(c.source || '')}</td>
      <td class="b"><code>${esc(JSON.stringify(c.req))}</code></td>
    </tr>`).join('');
  const hits = db.callLog.filter(c => c.path === '/api/aml/screen' && c.req && c.req.name === 'Ravi Malhotra').length;
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SATS Demo API — integration console</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0f0e0b;color:#d8d2c0;font:13px/1.5 'Courier New',monospace;padding:22px}
  h1{font:700 18px 'Courier New',monospace;letter-spacing:.12em;color:#f2ebd5;margin-bottom:4px}
  .sub{color:#8b8570;margin-bottom:18px}
  .stats{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:18px}
  .stat{border:1px solid #3e3b2e;padding:10px 16px;min-width:130px}
  .stat b{display:block;font-size:22px;color:#9fd8a5}
  .stat span{color:#8b8570;font-size:11px;letter-spacing:.08em}
  .stat.warn b{color:#e39a92}
  table{width:100%;border-collapse:collapse}
  th{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#8b8570;text-align:left;padding:6px 8px;border-bottom:1px solid #3e3b2e}
  td{padding:6px 8px;border-bottom:1px solid #26241a;vertical-align:top}
  td.t{color:#8b8570;white-space:nowrap;font-size:11px}
  td.m{font-weight:700;white-space:nowrap}
  td.m.GET{color:#a8c6e0} td.m.POST{color:#e8c97a} 
  td.p{color:#9fd8a5}
  td.s{font-weight:700;color:#9fd8a5} tr.bad td.s{color:#e39a92}
  td.ms{color:#8b8570;white-space:nowrap}
  td.src{color:#8b8570;font-size:11px;white-space:nowrap}
  td.b code{font:11px 'Courier New',monospace;color:#b9b39e;word-break:break-all}
  tr.bad{background:rgba(227,154,146,.06)}
  .auto{margin-top:16px;color:#8b8570;font-size:11px;text-align:center}
  .refresh{color:#e8c97a;cursor:pointer}
  .empty{color:#8b8570;font-style:italic;padding:14px}
  h2{font:700 12px 'Courier New',monospace;letter-spacing:.16em;color:#8b8570;margin:26px 0 10px;text-transform:uppercase}
  pre{background:#171510;padding:12px;overflow-x:auto;color:#c9c2ac;font-size:12px}
</style></head><body>
<h1>SATS DEMO API — INTEGRATION CONSOLE</h1>
<div class="sub">${esc(req.headers.host)} · JSON-file mode · logs persist until redeploy</div>
<div class="stats">
  <div class="stat"><b>${db.callLog.length}</b><span>TOTAL CALLS</span></div>
  <div class="stat"><b>${db.cifRegistry.length}</b><span>CIFS ISSUED</span></div>
  <div class="stat"><b>${db.screenings.length}</b><span>AML SCREENINGS</span></div>
  <div class="stat"><b>${db.watchlists.length}</b><span>WATCHLIST ENTRIES</span></div>
  <div class="stat ${db.callLog.some(c=>c.status>=400)?'warn':''}"><b>${db.callLog.filter(c=>c.status>=400).length}</b><span>ERRORS</span></div>
</div>
<h2>Call log — newest first</h2>
 ${db.callLog.length ? `<table>
<tr><th>Time (UTC)</th><th>Method</th><th>Path</th><th>Status</th><th>Duration</th><th>Source IP</th><th>Body sent</th></tr>
 ${rows}</table>` : '<div class="empty">No calls yet — trigger something from Creatio or curl.</div>'}
<h2>Watchlist</h2>
<pre>${esc(JSON.stringify(db.watchlists.map(w => ({name: w.name, documentNumber: w.documentNumber, listName: w.listName})), null, 2))}</pre>
<div class="auto">auto-refresh every 3 s · <span class="refresh" onclick="location.reload()">refresh now</span></div>
<script>setTimeout(()=>location.reload(), 3000);</script>
</body></html>`);
}));

// ---------- health ----------
app.get('/health', guard((req, res) => {
  const db = load();
  res.json({ ok: true, watchlistEntries: db.watchlists.length,
             cifsIssued: db.cifRegistry.length, screenings: db.screenings.length,
             callsLogged: db.callLog.length });
}));

// ---------- CIF generation (idempotent per recordId) ----------
app.post('/api/cif', guard((req, res) => {
  const { recordId, name } = req.body || {};
  if (!recordId) return res.status(400).json({ error: 'recordId required' });

  const db = load();
  const existing = db.cifRegistry.find(r => r.recordId === recordId);
  if (existing) return res.json({ cif: Number(existing.cif), created: false });

  let cif = null;
  for (let i = 0; i < 5 && !cif; i++) {
    const serial = ++db.counters.cif;
    const base = '88' + String(serial).padStart(7, '0');
    const cd = mod11(base);
    if (cd === 10) continue;
    cif = Number(base + cd);
  }
  if (!cif) return res.status(500).json({ error: 'CIF allocation failed' });

  db.cifRegistry.push({ recordId, cif, name: name || null, createdAt: new Date().toISOString() });
  save(db);
  res.json({ cif, created: true });
}));

// ---------- AML screening (name OR documentNumber, exact, case-insensitive) ----------
app.post('/api/aml/screen', guard((req, res) => {
  const { recordId, name, documentNumber } = req.body || {};
  const db = load();
  const n = (name || '').trim().toLowerCase();
  const d = (documentNumber || '').trim().toLowerCase();

  const hits = db.watchlists.filter(w =>
    w.active !== false && (
      (n && ((w.name || '').trim().toLowerCase() === n)) ||
      (d && ((w.documentNumber || '').trim().toLowerCase() === d))
    ));

  const result = hits.length ? 'HIT' : 'CLEAR';
  const reason = hits.length ? hits[0].reason : '';

  db.screenings.push({ recordId: recordId || null, name: name || null,
    documentNumber: documentNumber || null, result, reason,
    screenedAt: new Date().toISOString() });
  if (db.screenings.length > 200) db.screenings = db.screenings.slice(-200);
  save(db);

  res.json({ result, reason,
    hits: hits.map(h => ({ listName: h.listName, reason: h.reason })),
    screenedAt: new Date().toISOString() });
}));

// ---------- CIF registry (list issued records) ----------
app.get('/api/cif', guard((req, res) => {
  const db = load();
  res.json({ count: db.cifRegistry.length,
             cifs: db.cifRegistry.slice().reverse() });   // newest first
}));

// ---------- watchlist management ----------
app.get('/api/aml/watchlist', guard((req, res) => {
  res.json(load().watchlists);
}));

app.post('/api/aml/watchlist', guard((req, res) => {
  const { name, documentNumber, listName, reason } = req.body || {};
  if (!name && !documentNumber) return res.status(400).json({ error: 'name or documentNumber required' });
  const db = load();
  const entry = { name: name || null, documentNumber: documentNumber || null,
                  listName: listName || 'Ad-hoc list', reason: reason || '',
                  active: true, addedAt: new Date().toISOString() };
  db.watchlists.push(entry);
  save(db);
  res.json({ ok: true, entry });
}));

app.listen(process.env.PORT || 3000, () => console.log('SATS demo API up (JSON mode + console UI)'));