// Text normalisation shared by import, save and search.
// Everything searchable is reduced to lowercase alphanumeric "keys" so that
// "Note 10 Pro", "NOTE10PRO" and "note-10-pro" are all the same thing.

const GREEK = {
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M',
  'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X', 'ο': 'o',
};

// Words that carry no identity ("Galaxy A15" == "A15").
const FILLER = new Set(['galaxy', 'mobile', 'phone', 'smartphone']);

// Shop shorthand -> canonical brand word. Applied to inventory text AND to queries.
const ALIASES = [
  [/\bone\s*plus(?![a-z])\s*/g, 'oneplus '],
  [/(?<![a-z0-9])1\s*\+\s*/g, 'oneplus '],
  [/\br\s*-\s*me\b/g, 'realme'],
  [/\brlme\b|\brme\b|\bre\b/g, 'realme'],
  [/\bsam\s*sung\b|\bsasung\b|\bsam\b/g, 'samsung'],
  [/\bi\s*q\s*[o0]{2}/g, 'iqoo'],
  [/\btechno\b/g, 'tecno'],
  [/\bmotorola\b/g, 'moto'],
  [/\brmi\b|\brm\b/g, 'redmi'],
  [/\binfi\b|\binf\b/g, 'infinix'],
  [/\bhw\b/g, 'huawei'],
  [/\bvo\b|\bvi\b/g, 'vivo'],
  [/\bop\b/g, 'oppo'],
  [/\bhon\b/g, 'honor'],
  [/\btcn\b/g, 'tecno'],
];

export const BRAND_NAMES = {
  redmi: 'Redmi', oppo: 'Oppo', samsung: 'Samsung', realme: 'Realme', oneplus: 'OnePlus',
  vivo: 'Vivo', poco: 'Poco', mi: 'Mi', iqoo: 'iQOO', moto: 'Moto', tecno: 'Tecno',
  lg: 'LG', huawei: 'Huawei', nothing: 'Nothing', infinix: 'Infinix', honor: 'Honor',
  itel: 'Itel', apple: 'Apple', xiaomi: 'Xiaomi', nokia: 'Nokia', google: 'Google',
  lava: 'Lava', asus: 'Asus', sony: 'Sony',
};

/** Normalised word list for any text. */
export function words(str) {
  let s = String(str ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/[Α-ω]/g, (c) => GREEK[c] ?? c).toLowerCase();
  for (const [re, rep] of ALIASES) s = s.replace(re, rep);
  return s.replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w && !FILLER.has(w));
}

/** Alphanumeric key: spaces, hyphens and case removed. */
export const key = (str) => words(str).join('');

/** Box numbers: case/punctuation-insensitive ("BOX-102" == "box 102"). */
export const boxKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

export function canonBrand(raw) {
  const clean = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const k = key(clean);
  return BRAND_NAMES[k] || clean;
}

export const isBrandWord = (w) => Object.hasOwn(BRAND_NAMES, w);

export const clean = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());

/** Every derived/indexed column for an inventory record. */
export function recordKeys(r) {
  const brand_key = key(r.brand);
  const model_key = key(r.model);
  const number_key = key(r.model_number);
  // poster_model is the box's label, not part of the phone's identity, so it is kept out of search (avoids cross-brand false hits)
  const extraVals = r.extra && typeof r.extra === 'object' ? Object.entries(r.extra).filter(([k]) => k !== 'poster_model').map(([, v]) => v).join(' ') : '';
  const other = [key([r.variant, r.ram, r.storage, r.color].join(' ')), key(r.imei), key(extraVals)];
  return {
    brand_key,
    model_key,
    number_key,
    box_key: boxKey(r.box_number),
    bm_key: brand_key + model_key,
    search_key: '|' + [brand_key, model_key, number_key, ...other].filter(Boolean).join('|') + '|',
  };
}

export const dupKey = (k) => `${k.brand_key}\u0001${k.model_key}\u0001${k.number_key}\u0001${k.box_key}`;
