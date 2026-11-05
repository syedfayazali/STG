import * as XLSX from 'xlsx';
import { key, boxKey as hkey, words, clean, canonBrand, isBrandWord, recordKeys, dupKey, BRAND_NAMES } from './normalize.js';
import { FIELDS } from './db.js';

export const TEMPLATE_HEADERS = ['Brand', 'Model', 'Model Number', 'Box Number', 'Variant', 'RAM', 'Storage', 'Color', 'Quantity', 'Notes'];
export const FIELD_LABELS = {
  brand: 'Brand', model: 'Model', model_number: 'Model Number', box_number: 'Box Number', variant: 'Variant',
  ram: 'RAM', storage: 'Storage', color: 'Color', imei: 'IMEI', quantity: 'Quantity', notes: 'Notes',
};
const SYNONYMS = {
  brand: ['brand', 'make', 'company', 'manufacturer'],
  model: ['model', 'modelname', 'name', 'product', 'phone', 'mobile', 'item'],
  model_number: ['modelnumber', 'modelno', 'modelnum', 'mn', 'sku', 'partno', 'code', 'modelcode'],
  box_number: ['boxnumber', 'boxno', 'box', 'cbno', 'cb', 'location', 'bin', 'boxnum'],
  variant: ['variant', 'version'], ram: ['ram', 'memory'], storage: ['storage', 'rom'], color: ['color', 'colour'],
  imei: ['imei'], quantity: ['quantity', 'qty', 'units', 'stock', 'count'], notes: ['notes', 'note', 'remarks', 'comment', 'comments'],
};

// ---------- workbook reading ----------
export function readWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheets = [];
  for (const name of wb.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', blankrows: false, raw: false });
    const rows = aoa.filter((r) => r.some((c) => clean(c) !== ''));
    if (rows.length < 2) continue;
    const headers = rows[0].map((h, i) => clean(h) || `Column ${i + 1}`);
    sheets.push({ name, headers, rows: rows.slice(1), headerRow: 1 });
  }
  return sheets;
}

export function detectMode(headers) {
  const hk = headers.map((h) => hkey(h));
  const hasBox = hk.some((h) => SYNONYMS.box_number.includes(h));
  const brandCols = headers.filter((h) => isBrandWord(key(h)) || BRAND_NAMES[key(h)]);
  const hasModel = hk.some((h) => SYNONYMS.model.includes(h));
  return hasBox && brandCols.length >= 4 && !hk.includes('brand') ? 'chart' : hasModel || hk.includes('brand') ? 'flat' : brandCols.length >= 4 ? 'chart' : 'flat';
}

export function suggestFlat(headers) {
  const map = {};
  const used = new Set();
  for (const f of Object.keys(SYNONYMS)) {
    const idx = headers.findIndex((h, i) => !used.has(i) && SYNONYMS[f].includes(hkey(h)));
    if (idx >= 0) { map[f] = headers[idx]; used.add(idx); }
  }
  return map;
}

export function suggestChart(headers) {
  const hk = headers.map((h) => hkey(h));
  const box = headers[hk.findIndex((h) => SYNONYMS.box_number.includes(h))] || headers[0];
  const label = headers.find((h, i) => ['postermodel', 'poster', 'label', 'title'].includes(hk[i])) || '';
  const brandColumns = headers.filter((h) => h !== box && h !== label && BRAND_NAMES[key(h)])
    .map((h) => ({ column: h, brand: canonBrand(h) }));
  return { boxColumn: box, labelColumn: label, brandColumns };
}

// ---------- compatibility-chart cell parsing ----------
const GEN = /^[2-6]g$/;
// Brands whose chart cells list bare numbers after a family name ("SPARK 4/7/8/8C"): the number inherits the family.
const FAMILY_BRANDS = new Set(['tecno', 'infinix', 'itel']);
const FAMILIES = new Set(['spark', 'camon', 'hot', 'smart', 'pop', 'note', 'zero', 'pova', 'phantom']);
const pretty = (m) => m.replace(/PROMAX/g, 'PRO MAX').replace(/([A-Z]{3,})(\d)/g, '$1 $2').replace(/(\d)(PRO|MAX|LITE|PLUS|ULTRA|NEO)\b/g, '$1 $2').replace(/\s+/g, ' ').trim();

/** Split one chart cell ("A1/A2(4G/5G)/REDMI NOTE 9") into clean model strings for a brand. */
export function parseChartCell(cell, brandName) {
  const brandKey = key(brandName);
  const text = String(cell ?? '');
  if (!clean(text)) return [];
  // protect slashes inside parentheses
  const protectedText = text.replace(/\(([^()]*)\)/g, (_, inner) => `(${inner.replace(/\//g, '¦')})`);
  const pieces = protectedText.split(/[\/\n\r]+/);

  // expand "(4G/5G)" groups
  const expanded = [];
  for (const p of pieces) {
    const m = p.match(/^(.*?)\(([^()]*)\)(.*)$/);
    if (m) {
      const parts = m[2].split('¦').map((s) => s.trim()).filter(Boolean);
      if (parts.length && parts.every((s) => GEN.test(s.toLowerCase()))) {
        if (m[1].trim()) expanded.push(`${m[1]} ${m[3]}`);
        for (const g of parts) expanded.push(`${m[1]} ${g} ${m[3]}`);
        continue;
      }
      expanded.push(`${m[1]} ${m[3]}`); // drop non-generation notes such as "(india)"
    } else expanded.push(p.replace(/¦/g, ' '));
  }

  const results = [];
  let lastBase = null;
  let family = null;
  for (const piece of expanded) {
    let ws = words(piece).flatMap((w) => (brandKey.length >= 4 && w.length > brandKey.length && w.startsWith(brandKey) ? [brandKey, w.slice(brandKey.length)] : [w]));
    if (!ws.length) continue;
    // a lone "5G" continues the previous model ("RENO 13F 4G/5G")
    if (ws.length === 1 && GEN.test(ws[0]) && lastBase) {
      const base = lastBase.slice();
      if (GEN.test(base[base.length - 1] || '')) base.pop();
      ws = [...base, ws[0]];
    }
    // split where the brand name is repeated mid-text ("REDMI A REDMI B")
    const segs = [];
    let cur = [];
    for (const w of ws) {
      if (w === brandKey && cur.length && brandKey !== 'mi') { segs.push(cur); cur = [w]; } else cur.push(w);
    }
    segs.push(cur);
    for (let seg of segs) {
      let brand = brandName;
      while (seg.length && seg[0] === brandKey) seg = seg.slice(1);
      if (seg.length > 1 && isBrandWord(seg[0]) && seg[0] !== brandKey) { brand = canonBrand(seg[0]); seg = seg.slice(1); }
      if (!seg.length || (seg.length === 1 && GEN.test(seg[0]) && !lastBase)) continue;
      lastBase = seg;
      let inferred = '';
      if (FAMILY_BRANDS.has(key(brand))) {
        if (FAMILIES.has(seg[0])) family = seg[0];
        else if (family && /^\d/.test(seg[0]) && !GEN.test(seg[0])) { seg = [family, ...seg]; inferred = family.toUpperCase(); }
        else if (!/^\d/.test(seg[0])) family = null;
      }
      results.push({ brand, model: pretty(seg.join(' ').toUpperCase()), inferred });
    }
  }
  return results;
}

const COMMON = new Set(['pro', 'plus', 'lite', 'max', 'ultra', 'neo', 'gt', 'prime', 'power', 'play', 'core', 'edition', 'china', 'india']);
function reviewReason(model) {
  const ws = model.toLowerCase().split(' ');
  if (model.length > 32 || ws.length >= 5) return 'Long entry - may be several models joined without a "/"';
  const seen = new Set();
  const full = new Set();
  for (const w of ws) {
    if (w.length >= 3 && !COMMON.has(w) && !/^\d?g$/.test(w)) { if (full.has(w)) return 'Repeated word - may be several models joined without a "/"'; full.add(w); }
    const stem = w.replace(/\d+[a-z]?$/, '');
    if (stem.length >= 3 && !COMMON.has(stem) && !/^\d?g$/.test(stem)) {
      if (seen.has(stem)) return 'Repeated word - may be several models joined without a "/"';
      seen.add(stem);
    }
  }
  return '';
}

// ---------- analysis ----------
function existingKeys(db) {
  const set = new Set();
  for (const r of db.prepare('SELECT brand_key, model_key, number_key, box_key FROM inventory').iterate()) set.add(dupKey(r));
  return set;
}

/**
 * Turn a sheet + config into candidate records and validation results. Pure w.r.t. the sheet; reads DB only for duplicate checks.
 * cfg: { mode, flat:{mapping, keepExtra}, chart:{boxColumn,labelColumn,brandColumns:[{column,brand}]}, skipExisting }
 */
export function analyze(db, sheet, cfg) {
  const idx = Object.fromEntries(sheet.headers.map((h, i) => [h, i]));
  const cand = []; // {row, rec}
  const errors = [];
  const err = (row, reason, data) => errors.push({ row, reason, data });

  if (cfg.mode === 'chart') {
    const c = cfg.chart || {};
    const bi = idx[c.boxColumn];
    if (bi == null) throw new Error('Choose the column that holds the box number');
    const cols = (c.brandColumns || []).filter((b) => idx[b.column] != null && clean(b.brand));
    if (!cols.length) throw new Error('Choose at least one brand column');
    sheet.rows.forEach((r, i) => {
      const rowNo = i + 2;
      const box = clean(r[bi]);
      const label = c.labelColumn && idx[c.labelColumn] != null ? clean(r[idx[c.labelColumn]]) : '';
      if (!box) { if (cols.some((b) => clean(r[idx[b.column]]))) err(rowNo, 'Missing box number', { label }); return; }
      for (const b of cols) {
        for (const m of parseChartCell(r[idx[b.column]], canonBrand(b.brand))) {
          cand.push({ row: rowNo, rec: {
            brand: m.brand, model: m.model, model_number: '', box_number: box, variant: '', ram: '', storage: '', color: '',
            imei: '', quantity: null, notes: m.inferred ? `Model family "${m.inferred}" inferred from the entry before it in the chart` : '', extra: label ? { poster_model: label } : {}, review_reason: reviewReason(m.model),
          } });
        }
      }
    });
  } else {
    const map = cfg.flat?.mapping || {};
    if (!map.model) throw new Error('Map a column to Model');
    if (!map.box_number) throw new Error('Map a column to Box Number');
    const mapped = new Set(Object.values(map));
    sheet.rows.forEach((r, i) => {
      const rowNo = i + 2;
      const get = (f) => (map[f] && idx[map[f]] != null ? clean(r[idx[map[f]]]) : '');
      const rec = Object.fromEntries(FIELDS.map((f) => [f, get(f)]));
      rec.brand = canonBrand(rec.brand);
      const data = { brand: rec.brand, model: rec.model, model_number: rec.model_number, box_number: rec.box_number };
      if (!rec.model) return err(rowNo, 'Missing model name', data);
      if (!rec.box_number) return err(rowNo, 'Missing box number', data);
      if (rec.quantity === '') rec.quantity = null;
      else if (!/^\d+$/.test(rec.quantity)) return err(rowNo, `Quantity "${rec.quantity}" is not a whole number`, data);
      else rec.quantity = Number(rec.quantity);
      rec.extra = {};
      if (cfg.flat?.keepExtra) sheet.headers.forEach((h, j) => { if (!mapped.has(h) && clean(r[j])) rec.extra[h] = clean(r[j]); });
      rec.review_reason = rec.brand ? '' : 'No brand given';
      cand.push({ row: rowNo, rec });
    });
  }

  // duplicates
  const inDb = existingKeys(db);
  const seen = new Map();
  const toImport = [], dupFile = [], dupDb = [];
  for (const c of cand) {
    const dk = dupKey(recordKeys(c.rec));
    if (seen.has(dk)) { dupFile.push({ row: c.row, rec: c.rec, firstRow: seen.get(dk) }); continue; }
    seen.set(dk, c.row);
    if (inDb.has(dk)) { dupDb.push({ row: c.row, rec: c.rec }); if (cfg.skipExisting !== false) continue; c.rec.review_reason ||= 'Possible duplicate of an existing record'; }
    toImport.push(c);
  }
  return {
    totalRows: sheet.rows.length,
    candidates: cand.length,
    toImport, errors, dupFile, dupDb,
    flagged: toImport.filter((c) => c.rec.review_reason).length,
  };
}

// ---------- Excel output ----------
export function buildWorkbook(rows, headers) {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws['!cols'] = headers.map((h) => ({ wch: Math.max(12, h.length + 2) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Inventory');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

export function templateBuffer() {
  return buildWorkbook([
    ['Samsung', 'Galaxy A15', 'SM-A155F', 'BOX-102', '8GB/128GB', '8GB', '128GB', 'Blue', 8, 'Example row - delete me'],
    ['Apple', 'iPhone 15', 'A3090', 'BOX-205', '', '6GB', '128GB', 'Black', 2, ''],
  ], TEMPLATE_HEADERS);
}
