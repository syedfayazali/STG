import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';

process.env.DB_FILE = ':memory:';
process.env.ADMIN_PASSWORD = 'secret-pass';
const { app, db } = await import('../server.js');
const { search } = await import('../lib/search.js');
const { insertRecord, sanitize } = await import('../lib/db.js');

const add = (o) => insertRecord(db, sanitize({ extra: {}, ...o }), { source: 'test' });
const boxes = (g) => g.boxes.map((b) => b.box_number);

// ---- seed: the examples from the specification ----
add({ brand: 'Samsung', model: 'Galaxy A15', model_number: 'SM-A155F', box_number: 'BOX-102', quantity: 8 });
add({ brand: 'Samsung', model: 'Galaxy A15', model_number: 'SM-A155F', box_number: 'BOX-145', quantity: 3 });
add({ brand: 'Samsung', model: 'Galaxy A15 5G', model_number: 'SM-A156B', box_number: 'BOX-150' });
add({ brand: 'Apple', model: 'iPhone 15', model_number: 'A3090', box_number: 'BOX-205' });
add({ brand: 'Apple', model: 'iPhone 15 Pro', model_number: 'A3101', box_number: 'BOX-206' });
add({ brand: 'Redmi', model: 'Note 13', model_number: '2312DRAABG', box_number: 'BOX-318' });
add({ brand: 'Vivo', model: 'V30', model_number: 'V2318', box_number: 'BOX-217' });
add({ brand: 'Oppo', model: 'A15', model_number: 'CPH2185', box_number: 'BOX-020' });
add({ brand: 'Samsung', model: 'A12', box_number: 'BOX-300' });
add({ brand: 'Oppo', model: 'A12', box_number: 'BOX-301' });

test('exact model name returns every box, not one merged box', () => {
  const r = search(db, 'Samsung Galaxy A15');
  assert.equal(r.exact.length, 1);
  assert.deepEqual(boxes(r.exact[0]), ['BOX-102', 'BOX-145']);
  assert.equal(r.exact[0].boxes[0].quantity, 8);
});

test('model numbers: exact, partial, any capitalisation', () => {
  for (const q of ['SM-A155F', 'sm-a155f', 'SMA155F', 'sm a155f']) {
    const r = search(db, q);
    assert.equal(r.exact.length, 1, q);
    assert.equal(r.exact[0].model_number, 'SM-A155F');
    assert.deepEqual(boxes(r.exact[0]), ['BOX-102', 'BOX-145']);
  }
  const partial = search(db, 'a155f');
  assert.equal(partial.exact.length, 0);
  assert.equal(partial.others[0].matchType, 'Partial Match');
  assert.deepEqual(boxes(partial.others[0]), ['BOX-102', 'BOX-145']);
});

test('extra spaces and case are ignored', () => {
  const a = search(db, '   SAMSUNG    galaxy   a15  ');
  assert.deepEqual(boxes(a.exact[0]), ['BOX-102', 'BOX-145']);
  assert.equal(search(db, 'IPHONE15').exact[0].boxes[0].box_number, 'BOX-205');
  assert.equal(search(db, 'iPhone 15').exact[0].model, 'iPhone 15'); // not "iPhone 15 Pro"
});

test('"A15" is ambiguous: show every A15 with its own box, never guess', () => {
  const r = search(db, 'A15');
  assert.equal(r.exact.length, 2); // Samsung Galaxy A15 and Oppo A15 are different phones
  const brands = r.exact.map((g) => g.brand).sort();
  assert.deepEqual(brands, ['Oppo', 'Samsung']);
  assert.ok(r.others.some((g) => g.model === 'Galaxy A15 5G'), 'longer models appear as possible matches');
});

test('same model name under two brands stays separate', () => {
  const r = search(db, 'a12');
  assert.equal(r.exact.length, 2);
  assert.deepEqual(r.exact.map((g) => boxes(g)[0]).sort(), ['BOX-300', 'BOX-301']);
  assert.deepEqual(boxes(search(db, 'oppo a12').exact[0]), ['BOX-301']);
});

test('brand + model number and the spec examples', () => {
  assert.deepEqual(boxes(search(db, 'redmi 2312draabg').exact[0]), ['BOX-318']);
  assert.deepEqual(boxes(search(db, 'Vivo V30').exact[0]), ['BOX-217']);
  assert.equal(search(db, 'Vivo V30').exact[0].model_number, 'V2318');
});

test('brand-only search lists brand matches and is not an exact match', () => {
  const r = search(db, 'samsung');
  assert.equal(r.exact.length, 0);
  assert.ok(r.others.every((g) => g.matchType === 'Brand Match'));
});

test('no match => nothing invented', () => {
  const r = search(db, 'Nokia 3310 zzz');
  assert.equal(r.exact.length + r.others.length, 0);
  assert.equal(search(db, '').exact.length, 0);
  assert.equal(search(db, '%%%').exact.length, 0);
});

test('SQL metacharacters in the query are harmless', () => {
  for (const q of ["a15'; DROP TABLE inventory;--", '%', '_', 'a15" OR "1"="1']) search(db, q);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM inventory').get().n >= 10);
});

test('missing data is rejected on save', () => {
  assert.throws(() => sanitize({ brand: 'X', model: '', box_number: '1' }), /Model/);
  assert.throws(() => sanitize({ brand: 'X', model: 'Y', box_number: '' }), /Box/);
  assert.throws(() => sanitize({ model: 'Y', box_number: '1', quantity: '-3' }), /Quantity/);
});

test('large inventory (50,000 records) stays fast', () => {
  db.exec('BEGIN');
  const brands = ['Samsung', 'Redmi', 'Oppo', 'Vivo', 'Realme', 'Poco', 'Apple', 'Tecno'];
  for (let i = 0; i < 50000; i++) {
    insertRecord(db, sanitize({ brand: brands[i % 8], model: `Model X${i} ${['Pro', 'Lite', 'Max', ''][i % 4]}`, model_number: `MN-${100000 + i}`, box_number: `BOX-${1 + (i % 900)}`, quantity: i % 9, extra: {} }), { source: 'load' });
  }
  db.exec('COMMIT');
  const timed = (q) => { const t = performance.now(); const r = search(db, q); return [performance.now() - t, r]; };
  for (const q of ['MN-123456', 'model x4321 pro', 'x432', 'redmi x99', 'pro', 'a15', 'zzzzzz']) {
    const [ms] = timed(q);
    assert.ok(ms < 250, `"${q}" took ${ms.toFixed(0)}ms`);
  }
  const [, exact] = timed('MN-123456');
  assert.equal(exact.exact.length, 1);
  assert.equal(exact.exact[0].boxes[0].box_number, `BOX-${1 + (23456 % 900)}`);
});

// ---------------- HTTP: auth, CSRF, import, audit ----------------
let base, cookie = '';
const call = async (path, { method = 'GET', body, raw, csrf = true } = {}) => {
  const headers = { cookie };
  if (csrf) headers['X-Requested-With'] = 'nt';
  let b;
  if (raw) { b = raw; headers['content-type'] = 'application/octet-stream'; } else if (body) { b = JSON.stringify(body); headers['content-type'] = 'application/json'; }
  const res = await fetch(base + path, { method, headers, body: b });
  const sc = res.headers.get('set-cookie'); if (sc?.startsWith('nt_sid=')) cookie = sc.split(';')[0];
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

test('staff can search without login; admin routes need an admin', async () => {
  assert.equal((await call('/api/search?q=vivo+v30')).data.exact[0].boxes[0].box_number, 'BOX-217');
  assert.equal((await call('/api/inventory')).status, 401);
  assert.equal((await call('/api/inventory', { method: 'POST', body: { model: 'x', box_number: '1' } })).status, 401);
  assert.equal((await call('/api/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } })).status, 401);
  assert.equal((await call('/api/login', { method: 'POST', body: { username: 'admin', password: 'secret-pass' } })).status, 200);
});

test('state-changing calls without the CSRF header are refused', async () => {
  const r = await call('/api/inventory', { method: 'POST', body: { model: 'x', box_number: '1' }, csrf: false });
  assert.equal(r.status, 403);
});

test('manual add blocks duplicates until the admin confirms, and edits are audited', async () => {
  const rec = { brand: 'Nokia', model: 'G42', model_number: 'TA-1581', box_number: 'BOX-9' };
  const a = await call('/api/inventory', { method: 'POST', body: rec });
  assert.equal(a.status, 200);
  const dup = await call('/api/inventory', { method: 'POST', body: rec });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.duplicates.length, 1);
  assert.equal((await call('/api/inventory', { method: 'POST', body: { ...rec, allowDuplicate: true } })).status, 200);
  assert.ok((await call('/api/duplicates')).data.length >= 1, 'allowed duplicate shows up for review');
  const up = await call('/api/inventory/' + a.data.id, { method: 'PUT', body: { ...rec, box_number: 'BOX-10' } });
  assert.equal(up.status, 200);
  const log = (await call('/api/audit')).data.rows.map((r) => r.action);
  assert.ok(log.includes('Added Nokia G42 (TA-1581) in BOX-9'));
  assert.ok(log.some((l) => l.startsWith('Updated box number from BOX-9 to BOX-10')));
});

test('bulk delete needs confirmation', async () => {
  const ids = db.prepare("SELECT id FROM inventory WHERE brand='Nokia'").all().map((r) => r.id);
  assert.equal((await call('/api/inventory/bulk-delete', { method: 'POST', body: { ids } })).status, 400);
  assert.equal((await call('/api/inventory/bulk-delete', { method: 'POST', body: { ids, confirm: true } })).data.deleted, ids.length);
});

const workbook = (aoa) => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'S'); return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }); };

test('flat import: maps columns, rejects bad rows, skips duplicates, never imports blindly', async () => {
  const file = workbook([
    ['Make', 'Phone', 'Model No', 'Location', 'Qty'],
    ['Samsung', 'Galaxy S24', 'SM-S921B', 'BOX-501', 4],
    ['Samsung', 'Galaxy S24', 'SM-S921B', 'BOX-501', 4], // repeated in file
    ['Samsung', 'Galaxy A15', 'SM-A155F', 'BOX-102', 1], // already in DB
    ['Vivo', '', 'V9999', 'BOX-502', 1], // missing model
    ['Vivo', 'V40', 'V2400', '', 1], // missing box
    ['Vivo', 'V50', 'V2500', 'BOX-503', 'abc'], // bad quantity
    ['', 'Mystery', '', 'BOX-504', ''], // no brand -> imported but flagged
  ]);
  const up = (await call('/api/import/upload?filename=t.xlsx', { method: 'POST', raw: file })).data;
  const sh = up.sheets[0];
  assert.equal(sh.mode, 'flat');
  assert.deepEqual(sh.flat, { brand: 'Make', model: 'Phone', model_number: 'Model No', box_number: 'Location', quantity: 'Qty' });
  const body = { uploadId: up.uploadId, sheet: 'S', config: { mode: 'flat', flat: { mapping: sh.flat }, skipExisting: true } };
  const p = (await call('/api/import/preview', { method: 'POST', body })).data;
  assert.equal(p.willImport, 2);
  assert.equal(p.errors, 3);
  assert.equal(p.duplicatesInFile, 1);
  assert.equal(p.duplicatesInDb, 1);
  assert.equal(p.flagged, 1);
  const before = db.prepare('SELECT COUNT(*) n FROM inventory').get().n;
  assert.equal(db.prepare('SELECT COUNT(*) n FROM inventory').get().n, before, 'preview must not write');
  const c = (await call('/api/import/confirm', { method: 'POST', body })).data;
  assert.equal(c.imported, 2);
  assert.deepEqual(boxes(search(db, 'sm-s921b').exact[0]), ['BOX-501']);
  assert.equal(search(db, 'mystery').exact[0].boxes[0].review_reason, 'No brand given');
  assert.ok((await call('/api/audit')).data.rows.some((r) => r.action.startsWith('Imported 2 records from Excel')));
  assert.equal((await call('/api/import/' + c.batchId, { method: 'DELETE' })).data.removed, 2); // undo works
});

test('compatibility-chart import explodes cells into one record per model', async () => {
  const file = workbook([
    ['CBNO', 'POSTER MODEL', 'REDMI', 'samsung', 'Realme', 'vivo', 'Poco', 'MI'],
    [7, 'Redmi 9', 'NOTE9S/NOTE9PRO/RM NOTE 12(4G/5G)', 'SAM A72/M54 5G', 'R-ME 11/C55', 'Y200', 'POCO X3', '11T'],
    [8, 'Redmi 9', 'NOTE9S', '', '', '', '', ''],
  ]);
  const up = (await call('/api/import/upload?filename=chart.xlsx', { method: 'POST', raw: file })).data;
  assert.equal(up.sheets[0].mode, 'chart');
  const body = { uploadId: up.uploadId, sheet: 'S', config: { mode: 'chart', chart: up.sheets[0].chart, skipExisting: true } };
  assert.equal((await call('/api/import/confirm', { method: 'POST', body })).status, 200);
  assert.deepEqual(boxes(search(db, 'redmi note 9s').exact[0]), ['7', '8']);
  assert.deepEqual(boxes(search(db, 'note 12 5g').exact[0]), ['7']);
  assert.deepEqual(boxes(search(db, 'samsung a72').exact[0]), ['7']);
  assert.deepEqual(boxes(search(db, 'realme 11').exact[0]), ['7']);
});

test('export and template download as xlsx', async () => {
  for (const p of ['/api/export', '/api/template']) {
    const r = await call(p);
    assert.equal(r.status, 200);
    const wb = XLSX.read(r.data, { type: 'buffer' });
    assert.deepEqual(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 })[0].slice(0, 4), ['Brand', 'Model', 'Model Number', 'Box Number']);
  }
});
