import { DatabaseSync } from 'node:sqlite';
import { recordKeys, clean } from './normalize.js';

export const FIELDS = ['brand', 'model', 'model_number', 'box_number', 'variant', 'ram', 'storage', 'color', 'imei', 'quantity', 'notes'];

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff', created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS import_batches (
  id INTEGER PRIMARY KEY, filename TEXT, mode TEXT, username TEXT,
  total_rows INTEGER, imported INTEGER, skipped INTEGER, flagged INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  branch_id INTEGER NOT NULL DEFAULT 1,
  brand TEXT NOT NULL DEFAULT '', model TEXT NOT NULL, model_number TEXT NOT NULL DEFAULT '',
  box_number TEXT NOT NULL,
  variant TEXT NOT NULL DEFAULT '', ram TEXT NOT NULL DEFAULT '', storage TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '', imei TEXT NOT NULL DEFAULT '',
  quantity INTEGER, notes TEXT NOT NULL DEFAULT '',
  extra TEXT NOT NULL DEFAULT '{}',          -- custom / evolving Excel columns
  review_reason TEXT NOT NULL DEFAULT '',    -- non-empty => needs human review
  source TEXT NOT NULL DEFAULT 'manual',
  batch_id INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
  brand_key TEXT NOT NULL, model_key TEXT NOT NULL, number_key TEXT NOT NULL,
  box_key TEXT NOT NULL, bm_key TEXT NOT NULL, search_key TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_inv_brand  ON inventory(brand_key);
CREATE INDEX IF NOT EXISTS ix_inv_model  ON inventory(model_key);
CREATE INDEX IF NOT EXISTS ix_inv_number ON inventory(number_key);
CREATE INDEX IF NOT EXISTS ix_inv_bm     ON inventory(bm_key);
CREATE INDEX IF NOT EXISTS ix_inv_box    ON inventory(box_key);
CREATE INDEX IF NOT EXISTS ix_inv_dup    ON inventory(brand_key, model_key, number_key, box_key);
CREATE INDEX IF NOT EXISTS ix_inv_batch  ON inventory(batch_id);
CREATE INDEX IF NOT EXISTS ix_inv_review ON inventory(review_reason) WHERE review_reason <> '';
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now')),
  username TEXT NOT NULL, action TEXT NOT NULL, record_id INTEGER, detail TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS ix_audit_at ON audit_log(at);
`);
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/** Coerce user input into a clean record. Throws on invalid data. */
export function sanitize(input) {
  const r = {};
  for (const f of FIELDS) r[f] = clean(input[f]);
  if (r.quantity === '') r.quantity = null;
  else {
    const q = Number(r.quantity);
    if (!Number.isInteger(q) || q < 0) throw new Error('Quantity must be a whole number (0 or more)');
    r.quantity = q;
  }
  const extra = {};
  if (input.extra && typeof input.extra === 'object') {
    for (const [k, v] of Object.entries(input.extra)) { const kk = clean(k), vv = clean(v); if (kk && vv) extra[kk] = vv; }
  }
  r.extra = extra;
  r.review_reason = clean(input.review_reason);
  if (!r.model) throw new Error('Model name is required');
  if (!r.box_number) throw new Error('Box number is required');
  return r;
}

const COLS = [...FIELDS, 'extra', 'review_reason'];

export function insertRecord(db, rec, meta = {}) {
  const k = recordKeys(rec);
  const st = db.prepare(`INSERT INTO inventory (uid, ${COLS.join(',')}, source, batch_id, created_by,
      brand_key, model_key, number_key, box_key, bm_key, search_key)
    VALUES (?, ${COLS.map(() => '?').join(',')}, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  return st.run(crypto.randomUUID(), ...COLS.map((c) => (c === 'extra' ? JSON.stringify(rec.extra || {}) : rec[c] ?? '')).map((v, i) => (COLS[i] === 'quantity' && v === '' ? null : v)),
    meta.source || 'manual', meta.batch_id ?? null, meta.user || '',
    k.brand_key, k.model_key, k.number_key, k.box_key, k.bm_key, k.search_key).lastInsertRowid;
}

export function updateRecord(db, id, rec) {
  const k = recordKeys(rec);
  db.prepare(`UPDATE inventory SET ${COLS.map((c) => `${c}=?`).join(',')},
      brand_key=?, model_key=?, number_key=?, box_key=?, bm_key=?, search_key=?, updated_at=datetime('now') WHERE id=?`)
    .run(...COLS.map((c) => (c === 'extra' ? JSON.stringify(rec.extra || {}) : rec[c] ?? '')),
      k.brand_key, k.model_key, k.number_key, k.box_key, k.bm_key, k.search_key, id);
}

export function hydrate(row) {
  if (!row) return row;
  let extra = {};
  try { extra = JSON.parse(row.extra || '{}'); } catch { /* ignore */ }
  const { brand_key, model_key, number_key, box_key, bm_key, search_key, ...pub } = row;
  return { ...pub, extra };
}
