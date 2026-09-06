const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json());

const API_KEY   = process.env.API_KEY || '';
const DATA_FILE = path.join(__dirname, 'data.json');

const SEED = {
  counters: { cif: 1000000 },
  cifRegistry: [],
  watchlists: [
    { name: 'Ravi Malhotra', documentNumber: null, listName: 'PEP list',     reason: 'Politically exposed person', active: true },
    { name: 'Nadia Sheikh',  documentNumber: null, listName: 'UN sanctions', reason: 'Sanctions listing',           active: true },
    { name: null, documentNumber: 'AB1234567',     listName: 'Internal blacklist', reason: 'Fraud closure 2019',  active: true },
  ],
  screenings: []
};

// ---------- data layer: read-per-request, atomic write ----------
function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      return Object.assign({}, JSON.parse(JSON.stringify(SEED)), db);  // seed fills any missing keys
    }
  } catch (e) { console.error('data.json unreadable — using seed:', e.message); }
  return JSON.parse(JSON.stringify(SEED));
}
function save(db) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);   // atomic-ish swap
}

// handlers are fully synchronous → no interleaved writes, demo-safe
const guard = fn => (req, res) => {
  try { fn(req, res); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
};

// ---------- mod-11 check digit (identical to the C# side) ----------
function mod11(digits) {
  let sum = 0, w = 2;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += (digits.charCodeAt(i) - 48) * w;
    w = w >= 10 ? 2 : w + 1;
  }
  return (11 - (sum % 11)) % 11;
}

// ---------- health ----------
app.get('/health', guard((req, res) => {
  const db = load();
  res.json({ ok: true, watchlistEntries: db.watchlists.length,
             cifsIssued: db.cifRegistry.length, screenings: db.screenings.length });
}));

// ---------- CIF generation (idempotent per recordId) ----------
app.post('/api/cif', guard((req, res) => {
  const { recordId, name } = req.body || {};
  if (!recordId) return res.status(400).json({ error: 'recordId required' });

  const db = load();
  const existing = db.cifRegistry.find(r => r.recordId === recordId);
  if (existing) return res.json({ cif: existing.cif, created: false });

  let cif = null;
  for (let i = 0; i < 5 && !cif; i++) {
    const serial = ++db.counters.cif;
    const base = '88' + String(serial).padStart(7, '0');
    const cd = mod11(base);
    if (cd === 10) continue;                 // unusable check digit — burn serial, take next
    cif = base + cd;
  }
  if (!cif) return res.status(500).json({ error: 'CIF allocation failed' });

  db.cifRegistry.push({ recordId, cif, name: name || null, createdAt: new Date().toISOString() });
  save(db);
  res.json({ cif, created: true });
}));

// ---------- CIF verification (format + check digit + registry lookup) ----------
app.post('/api/cif/verify', guard((req, res) => {
  const { cif } = req.body || {};
  if (!/^\d{10}$/.test(cif || '')) return res.json({ valid: false, reason: 'format' });
  if (String(mod11(cif.slice(0, 9))) !== cif[9]) return res.json({ valid: false, reason: 'checkdigit' });
  const db = load();
  const rec = db.cifRegistry.find(r => r.cif === cif);
  res.json({ valid: true, issued: !!rec, recordId: rec ? rec.recordId : null });
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
  if (db.screenings.length > 200) db.screenings = db.screenings.slice(-200);   // cap the log
  save(db);

  res.json({ result, reason,
    hits: hits.map(h => ({ listName: h.listName, reason: h.reason })),
    screenedAt: new Date().toISOString() });
}));

// ---------- watchlist management (for the live demo flourish) ----------
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

app.listen(process.env.PORT || 3000, () => console.log('SATS demo API up (JSON file mode)'));