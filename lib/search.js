import { words } from './normalize.js';
import { hydrate } from './db.js';

// Tiers, best first. Tiers 1-2 are "exact"; everything else is a *possible* match.
const TIER = {
  BRAND: { n: 0, type: 'Brand Match', exact: false },
  NUMBER: { n: 1, type: 'Exact Match', exact: true },
  MODEL: { n: 2, type: 'Exact Match', exact: true },
  PREFIX: { n: 3, type: 'Model Match', exact: false },
  PARTIAL: { n: 4, type: 'Partial Match', exact: false },
};

const nextKey = (k) => k.slice(0, -1) + String.fromCharCode(k.charCodeAt(k.length - 1) + 1);

export function search(db, rawQuery, { limit = 150 } = {}) {
  const ws = words(rawQuery);
  const qk = ws.join('');
  const out = { query: String(rawQuery ?? '').trim(), normalized: ws.join(' '), exact: [], others: [], totalRecords: 0, truncated: false };
  if (!qk) return out;

  const seen = new Set();
  const hits = []; // {row, tier, reason}
  const run = (sql, params, tier, reason, cap = 400) => {
    const rows = db.prepare(sql + ` LIMIT ${cap + 1}`).all(...params);
    if (rows.length > cap) { out.truncated = true; rows.length = cap; }
    for (const row of rows) if (!seen.has(row.id)) { seen.add(row.id); hits.push({ row, tier, reason }); }
    return rows.length;
  };
  const ORDER = 'ORDER BY length(model_key), model_key, box_key';

  // 0. Whole query is a brand name -> brand listing only (never guess a model).
  if (ws.length === 1 && db.prepare('SELECT 1 FROM inventory WHERE brand_key=? LIMIT 1').get(qk)) {
    run(`SELECT * FROM inventory WHERE brand_key=? ORDER BY model_key, box_key`, [qk], TIER.BRAND, 'Brand', 300);
  } else {
    // 1. exact model number
    run(`SELECT * FROM inventory WHERE number_key=? ${ORDER}`, [qk], TIER.NUMBER, 'Model number matches exactly', 2000);
    // 2. exact model / exact brand+model
    run(`SELECT * FROM inventory WHERE model_key=? OR bm_key=? ${ORDER}`, [qk, qk], TIER.MODEL, 'Model name matches exactly', 2000);
    // 2b. "<brand> <model or number>" where the brand is known
    if (ws.length > 1) {
      const rest = ws.slice(1).join('');
      run(`SELECT * FROM inventory WHERE brand_key=? AND (model_key=? OR number_key=?) ${ORDER}`,
        [ws[0], rest, rest], TIER.MODEL, 'Brand and model match exactly', 2000);
    }
    // 3. starts-with (index range scans)
    const hi = nextKey(qk);
    run(`SELECT * FROM inventory WHERE (number_key>=? AND number_key<?) OR (model_key>=? AND model_key<?) OR (bm_key>=? AND bm_key<?) ${ORDER}`,
      [qk, hi, qk, hi, qk, hi], TIER.PREFIX, 'Model starts with your search');
    // 4. contains / all words present
    let where = `search_key LIKE ? OR bm_key LIKE ?`;
    const params = [`%${qk}%`, `%${qk}%`];
    if (ws.length > 1) { where += ` OR (${ws.map(() => 'search_key LIKE ?').join(' AND ')})`; params.push(...ws.map((w) => `%${w}%`)); }
    run(`SELECT * FROM inventory WHERE ${where} ${ORDER}`, params, TIER.PARTIAL, 'Partial match');
  }

  // Group by phone identity (brand + model + model number) so one phone in several boxes is ONE card with ALL boxes.
  const groups = new Map();
  for (const { row, tier, reason } of hits) {
    const gk = `${row.brand_key}|${row.model_key}|${row.number_key}`;
    let g = groups.get(gk);
    if (!g) {
      g = { brand: row.brand, model: row.model, model_number: row.model_number, matchType: tier.type, reason, exact: tier.exact, tier: tier.n, boxes: [] };
      groups.set(gk, g);
    }
    const rec = hydrate(row);
    g.boxes.push({
      id: rec.id, box_number: rec.box_number, quantity: rec.quantity, variant: rec.variant, ram: rec.ram,
      storage: rec.storage, color: rec.color, notes: rec.notes, review_reason: rec.review_reason,
      poster_model: rec.extra?.poster_model || '', extra: rec.extra,
    });
    out.totalRecords++;
  }
  const list = [...groups.values()].sort((a, b) => a.tier - b.tier);
  for (const g of list) {
    g.boxes.sort((a, b) => a.box_number.localeCompare(b.box_number, undefined, { numeric: true }));
    (g.exact ? out.exact : out.others).push(g);
  }
  if (out.others.length > limit) { out.others.length = limit; out.truncated = true; }
  return out;
}
