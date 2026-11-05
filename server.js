import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, tx, sanitize, insertRecord, updateRecord, hydrate, FIELDS } from './lib/db.js';
import { recordKeys, words, key, boxKey } from './lib/normalize.js';
import { search } from './lib/search.js';
import { readWorkbook, detectMode, suggestFlat, suggestChart, analyze, buildWorkbook, templateBuffer, TEMPLATE_HEADERS, FIELD_LABELS } from './lib/importer.js';
import { hashPassword, verifyPassword, ensureAdmin } from './lib/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'inventory.db');
const SEARCH_REQUIRES_LOGIN = process.env.SEARCH_REQUIRES_LOGIN === '1';
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
export const db = openDb(DB_FILE);
ensureAdmin(db);

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'" });
  next();
});
app.use(express.json({ limit: '5mb' }));
app.use('/api/import/upload', express.raw({ type: '*/*', limit: '60mb' }));

// ---------------- auth ----------------
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const cookieOpts = (req, maxAge) => `Path=/; HttpOnly; SameSite=Strict${req.secure || process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}; Max-Age=${maxAge}`;
function readCookie(req, name) {
  const m = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
}
app.use((req, res, next) => {
  const tok = readCookie(req, 'nt_sid');
  req.user = null;
  if (tok) {
    const row = db.prepare(`SELECT u.id, u.username, u.role, s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(sha(tok));
    if (row && row.expires_at > Date.now()) req.user = { id: row.id, username: row.username, role: row.role };
  }
  next();
});
// CSRF defence: cookies are SameSite=Strict AND every state-changing call must carry this header.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.get('X-Requested-With') !== 'nt') return res.status(403).json({ error: 'Blocked' });
  next();
});
const needUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please sign in' }));
const needAdmin = (req, res, next) => (req.user?.role === 'admin' ? next() : res.status(req.user ? 403 : 401).json({ error: 'Administrator access required' }));
const searchGate = (req, res, next) => (!SEARCH_REQUIRES_LOGIN || req.user ? next() : res.status(401).json({ error: 'Please sign in' }));

const attempts = new Map();
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const a = attempts.get(ip) || { n: 0, until: 0 };
  if (a.until > Date.now()) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const { username = '', password = '' } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username).trim().toLowerCase());
  if (!u || !verifyPassword(String(password), u.password_hash)) {
    a.n++; if (a.n >= 8) { a.until = Date.now() + 5 * 60_000; a.n = 0; }
    attempts.set(ip, a);
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  attempts.delete(ip);
  const tok = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(sha(tok), u.id, Date.now() + SESSION_HOURS * 3600_000);
  res.set('Set-Cookie', `nt_sid=${tok}; ${cookieOpts(req, SESSION_HOURS * 3600)}`);
  audit(u.username, 'Signed in');
  res.json({ user: { username: u.username, role: u.role } });
});
app.post('/api/logout', (req, res) => {
  const tok = readCookie(req, 'nt_sid');
  if (tok) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(tok));
  res.set('Set-Cookie', `nt_sid=; ${cookieOpts(req, 0)}`);
  res.json({ ok: true });
});
app.get('/api/session', (req, res) => res.json({ user: req.user, searchRequiresLogin: SEARCH_REQUIRES_LOGIN }));

function audit(username, action, recordId = null, detail = '') {
  db.prepare('INSERT INTO audit_log (username, action, record_id, detail) VALUES (?,?,?,?)').run(username, action, recordId, detail);
}
const label = (r) => [r.brand, r.model, r.model_number && `(${r.model_number})`].filter(Boolean).join(' ') + ` in ${r.box_number}`;

// ---------------- search (staff) ----------------
app.get('/api/search', searchGate, (req, res) => {
  const q = String(req.query.q || '').slice(0, 120);
  res.json(search(db, q));
});

// ---------------- inventory ----------------
function listWhere(q) {
  const w = [], p = [];
  if (q.q) { const ws = words(q.q); if (ws.length) { w.push(`(${ws.map(() => 'search_key LIKE ?').join(' AND ')} OR bm_key LIKE ?)`); p.push(...ws.map((x) => `%${x}%`), `%${ws.join('')}%`); } }
  if (q.brand) { w.push('brand_key = ?'); p.push(key(q.brand)); }
  if (q.model) { w.push('model_key LIKE ?'); p.push(`%${key(q.model)}%`); }
  if (q.box) { w.push('box_key LIKE ?'); p.push(`%${boxKey(q.box)}%`); }
  if (q.review === '1') w.push("review_reason <> ''");
  if (q.batch) { w.push('batch_id = ?'); p.push(Number(q.batch)); }
  return { sql: w.length ? 'WHERE ' + w.join(' AND ') : '', p };
}

const SORTS = { newest: 'id DESC', brand: 'brand_key, model_key, box_key', model: 'model_key, brand_key', box: 'box_key', updated: 'updated_at DESC' };

app.get('/api/inventory', needAdmin, (req, res) => {
  const { sql, p } = listWhere(req.query);
  const page = Math.max(1, Number(req.query.page) || 1), size = Math.min(200, Number(req.query.size) || 50);
  const order = req.query.sort === 'box' ? 'CAST(box_number AS INTEGER), box_key, model_key' : SORTS[req.query.sort] || SORTS.newest;
  const total = db.prepare(`SELECT COUNT(*) n FROM inventory ${sql}`).get(...p).n;
  const rows = db.prepare(`SELECT * FROM inventory ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...p, size, (page - 1) * size).map(hydrate);
  res.json({ total, page, size, rows });
});

app.get('/api/brands', needUser, (req, res) => {
  res.json(db.prepare(`SELECT brand_key k, MIN(brand) brand, COUNT(*) records FROM inventory WHERE brand_key<>'' GROUP BY brand_key ORDER BY brand`).all());
});

function dupCheck(rec, exceptId = 0) {
  const k = recordKeys(rec);
  return db.prepare('SELECT * FROM inventory WHERE brand_key=? AND model_key=? AND number_key=? AND box_key=? AND id<>?')
    .all(k.brand_key, k.model_key, k.number_key, k.box_key, exceptId).map(hydrate);
}

app.post('/api/inventory', needAdmin, (req, res) => {
  let rec;
  try { rec = sanitize(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
  const dups = dupCheck(rec);
  if (dups.length && !req.body.allowDuplicate) return res.status(409).json({ error: 'This looks like a duplicate of an existing record.', duplicates: dups });
  const id = insertRecord(db, rec, { source: 'manual', user: req.user.username });
  audit(req.user.username, `Added ${label(rec)}`, id);
  res.json({ id });
});

app.put('/api/inventory/:id', needAdmin, (req, res) => {
  const id = Number(req.params.id);
  const old = db.prepare('SELECT * FROM inventory WHERE id=?').get(id);
  if (!old) return res.status(404).json({ error: 'Record not found' });
  let rec;
  try { rec = sanitize(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
  const dups = dupCheck(rec, id);
  if (dups.length && !req.body.allowDuplicate) return res.status(409).json({ error: 'Another record already has the same brand, model, model number and box.', duplicates: dups });
  updateRecord(db, id, rec);
  const changes = FIELDS.filter((f) => String(old[f] ?? '') !== String(rec[f] ?? '')).map((f) => `${FIELD_LABELS[f]} "${old[f] ?? ''}" -> "${rec[f] ?? ''}"`);
  audit(req.user.username, old.box_number !== rec.box_number ? `Updated box number from ${old.box_number} to ${rec.box_number} (${[rec.brand, rec.model].join(' ')})` : `Updated ${[rec.brand, rec.model].join(' ')}`, id, changes.join('; '));
  res.json({ ok: true });
});

app.delete('/api/inventory/:id', needAdmin, (req, res) => {
  const id = Number(req.params.id);
  const old = db.prepare('SELECT * FROM inventory WHERE id=?').get(id);
  if (!old) return res.status(404).json({ error: 'Record not found' });
  db.prepare('DELETE FROM inventory WHERE id=?').run(id);
  audit(req.user.username, `Deleted inventory record: ${label(old)}`, id);
  res.json({ ok: true });
});

const idsOf = (b) => [...new Set((Array.isArray(b?.ids) ? b.ids : []).map(Number).filter(Number.isInteger))].slice(0, 5000);
app.post('/api/inventory/bulk-delete', needAdmin, (req, res) => {
  const ids = idsOf(req.body);
  if (!ids.length) return res.status(400).json({ error: 'Nothing selected' });
  if (req.body.confirm !== true) return res.status(400).json({ error: 'Confirmation required' });
  const n = tx(db, () => ids.reduce((s, id) => s + db.prepare('DELETE FROM inventory WHERE id=?').run(id).changes, 0));
  audit(req.user.username, `Bulk deleted ${n} inventory records`, null, `ids: ${ids.slice(0, 50).join(',')}${ids.length > 50 ? '…' : ''}`);
  res.json({ deleted: n });
});
app.post('/api/inventory/bulk-update', needAdmin, (req, res) => {
  const ids = idsOf(req.body);
  const box = String(req.body.box_number ?? '').trim();
  if (!ids.length || !box) return res.status(400).json({ error: 'Select records and enter a box number' });
  if (req.body.confirm !== true) return res.status(400).json({ error: 'Confirmation required' });
  const n = tx(db, () => ids.reduce((s, id) => {
    const r = db.prepare('SELECT * FROM inventory WHERE id=?').get(id);
    if (!r) return s;
    updateRecord(db, id, { ...hydrate(r), box_number: box });
    return s + 1;
  }, 0));
  audit(req.user.username, `Bulk moved ${n} records to ${box}`, null, `ids: ${ids.slice(0, 50).join(',')}`);
  res.json({ updated: n });
});

// ---------------- duplicates & review ----------------
app.get('/api/duplicates', needAdmin, (req, res) => {
  const groups = db.prepare(`SELECT brand_key, model_key, number_key, box_key, COUNT(*) n FROM inventory
      GROUP BY brand_key, model_key, number_key, box_key HAVING n > 1 ORDER BY n DESC LIMIT 200`).all();
  res.json(groups.map((g) => ({
    n: g.n,
    rows: db.prepare('SELECT * FROM inventory WHERE brand_key=? AND model_key=? AND number_key=? AND box_key=? ORDER BY id').all(g.brand_key, g.model_key, g.number_key, g.box_key).map(hydrate),
  })));
});

// ---------------- dashboard ----------------
app.get('/api/dashboard', needAdmin, (req, res) => {
  const one = (sql) => db.prepare(sql).get();
  res.json({
    totalModels: one(`SELECT COUNT(*) n FROM (SELECT 1 FROM inventory GROUP BY brand_key, model_key, number_key)`).n,
    totalRecords: one('SELECT COUNT(*) n FROM inventory').n,
    totalUnits: one('SELECT COALESCE(SUM(quantity),0) n FROM inventory').n,
    recordsWithQuantity: one('SELECT COUNT(*) n FROM inventory WHERE quantity IS NOT NULL').n,
    boxes: one('SELECT COUNT(DISTINCT box_key) n FROM inventory').n,
    brands: db.prepare(`SELECT MIN(brand) brand, COUNT(*) records FROM inventory WHERE brand_key<>'' GROUP BY brand_key ORDER BY records DESC`).all(),
    recentModels: db.prepare('SELECT * FROM inventory ORDER BY id DESC LIMIT 8').all().map(hydrate),
    recentImports: db.prepare('SELECT * FROM import_batches ORDER BY id DESC LIMIT 6').all(),
    needReview: one(`SELECT COUNT(*) n FROM inventory WHERE review_reason<>''`).n,
    duplicates: one(`SELECT COUNT(*) n FROM (SELECT 1 FROM inventory GROUP BY brand_key, model_key, number_key, box_key HAVING COUNT(*)>1)`).n,
  });
});

// ---------------- audit ----------------
app.get('/api/audit', needAdmin, (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1), size = 50;
  const total = db.prepare('SELECT COUNT(*) n FROM audit_log').get().n;
  res.json({ total, page, size, rows: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?').all(size, (page - 1) * size) });
});

// ---------------- import ----------------
const uploads = new Map(); // id -> {sheets, filename, expires}
setInterval(() => { for (const [k, v] of uploads) if (v.expires < Date.now()) uploads.delete(k); }, 60_000).unref();

app.post('/api/import/upload', needAdmin, (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'No file received' });
  let sheets;
  try { sheets = readWorkbook(req.body); } catch (e) { return res.status(400).json({ error: 'Could not read that file. Please upload a valid .xlsx or .xls file.' }); }
  if (!sheets.length) return res.status(400).json({ error: 'The file has no data rows (a header row plus at least one row is needed).' });
  const id = crypto.randomUUID();
  uploads.set(id, { sheets, filename: String(req.query.filename || 'upload.xlsx').slice(0, 200), expires: Date.now() + 30 * 60_000 });
  res.json({
    uploadId: id,
    sheets: sheets.map((s) => {
      const mode = detectMode(s.headers);
      return { name: s.name, rows: s.rows.length, headers: s.headers, mode, flat: suggestFlat(s.headers), chart: suggestChart(s.headers),
        sample: s.rows.slice(0, 5).map((r) => r.map((c) => String(c).slice(0, 80))) };
    }),
  });
});

function runAnalysis(req) {
  const up = uploads.get(req.body.uploadId);
  if (!up) throw Object.assign(new Error('Upload expired - please upload the file again.'), { status: 410 });
  const sheet = up.sheets.find((s) => s.name === req.body.sheet);
  if (!sheet) throw new Error('Sheet not found');
  return { up, sheet, result: analyze(db, sheet, req.body.config || {}) };
}

app.post('/api/import/preview', needAdmin, (req, res) => {
  try {
    const { result: r } = runAnalysis(req);
    res.json({
      totalRows: r.totalRows, candidates: r.candidates, willImport: r.toImport.length, errors: r.errors.length,
      duplicatesInFile: r.dupFile.length, duplicatesInDb: r.dupDb.length, flagged: r.flagged,
      sample: r.toImport.slice(0, 120).map((c) => ({ row: c.row, ...c.rec })),
      flaggedSample: r.toImport.filter((c) => c.rec.review_reason).slice(0, 120).map((c) => ({ row: c.row, ...c.rec })),
      errorList: r.errors.slice(0, 200),
      dupFileList: r.dupFile.slice(0, 100).map((d) => ({ row: d.row, firstRow: d.firstRow, ...d.rec })),
      dupDbList: r.dupDb.slice(0, 100).map((d) => ({ row: d.row, ...d.rec })),
    });
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

app.post('/api/import/confirm', needAdmin, (req, res) => {
  try {
    const { up, result: r } = runAnalysis(req);
    if (!r.toImport.length) return res.status(400).json({ error: 'There are no valid rows to import.' });
    const out = tx(db, () => {
      const b = db.prepare(`INSERT INTO import_batches (filename, mode, username, total_rows, imported, skipped, flagged) VALUES (?,?,?,?,?,?,?)`)
        .run(up.filename, req.body.config.mode, req.user.username, r.totalRows, r.toImport.length, r.candidates - r.toImport.length + r.errors.length, r.flagged).lastInsertRowid;
      for (const c of r.toImport) insertRecord(db, c.rec, { source: 'import', batch_id: b, user: req.user.username });
      return b;
    });
    audit(req.user.username, `Imported ${r.toImport.length} records from Excel (${up.filename})`, null, `batch ${out}; skipped duplicates ${r.dupFile.length + (req.body.config.skipExisting === false ? 0 : r.dupDb.length)}; rejected rows ${r.errors.length}; flagged ${r.flagged}`);
    res.json({ batchId: Number(out), imported: r.toImport.length });
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

app.delete('/api/import/:batch', needAdmin, (req, res) => {
  const id = Number(req.params.batch);
  const b = db.prepare('SELECT * FROM import_batches WHERE id=?').get(id);
  if (!b) return res.status(404).json({ error: 'Import not found' });
  const n = tx(db, () => { const c = db.prepare('DELETE FROM inventory WHERE batch_id=?').run(id).changes; db.prepare('DELETE FROM import_batches WHERE id=?').run(id); return c; });
  audit(req.user.username, `Undid import #${id}: removed ${n} records (${b.filename})`);
  res.json({ removed: n });
});

// ---------------- export / template ----------------
const xlsxHeaders = (res, name) => res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${name}"` });
app.get('/api/template', needAdmin, (req, res) => { xlsxHeaders(res, 'inventory-template.xlsx'); res.send(templateBuffer()); });
app.get('/api/export', needAdmin, (req, res) => {
  const { sql, p } = listWhere(req.query);
  const rows = db.prepare(`SELECT * FROM inventory ${sql} ORDER BY CAST(box_number AS INTEGER), box_key, brand_key, model_key`).all(...p).map(hydrate);
  const extraKeys = [...new Set(rows.flatMap((r) => Object.keys(r.extra)))];
  const headers = [...TEMPLATE_HEADERS, 'IMEI', ...extraKeys, 'ID'];
  const data = rows.map((r) => [r.brand, r.model, r.model_number, r.box_number, r.variant, r.ram, r.storage, r.color, r.quantity ?? '', r.notes, r.imei, ...extraKeys.map((k) => r.extra[k] ?? ''), r.id]);
  audit(req.user.username, `Exported ${rows.length} records to Excel`);
  xlsxHeaders(res, `inventory-${new Date().toISOString().slice(0, 10)}.xlsx`);
  res.send(buildWorkbook(data, headers));
});

// ---------------- static ----------------
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: true }));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }); // eslint-disable-line

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, () => console.log(`New Trendz inventory running on http://localhost:${PORT}`));
}
export { app, hashPassword };
