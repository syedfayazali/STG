// Smart Tempered Glass — single-page app (no build step). Talks to the "stg" Supabase project.
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { words, key, boxKey, recordKeys } from './normalize.js';
import { readWorkbook, detectMode, suggestFlat, suggestChart, analyze, toDbRow, FIELD_LABELS, TEMPLATE_HEADERS, downloadXlsx, downloadTemplate } from './importer.js';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n || 0).toLocaleString('en-IN');
const app = $('#app');
const state = { session: null, isAdmin: false };

// ------------------------------------------------------------------ helpers
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2000); }
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); } catch { const ta = document.createElement('textarea'); ta.value = text; document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
  toast(`Copied ${text}`);
}
const dlg = $('#dlg');
const showDialog = (html) => { dlg.innerHTML = `<div class="dlg">${html}</div>`; if (!dlg.open) dlg.showModal(); return dlg; };
const closeDialog = () => { if (dlg.open) dlg.close(); };
function confirmDialog(message, ok = 'Confirm', danger = true) {
  return new Promise((resolve) => {
    showDialog(`<h3>Please confirm</h3><div>${message}</div><div class="actions"><button class="btn" id="c-no">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" id="c-yes">${esc(ok)}</button></div>`);
    $('#c-no').onclick = () => { closeDialog(); resolve(false); };
    $('#c-yes').onclick = () => { closeDialog(); resolve(true); };
    dlg.oncancel = () => resolve(false);
  });
}
const friendly = (e) => (e?.message || 'Something went wrong').replace(/^.*Administrator access required.*$/i, 'Administrator access required');
async function audit(action, recordId = null, detail = '') {
  const { error } = await sb.from('audit_log').insert({ action, record_id: recordId, detail });
  if (error) console.warn('audit failed', error.message);
}
const labelOf = (r) => [r.brand, r.model, r.model_number && `(${r.model_number})`].filter(Boolean).join(' ') + ` in ${r.box_number}`;

const ICON_SEARCH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`;
const LOGO = `<svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#9dc3f5"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="#16223f"/><rect x="19" y="9" width="26" height="46" rx="6" fill="none" stroke="url(#lg)" stroke-width="3.5"/><path d="M26 12 L38 12 L24 52 L19 52 Z" fill="#fff" opacity=".22"/><circle cx="32" cy="48" r="2.4" fill="url(#lg)"/></svg>`;

// ------------------------------------------------------------------ auth + routing
let adminCheck = null;
function refreshAdmin() {
  // Never flip isAdmin to false while a check is running (that raced with login and showed "not an admin").
  if (!state.session) { state.isAdmin = false; return Promise.resolve(); }
  const uid = state.session.user.id;
  if (adminCheck && adminCheck.uid === uid) return adminCheck.p;
  const p = sb.rpc('is_admin').then(({ data, error }) => { if (!error) state.isAdmin = data === true; })
    .catch(() => {}).finally(() => { adminCheck = null; });
  adminCheck = { uid, p };
  return p;
}
const route = () => (location.hash.replace(/^#\/?/, '') || '').split('?')[0];
const query = () => new URLSearchParams(location.hash.split('?')[1] || '');
window.addEventListener('hashchange', render);

async function boot() {
  const { data } = await sb.auth.getSession();
  state.session = data.session;
  await refreshAdmin();
  sb.auth.onAuthStateChange((ev, s) => {
    state.session = s;
    if (ev === 'PASSWORD_RECOVERY') setTimeout(() => { location.hash = '#/reset'; render(); }, 0);
    else if (['SIGNED_IN', 'SIGNED_OUT', 'USER_UPDATED'].includes(ev)) setTimeout(async () => { await refreshAdmin(); if (ev === 'SIGNED_OUT' || (ev === 'SIGNED_IN' && route() !== 'login')) render(); }, 0);
  });
  render();
}

function render() {
  const r = route();
  if (r === 'login') return viewLogin();
  if (r === 'reset') return viewReset();
  if (r.startsWith('admin')) {
    if (!state.session) { sessionStorage.setItem('after', location.hash); location.hash = '#/login'; return; }
    if (!state.isAdmin) return viewNotAdmin();
    return viewAdmin(r.split('/')[1] || 'dashboard');
  }
  viewHome();
}

function nav(active) {
  return `<nav class="top"><a class="brandmark" href="#/" aria-label="Smart Tempered Glass home">${LOGO}<span>Smart</span> <b>Tempered Glass</b></a>
  <a class="nl hide-s ${active === 'home' ? 'on' : ''}" href="#/">Search</a>
  ${state.isAdmin ? `<a class="nl ${active === 'admin' ? 'on' : ''}" href="#/admin/dashboard">Admin</a>` : ''}
  ${state.session ? `<button class="nl" id="signout">Sign out</button>` : `<a class="nl" href="#/login">Sign in</a>`}</nav>`;
}
function bindNav() { const b = $('#signout'); if (b) b.onclick = async () => { await sb.auth.signOut(); state.session = null; state.isAdmin = false; location.hash = '#/'; render(); }; }

// ------------------------------------------------------------------ login / reset
function viewLogin(mode = 'in') {
  app.innerHTML = `${nav('')}<div class="wrap"><div class="glass login">
    ${mode === 'in' ? `<h1>Admin sign in</h1><p class="muted" style="margin:0">Staff don't need to sign in to search.</p>
    <form id="lf"><label class="f">Email<input name="e" type="email" autocomplete="username" required></label>
    <label class="f">Password<input name="p" type="password" autocomplete="current-password" required></label>
    <div class="err" id="le"></div><button class="btn primary" style="width:100%;margin-top:6px">Sign in</button></form>
    <div class="alt"><button class="linkbtn" id="forgot">Forgot password?</button> · <a href="#/">Back to search</a></div>`
    : `<h1>Reset password</h1><p class="muted" style="margin:0">We'll email you a link to choose a new password.</p>
    <form id="rf"><label class="f">Email<input name="e" type="email" autocomplete="username" required></label><div class="err" id="le"></div>
    <button class="btn primary" style="width:100%;margin-top:6px">Send reset link</button></form><div class="alt"><button class="linkbtn" id="back">Back to sign in</button></div>`}
  </div></div>`;
  bindNav();
  if (mode === 'in') {
    $('#forgot').onclick = () => viewLogin('reset');
    $('#lf').onsubmit = async (e) => {
      e.preventDefault(); const f = new FormData(e.target); $('#le').textContent = '';
      const { error } = await sb.auth.signInWithPassword({ email: String(f.get('e')).trim(), password: String(f.get('p')) });
      if (error) return ($('#le').textContent = error.message.includes('Invalid') ? 'Wrong email or password' : error.message);
      const { data } = await sb.auth.getSession(); state.session = data.session; await refreshAdmin();
      const after = sessionStorage.getItem('after'); sessionStorage.removeItem('after');
      location.hash = state.isAdmin ? after || '#/admin/dashboard' : '#/'; render();
    };
  } else {
    $('#back').onclick = () => viewLogin('in');
    $('#rf').onsubmit = async (e) => {
      e.preventDefault(); const email = String(new FormData(e.target).get('e')).trim();
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      if (error) return ($('#le').textContent = error.message);
      $('#rf').innerHTML = `<div class="banner ok">If that email belongs to an account, a reset link is on its way. Open it on this device.</div>`;
    };
  }
}
function viewReset() {
  app.innerHTML = `${nav('')}<div class="wrap"><div class="glass login"><h1>Choose a new password</h1>
  <form id="pf"><label class="f">New password (8+ characters)<input name="p" type="password" minlength="8" autocomplete="new-password" required></label>
  <div class="err" id="le"></div><button class="btn primary" style="width:100%">Save password</button></form></div></div>`;
  bindNav();
  $('#pf').onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await sb.auth.updateUser({ password: String(new FormData(e.target).get('p')) });
    if (error) return ($('#le').textContent = error.message);
    toast('Password updated'); await refreshAdmin(); location.hash = state.isAdmin ? '#/admin/dashboard' : '#/'; render();
  };
}
function viewNotAdmin() {
  app.innerHTML = `${nav('')}<div class="wrap"><div class="glass login"><h1>No admin access</h1><p class="muted">You're signed in as <b>${esc(state.session.user.email)}</b>, but this account isn't an administrator. Search is available to everyone.</p><a class="btn primary" href="#/">Go to search</a></div></div>`;
  bindNav();
}

// ------------------------------------------------------------------ home + search
let lastQuery = '', searchSeq = 0, brandsCache = null;
async function loadBrands() {
  if (!brandsCache) { const { data } = await sb.rpc('public_brands'); brandsCache = data || []; }
  return brandsCache;
}
function viewHome() {
  app.innerHTML = `${nav('home')}<main class="wrap">
  <section class="hero"><span class="kicker"><i></i> Tempered glass compatibility finder</span>
    <h1>Find the right glass for <em>any phone</em>.</h1>
    <p class="lead">Type a brand, model or model number. Get the box it lives in — instantly.</p>
    <form class="searchbar glass" id="sf" role="search"><label class="field">${ICON_SEARCH}<input id="q" type="search" placeholder="Search mobile model, brand or model number…" autocomplete="off" autocapitalize="none" spellcheck="false" enterkeyhint="search" aria-label="Search mobile model, brand or model number" value="${esc(lastQuery)}"></label>
    <button class="btn primary big">Search Inventory</button></form>
    <div class="chips" id="quick"></div></section>
  <div class="results" id="res" aria-live="polite"></div>
  <div id="browse">
    <section class="section"><h2>Browse by brand</h2><p class="sub">Tap a brand to see everything listed for it.</p><div class="brandgrid" id="brands"><div class="spin">Loading…</div></div></section>
    <section class="section"><h2>How it works</h2><p class="sub">Three steps, no guesswork.</p><div class="steps">
      <div class="glass step"><div class="n">1</div><h3>Type the phone</h3><p>Brand, model name or model number — spelling, spaces and capitals don't matter.</p></div>
      <div class="glass step"><div class="n">2</div><h3>Read the box number</h3><p>Exact matches show first, big and clear. Same phone in several boxes? Every box is listed.</p></div>
      <div class="glass step"><div class="n">3</div><h3>Pick the glass</h3><p>Nothing is guessed — if there's no verified match, we say so.</p></div></div></section>
  </div></main>
  <footer class="site">© ${new Date().getFullYear()} Smart Tempered Glass · <a href="#/login">Admin</a></footer>`;
  bindNav();
  const q = $('#q'); let t;
  q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => runSearch(q.value), 230); });
  $('#sf').onsubmit = (e) => { e.preventDefault(); clearTimeout(t); runSearch(q.value); q.blur(); };
  loadBrands().then((b) => {
    const grid = $('#brands'); if (!grid) return;
    grid.innerHTML = b.map((x) => `<button class="glass brandtile" data-b="${esc(x.brand)}"><b>${esc(x.brand)}</b><span>${fmt(x.records)} listing${x.records === 1 ? '' : 's'}</span></button>`).join('') || '<p class="muted">No inventory yet.</p>';
    $$('.brandtile', grid).forEach((el) => (el.onclick = () => { q.value = el.dataset.b; runSearch(el.dataset.b); window.scrollTo({ top: 0, behavior: 'smooth' }); }));
    $('#quick').innerHTML = b.slice(0, 6).map((x) => `<button class="chip" data-b="${esc(x.brand)}">${esc(x.brand)}</button>`).join('');
    $$('#quick .chip').forEach((el) => (el.onclick = () => { q.value = el.dataset.b; runSearch(el.dataset.b); }));
  }).catch(() => { const g = $('#brands'); if (g) g.innerHTML = ''; });
  if (lastQuery) runSearch(lastQuery); else q.focus();
}

const TIER = { 0: ['Brand Match', 'brand'], 1: ['Exact Match', 'exact'], 2: ['Exact Match', 'exact'], 3: ['Model Match', 'model'], 4: ['Partial Match', 'partial'] };
function groupRows(rows) {
  const groups = new Map();
  for (const r of rows) {
    const gk = `${r.brand_key}|${r.model_key}|${r.number_key}`;
    let g = groups.get(gk);
    if (!g) { g = { brand: r.brand, model: r.model, model_number: r.model_number, tier: r.tier, boxes: [] }; groups.set(gk, g); }
    g.boxes.push(r);
  }
  const list = [...groups.values()].sort((a, b) => a.tier - b.tier);
  const nat = (a, b) => String(a.box_number).localeCompare(String(b.box_number), undefined, { numeric: true });
  list.forEach((g) => g.boxes.sort(nat));
  return { exact: list.filter((g) => g.tier >= 1 && g.tier <= 2), others: list.filter((g) => g.tier === 0 || g.tier > 2) };
}

async function runSearch(raw) {
  const q = raw.trim(); lastQuery = q;
  const res = $('#res'); if (!res) return;
  const browse = $('#browse');
  if (!q) { res.innerHTML = ''; if (browse) browse.hidden = false; return; }
  if (browse) browse.hidden = true;
  const ws = words(q), qk = ws.join(''), my = ++searchSeq, MAX = 600;
  if (!qk) { res.innerHTML = renderResults({ exact: [], others: [], query: q }); return; }
  const { data, error } = await sb.rpc('search_inventory', { qk, ws, max_rows: MAX });
  if (my !== searchSeq) return;
  if (error) { res.innerHTML = `<div class="banner warn">Search is unavailable right now (${esc(error.message)}). Please try again.</div>`; return; }
  const g = groupRows(data || []);
  res.innerHTML = renderResults({ ...g, query: q, truncated: (data || []).length >= MAX });
  $$('[data-copy]', res).forEach((b) => (b.onclick = () => copyText(b.dataset.copy)));
  const add = $('#nr-add'); if (add) add.onclick = () => { sessionStorage.setItem('addq', q); location.hash = state.isAdmin ? '#/admin/inventory?add=1' : '#/login'; };
  const imp = $('#nr-imp'); if (imp) imp.onclick = () => { location.hash = state.isAdmin ? '#/admin/import' : '#/login'; };
}

function boxBlock(b) {
  const bits = [b.quantity != null ? `${b.quantity} unit${b.quantity === 1 ? '' : 's'}` : '', [b.variant, b.ram, b.storage, b.color].filter(Boolean).join(' · ')].filter(Boolean).join(' — ');
  return `<div class="boxblock"><div class="lbl">BOX NUMBER</div><div class="num"><span>${esc(b.box_number)}</span><button class="copy" data-copy="${esc(b.box_number)}" aria-label="Copy box number ${esc(b.box_number)}">Copy</button></div>${bits ? `<div class="sub">${esc(bits)}</div>` : ''}</div>`;
}
function groupCard(g, { exact, compact }) {
  const [type, cls] = TIER[g.tier];
  const warn = [...new Set(g.boxes.map((b) => b.review_reason).filter(Boolean))];
  const notes = [...new Set(g.boxes.map((b) => b.notes).filter(Boolean))];
  const poster = [...new Set(g.boxes.map((b) => b.poster_model).filter(Boolean))];
  return `<article class="glass card ${exact ? 'exact' : ''} ${compact ? 'compact' : ''}"><div>
    ${g.brand ? `<div class="brandline">${esc(g.brand)}</div>` : ''}<h3>${esc(g.model)}</h3>
    <div class="meta">${g.model_number ? `<span>Model No. <b>${esc(g.model_number)}</b></span>` : ''}<span class="badge ${cls}">${type}</span>${g.boxes.length > 1 ? `<span>in ${g.boxes.length} boxes</span>` : ''}</div>
    ${!compact && poster.length ? `<div class="note">Box card: ${esc(poster.join(', '))}</div>` : ''}
    ${warn.length ? `<div class="warnline">⚠ Unverified entry — ${esc(warn[0])}. Please double-check the box.</div>` : ''}
    ${notes.length ? `<div class="note">${esc(notes.join(' · '))}</div>` : ''}
  </div><div class="boxes">${g.boxes.map(boxBlock).join('')}</div></article>`;
}
function renderResults(d) {
  if (!d.exact.length && !d.others.length) {
    return `<div class="glass empty"><h2>No matching mobile found.</h2><p>No verified match was found for “${esc(d.query)}”. Check the spelling or try fewer words. A box number is only ever shown when it comes from the inventory.</p>
    <div class="row"><button class="btn primary" id="nr-add">Add New Model</button><button class="btn" id="nr-imp">Import Excel</button></div></div>`;
  }
  let html = '';
  if (d.exact.length) {
    html += `<div class="sect">${d.exact.length > 1 ? `${d.exact.length} different phones match exactly` : 'Exact match'}</div>`;
    if (d.exact.length > 1) html += `<div class="banner warn">More than one phone matches “${esc(d.query)}”. Check the brand and model before taking a box.</div>`;
    html += d.exact.map((g) => groupCard(g, { exact: true })).join('');
    if (d.others.length) html += `<details class="more"><summary>Show ${d.others.length} similar model${d.others.length === 1 ? '' : 's'}</summary>${d.others.map((g) => groupCard(g, { compact: true })).join('')}</details>`;
  } else {
    const brandOnly = d.others.every((g) => g.tier === 0);
    html += brandOnly
      ? `<div class="sect">All ${esc(d.others[0].brand)} models</div><div class="banner info">Add the model name to narrow this down${d.truncated ? ' — showing the first results only' : ''}.</div>`
      : `<div class="sect">No exact match — possible matches</div><div class="banner warn">Nothing matches “${esc(d.query)}” exactly. These are <b>possible</b> matches — please check each one.</div>`;
    html += d.others.map((g) => groupCard(g, { compact: true })).join('');
  }
  if (d.truncated && !d.exact.length) html += `<p class="muted" style="text-align:center">More results exist — type more of the model name to narrow down.</p>`;
  return html;
}

// ------------------------------------------------------------------ admin shell
const TABS = [['dashboard', 'Dashboard'], ['inventory', 'Inventory'], ['import', 'Import / Export'], ['duplicates', 'Duplicates'], ['audit', 'Audit log'], ['account', 'Account']];
async function viewAdmin(tab) {
  app.innerHTML = `${nav('admin')}<div class="wrap wide"><div class="subnav">${TABS.map(([k, l]) => `<a href="#/admin/${k}" class="${k === tab ? 'on' : ''}">${l}</a>`).join('')}</div><div class="page" id="page"><div class="spin">Loading…</div></div></div>`;
  bindNav();
  const page = $('#page');
  try {
    const views = { dashboard: viewDashboard, inventory: viewInventory, import: viewImport, duplicates: viewDuplicates, audit: viewAudit, account: viewAccount };
    if (!views[tab]) page.innerHTML = '<p>Page not found.</p>'; else await views[tab](page);
  } catch (e) { page.innerHTML = `<div class="banner warn">${esc(friendly(e))}</div>`; }
}
const must = (r) => { if (r.error) throw r.error; return r.data; };

async function viewDashboard(page) {
  const d = must(await sb.rpc('dashboard_stats'));
  const max = Math.max(1, ...d.brands.map((b) => b.records));
  page.innerHTML = `<h2>Dashboard</h2><div class="stats">
    <div class="glass stat"><div class="v">${fmt(d.totalModels)}</div><div class="k">Total models</div></div>
    <div class="glass stat"><div class="v">${fmt(d.totalRecords)}</div><div class="k">Inventory records</div></div>
    <div class="glass stat"><div class="v">${fmt(d.totalUnits)}</div><div class="k">Total units${d.recordsWithQuantity < d.totalRecords ? ` (${fmt(d.recordsWithQuantity)} records have a quantity)` : ''}</div></div>
    <div class="glass stat"><div class="v">${fmt(d.brands.length)}</div><div class="k">Brands</div></div>
    <div class="glass stat"><div class="v">${fmt(d.boxes)}</div><div class="k">Boxes</div></div>
    <a class="glass stat ${d.needReview ? 'warn' : ''}" href="#/admin/inventory?review=1"><div class="v">${fmt(d.needReview)}</div><div class="k">Records requiring review</div></a>
    <a class="glass stat ${d.duplicates ? 'warn' : ''}" href="#/admin/duplicates"><div class="v">${fmt(d.duplicates)}</div><div class="k">Possible duplicate groups</div></a></div>
  <div class="grid2"><div class="glass panel bars"><h3>Records by brand</h3>${d.brands.map((b) => `<div class="bar"><span>${esc(b.brand)}</span><span class="track"><div class="fill" style="width:${(b.records / max) * 100}%"></div></span><span class="muted">${fmt(b.records)}</span></div>`).join('') || '<p class="muted">No data yet — import your Excel file.</p>'}</div>
  <div><div class="glass panel"><h3>Recently imported</h3>${d.recentImports.length ? `<div class="tablewrap"><table><tr><th>When</th><th>File</th><th>Added</th><th></th></tr>${d.recentImports.map((b) => `<tr><td>${esc(new Date(b.created_at).toLocaleString())}</td><td>${esc(b.filename)}</td><td>${fmt(b.imported)}</td><td><button class="btn sm danger" data-undo="${b.id}">Undo</button></td></tr>`).join('')}</table></div>` : '<p class="muted">No imports yet.</p>'}</div>
  <div class="glass panel"><h3>Recently added records</h3>${d.recentModels.length ? `<div class="tablewrap"><table>${d.recentModels.map((r) => `<tr><td>${esc(r.brand)} ${esc(r.model)}</td><td class="box">${esc(r.box_number)}</td></tr>`).join('')}</table></div>` : '<p class="muted">Nothing yet.</p>'}</div></div></div>`;
  $$('[data-undo]', page).forEach((b) => (b.onclick = async () => {
    if (!(await confirmDialog('Remove <b>every record</b> created by this import? Records added by hand are not affected, but edits made to imported records will be lost.', 'Undo import'))) return;
    const id = Number(b.dataset.undo);
    const { data: bt } = await sb.from('import_batches').select('filename').eq('id', id).single();
    const del = await sb.from('inventory').delete({ count: 'exact' }).eq('batch_id', id);
    if (del.error) return toast(friendly(del.error));
    await sb.from('import_batches').delete().eq('id', id);
    await audit(`Undid import #${id}: removed ${del.count} records (${bt?.filename || ''})`);
    toast(`Removed ${del.count} records`); render();
  }));
}

// ------------------------------------------------------------------ inventory
const inv = { q: '', brand: '', box: '', sort: 'newest', page: 1, review: false, batch: '' };
const SORTS = { newest: [['id', false]], brand: [['brand_key', true], ['model_key', true], ['box_sort', true]], model: [['model_key', true], ['brand_key', true]], box: [['box_sort', true, true], ['box_key', true]], updated: [['updated_at', false]] };
function applyFilters(qb, f) {
  for (const w of words(f.q || '')) qb = qb.ilike('search_key', `%${w}%`);
  if (f.brand) qb = qb.eq('brand_key', key(f.brand));
  if (f.box) qb = qb.ilike('box_key', `%${boxKey(f.box)}%`);
  if (f.review) qb = qb.neq('review_reason', '');
  if (f.batch) qb = qb.eq('batch_id', Number(f.batch));
  return qb;
}
async function viewInventory(page) {
  const qs = query();
  if (qs.get('review') === '1') inv.review = true;
  const brands = must(await sb.rpc('public_brands'));
  page.innerHTML = `<h2>Inventory</h2>
  <div class="toolbar"><button class="btn primary" id="add">+ Add model</button><a class="btn" href="#/admin/import">Import Excel</a><button class="btn" id="export">Export to Excel</button></div>
  <div class="toolbar"><input id="f-q" type="search" placeholder="Search…" value="${esc(inv.q)}" style="flex:1 1 200px"><select id="f-brand"><option value="">All brands</option>${brands.map((b) => `<option value="${esc(b.brand)}" ${inv.brand === b.brand ? 'selected' : ''}>${esc(b.brand)} (${b.records})</option>`).join('')}</select>
  <input id="f-box" placeholder="Box number" style="width:140px" value="${esc(inv.box)}">
  <select id="f-sort">${[['newest', 'Newest first'], ['brand', 'Brand / model'], ['model', 'Model'], ['box', 'Box number'], ['updated', 'Recently updated']].map(([v, l]) => `<option value="${v}" ${inv.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
  <label class="chip chk"><input type="checkbox" id="f-review" ${inv.review ? 'checked' : ''}> Needs review only</label></div>
  <div class="toolbar" id="bulk" hidden><b id="bulkn"></b><input id="bulkbox" placeholder="New box number" style="width:160px"><button class="btn sm" id="bulkmove">Move to box</button><button class="btn sm danger" id="bulkdel">Delete selected</button></div>
  <div class="tablewrap"><table><thead><tr><th><input type="checkbox" id="all" aria-label="Select all"></th><th>Brand</th><th>Model</th><th>Model no.</th><th>Box</th><th>Qty</th><th>Details</th><th></th></tr></thead><tbody id="rows"></tbody></table></div><div class="pager" id="pager"></div>`;
  const SIZE = 50, sel = new Set(); let data = { rows: [], total: 0 };
  const load = async () => {
    let qb = applyFilters(sb.from('inventory').select('*', { count: 'exact' }), inv);
    for (const [col, asc, nullsFirst] of SORTS[inv.sort]) qb = qb.order(col, { ascending: asc, nullsFirst: !!nullsFirst });
    const { data: rows, count, error } = await qb.range((inv.page - 1) * SIZE, inv.page * SIZE - 1);
    if (error) { $('#rows').innerHTML = `<tr><td colspan="8" class="err">${esc(friendly(error))}</td></tr>`; return; }
    data = { rows, total: count }; sel.clear(); draw();
  };
  const draw = () => {
    $('#rows').innerHTML = data.rows.map((r) => `<tr class="${r.review_reason ? 'warn' : ''}"><td><input type="checkbox" data-sel="${r.id}" ${sel.has(r.id) ? 'checked' : ''}></td><td>${esc(r.brand)}</td><td>${esc(r.model)}</td><td>${esc(r.model_number)}</td><td class="box">${esc(r.box_number)}</td><td>${r.quantity ?? ''}</td>
      <td class="muted">${esc([r.variant, r.ram, r.storage, r.color].filter(Boolean).join(' · '))}${r.review_reason ? `<div style="color:var(--amber)">⚠ ${esc(r.review_reason)}</div>` : ''}${r.extra?.poster_model ? `<div>Box card: ${esc(r.extra.poster_model)}</div>` : ''}</td>
      <td style="white-space:nowrap"><button class="btn sm" data-edit="${r.id}">Edit</button> <button class="btn sm danger" data-del="${r.id}">Delete</button></td></tr>`).join('') || `<tr><td colspan="8" class="muted" style="padding:26px;text-align:center">No records found.</td></tr>`;
    const pages = Math.max(1, Math.ceil(data.total / SIZE));
    $('#pager').innerHTML = `<button class="btn sm" id="pp" ${inv.page <= 1 ? 'disabled' : ''}>‹ Prev</button><span>${fmt(data.total)} records · page ${inv.page} of ${pages}</span><button class="btn sm" id="pn" ${inv.page >= pages ? 'disabled' : ''}>Next ›</button>`;
    $('#pp').onclick = () => { inv.page--; load(); }; $('#pn').onclick = () => { inv.page++; load(); };
    bulkUI();
    $$('[data-sel]').forEach((c) => (c.onchange = () => { c.checked ? sel.add(+c.dataset.sel) : sel.delete(+c.dataset.sel); bulkUI(); }));
    $$('[data-edit]').forEach((b) => (b.onclick = () => editDialog(data.rows.find((r) => r.id === +b.dataset.edit), load)));
    $$('[data-del]').forEach((b) => (b.onclick = async () => {
      const r = data.rows.find((x) => x.id === +b.dataset.del);
      if (!(await confirmDialog(`Delete <b>${esc(r.brand)} ${esc(r.model)}</b> in box <b>${esc(r.box_number)}</b>? This cannot be undone.`, 'Delete'))) return;
      const { error } = await sb.from('inventory').delete().eq('id', r.id);
      if (error) return toast(friendly(error));
      await audit(`Deleted inventory record: ${labelOf(r)}`, r.id); toast('Deleted'); load();
    }));
  };
  const bulkUI = () => { $('#bulk').hidden = !sel.size; $('#bulkn').textContent = `${sel.size} selected`; $('#all').checked = data.rows.length > 0 && sel.size === data.rows.length; };
  $('#all').onchange = (e) => { sel.clear(); if (e.target.checked) data.rows.forEach((r) => sel.add(r.id)); draw(); };
  $('#bulkdel').onclick = async () => {
    if (!(await confirmDialog(`Delete <b>${sel.size}</b> selected records? This cannot be undone.`, `Delete ${sel.size} records`))) return;
    const ids = [...sel]; const { error } = await sb.from('inventory').delete().in('id', ids);
    if (error) return toast(friendly(error));
    await audit(`Bulk deleted ${ids.length} inventory records`, null, `ids: ${ids.slice(0, 50).join(',')}`); toast('Deleted'); load();
  };
  $('#bulkmove').onclick = async () => {
    const box = $('#bulkbox').value.trim(); if (!box) return toast('Enter the new box number');
    if (!(await confirmDialog(`Move <b>${sel.size}</b> selected records to box <b>${esc(box)}</b>?`, 'Move', false))) return;
    const ids = [...sel]; const { error } = await sb.from('inventory').update({ box_number: box, box_key: boxKey(box) }).in('id', ids);
    if (error) return toast(friendly(error));
    await audit(`Bulk moved ${ids.length} records to ${box}`, null, `ids: ${ids.slice(0, 50).join(',')}`); toast('Updated'); load();
  };
  let t;
  const refilter = () => { inv.q = $('#f-q').value; inv.box = $('#f-box').value; inv.brand = $('#f-brand').value; inv.sort = $('#f-sort').value; inv.review = $('#f-review').checked; inv.page = 1; inv.batch = ''; load(); };
  ['#f-q', '#f-box'].forEach((s) => $(s).addEventListener('input', () => { clearTimeout(t); t = setTimeout(refilter, 300); }));
  ['#f-brand', '#f-sort', '#f-review'].forEach((s) => $(s).addEventListener('change', refilter));
  $('#add').onclick = () => editDialog(null, load);
  $('#export').onclick = async () => {
    const b = $('#export'); b.disabled = true; b.textContent = 'Preparing…';
    try { await exportAll(inv); } catch (e) { toast(friendly(e)); }
    b.disabled = false; b.textContent = 'Export to Excel';
  };
  await load();
  if (qs.get('add') === '1') { editDialog(null, load, sessionStorage.getItem('addq') || ''); history.replaceState(null, '', '#/admin/inventory'); }
}

async function exportAll(filters) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    let qb = applyFilters(sb.from('inventory').select('*'), filters).order('box_sort', { ascending: true, nullsFirst: false }).order('box_key').order('id');
    const { data, error } = await qb.range(from, from + 999);
    if (error) throw error; rows.push(...data); if (data.length < 1000) break;
  }
  const extraKeys = [...new Set(rows.flatMap((r) => Object.keys(r.extra || {})))];
  const headers = [...TEMPLATE_HEADERS, 'IMEI', ...extraKeys, 'ID'];
  downloadXlsx(`smart-tempered-glass-inventory-${new Date().toISOString().slice(0, 10)}.xlsx`, headers,
    rows.map((r) => [r.brand, r.model, r.model_number, r.box_number, r.variant, r.ram, r.storage, r.color, r.quantity ?? '', r.notes, r.imei, ...extraKeys.map((k) => r.extra?.[k] ?? ''), r.id]));
  await audit(`Exported ${rows.length} records to Excel`); toast(`Exported ${fmt(rows.length)} records`);
}

function sanitize(fd) {
  const c = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const r = { brand: c(fd.brand), model: c(fd.model), model_number: c(fd.model_number), box_number: c(fd.box_number), variant: c(fd.variant), ram: c(fd.ram), storage: c(fd.storage), color: c(fd.color), imei: c(fd.imei), notes: c(fd.notes) };
  if (!r.model) throw new Error('Model name is required');
  if (!r.box_number) throw new Error('Box number is required');
  const q = c(fd.quantity);
  if (q === '') r.quantity = null; else if (!/^\d+$/.test(q)) throw new Error('Quantity must be a whole number (0 or more)'); else r.quantity = Number(q);
  r.extra = {}; for (const [k, v] of Object.entries(fd.extra || {})) { if (c(k) && c(v)) r.extra[c(k)] = c(v); }
  return r;
}
function editDialog(rec, onSaved, prefillModel = '') {
  const r = rec || { brand: '', model: prefillModel, model_number: '', box_number: '', variant: '', ram: '', storage: '', color: '', imei: '', quantity: null, notes: '', extra: {}, review_reason: '' };
  const f = (name, label, o = {}) => `<label class="f ${o.full ? 'full' : ''}">${label}${o.area ? `<textarea name="${name}" rows="2">${esc(r[name])}</textarea>` : `<input name="${name}" value="${esc(r[name] ?? '')}" ${o.req ? 'required' : ''} ${o.num ? 'type="number" min="0" step="1" inputmode="numeric"' : ''}>`}</label>`;
  showDialog(`<h3>${rec ? 'Edit record' : 'Add model'}</h3><form id="ef"><div class="form">
    ${f('brand', 'Brand')}${f('model', 'Model name *', { req: 1 })}${f('model_number', 'Model number')}${f('box_number', 'Box number *', { req: 1 })}
    ${f('variant', 'Variant')}${f('ram', 'RAM')}${f('storage', 'Storage')}${f('color', 'Color')}${f('imei', 'IMEI (optional)')}${f('quantity', 'Quantity', { num: 1 })}${f('notes', 'Notes', { full: 1, area: 1 })}
    <div class="f full">Custom fields<div id="xf"></div><button type="button" class="btn sm" id="xadd" style="width:max-content;margin-top:6px">+ Add field</button></div></div>
    ${rec && r.review_reason ? `<label class="chip chk" style="margin-top:12px"><input type="checkbox" name="clear" checked> I've checked this entry — clear the review flag</label>` : ''}
    <div class="err" id="ee"></div><div class="actions"><button type="button" class="btn" id="ecancel">Cancel</button><button class="btn primary">${rec ? 'Save changes' : 'Add model'}</button></div></form>`);
  const xf = $('#xf');
  const addX = (k = '', v = '') => { const d = document.createElement('div'); d.className = 'maprow'; d.style.gridTemplateColumns = '1fr 1fr auto'; d.innerHTML = `<input placeholder="Name" value="${esc(k)}" class="xk"><input placeholder="Value" value="${esc(v)}" class="xv"><button type="button" class="btn sm" aria-label="Remove">✕</button>`; $('button', d).onclick = () => d.remove(); xf.append(d); };
  Object.entries(r.extra || {}).forEach(([k, v]) => addX(k, v));
  $('#xadd').onclick = () => addX();
  $('#ecancel').onclick = closeDialog;
  $('#ef').onsubmit = async (e) => {
    e.preventDefault(); $('#ee').textContent = '';
    const fd = Object.fromEntries(new FormData(e.target)); fd.extra = {};
    $$('.maprow', xf).forEach((d) => { const k = $('.xk', d).value.trim(); if (k) fd.extra[k] = $('.xv', d).value; });
    let clean; try { clean = sanitize(fd); } catch (err) { return ($('#ee').textContent = err.message); }
    clean.review_reason = rec ? (fd.clear ? '' : rec.review_reason) : '';
    const keys = recordKeys(clean);
    const row = { ...clean, ...keys };
    const save = async () => {
      if (rec) {
        const { error } = await sb.from('inventory').update(row).eq('id', rec.id); if (error) throw error;
        const changes = ['brand', 'model', 'model_number', 'box_number', 'variant', 'ram', 'storage', 'color', 'quantity', 'notes'].filter((k) => String(rec[k] ?? '') !== String(clean[k] ?? '')).map((k) => `${FIELD_LABELS[k]} "${rec[k] ?? ''}" -> "${clean[k] ?? ''}"`);
        await audit(rec.box_number !== clean.box_number ? `Updated box number from ${rec.box_number} to ${clean.box_number} (${[clean.brand, clean.model].join(' ')})` : `Updated ${[clean.brand, clean.model].join(' ')}`, rec.id, changes.join('; '));
      } else {
        const { data, error } = await sb.from('inventory').insert({ ...row, source: 'manual' }).select('id').single(); if (error) throw error;
        await audit(`Added ${labelOf(clean)}`, data.id);
      }
    };
    try {
      let dq = sb.from('inventory').select('id,brand,model,model_number,box_number').eq('brand_key', keys.brand_key).eq('model_key', keys.model_key).eq('number_key', keys.number_key).eq('box_key', keys.box_key);
      if (rec) dq = dq.neq('id', rec.id);
      const { data: dups, error: de } = await dq.limit(1); if (de) throw de;
      if (dups.length) {
        const d = dups[0];
        if (!(await confirmDialog(`This looks like a duplicate of <b>${esc(d.brand)} ${esc(d.model)}</b> ${d.model_number ? `(${esc(d.model_number)}) ` : ''}in box <b>${esc(d.box_number)}</b>.<br><br>Save anyway as a separate record?`, 'Save anyway', false))) { editDialog(rec, onSaved, clean.model); return; }
      }
      await save(); closeDialog(); toast(rec ? 'Saved' : 'Added'); onSaved();
    } catch (err) { if (!dlg.open) editDialog(rec, onSaved, clean.model); $('#ee') && ($('#ee').textContent = friendly(err)); }
  };
}

// ------------------------------------------------------------------ duplicates / audit / account
async function viewDuplicates(page) {
  const groups = must(await sb.rpc('duplicate_groups'));
  page.innerHTML = `<h2>Possible duplicates</h2><p class="muted">Records with the same brand, model, model number <b>and</b> box. Nothing is removed automatically — review each group and delete the extras you don't need.</p>
  ${groups.length ? groups.map((g) => `<div class="glass panel"><div class="tablewrap"><table><tr><th>ID</th><th>Brand</th><th>Model</th><th>Model no.</th><th>Box</th><th>Qty</th><th>Added</th><th></th></tr>${g.rows.map((r) => `<tr><td>${r.id}</td><td>${esc(r.brand)}</td><td>${esc(r.model)}</td><td>${esc(r.model_number)}</td><td class="box">${esc(r.box_number)}</td><td>${r.quantity ?? ''}</td><td>${esc(new Date(r.created_at).toLocaleDateString())}</td><td><button class="btn sm danger" data-del="${r.id}">Delete this one</button></td></tr>`).join('')}</table></div></div>`).join('') : '<div class="banner ok">No duplicates found.</div>'}`;
  $$('[data-del]', page).forEach((b) => (b.onclick = async () => {
    if (!(await confirmDialog(`Delete record <b>#${b.dataset.del}</b>? This cannot be undone.`, 'Delete'))) return;
    const { error } = await sb.from('inventory').delete().eq('id', Number(b.dataset.del)); if (error) return toast(friendly(error));
    await audit('Deleted inventory record (duplicate review)', Number(b.dataset.del)); toast('Deleted'); render();
  }));
}
let auditPage = 1;
async function viewAudit(page) {
  const SIZE = 50;
  const { data, count, error } = await sb.from('audit_log').select('*', { count: 'exact' }).order('id', { ascending: false }).range((auditPage - 1) * SIZE, auditPage * SIZE - 1);
  if (error) throw error;
  const pages = Math.max(1, Math.ceil(count / SIZE));
  page.innerHTML = `<h2>Audit log</h2><div class="tablewrap"><table><tr><th>Date / time</th><th>User</th><th>Action</th><th>Details</th></tr>${data.map((r) => `<tr><td style="white-space:nowrap">${esc(new Date(r.at).toLocaleString())}</td><td>${esc(r.user_email)}</td><td>${esc(r.action)}</td><td class="muted">${esc(r.detail)}${r.record_id ? ` (record #${r.record_id})` : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Nothing logged yet.</td></tr>'}</table></div>
  <div class="pager"><button class="btn sm" id="pp" ${auditPage <= 1 ? 'disabled' : ''}>‹ Newer</button><span>page ${auditPage} of ${pages}</span><button class="btn sm" id="pn" ${auditPage >= pages ? 'disabled' : ''}>Older ›</button></div>`;
  $('#pp').onclick = () => { auditPage--; render(); }; $('#pn').onclick = () => { auditPage++; render(); };
}
function viewAccount(page) {
  page.innerHTML = `<h2>Account</h2><div class="glass panel" style="max-width:460px"><h3>Signed in as ${esc(state.session.user.email)}</h3>
  <form id="pf"><label class="f">New password (8+ characters)<input name="p" type="password" minlength="8" autocomplete="new-password" required></label><div class="err" id="pe"></div><button class="btn primary" style="margin-top:12px">Change password</button></form></div>`;
  $('#pf').onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await sb.auth.updateUser({ password: String(new FormData(e.target).get('p')) });
    if (error) return ($('#pe').textContent = error.message);
    e.target.reset(); toast('Password changed'); await audit('Changed own password');
  };
}

// ------------------------------------------------------------------ import wizard
async function viewImport(page) {
  page.innerHTML = `<h2>Import / Export</h2>
  <div class="toolbar"><button class="btn" id="tpl">⬇ Download Excel template</button><button class="btn" id="exp">⬇ Export all inventory to Excel</button></div>
  <div class="glass panel"><h3>1. Upload an Excel file (.xlsx or .xls)</h3><label class="drop" id="drop"><input type="file" id="file" accept=".xlsx,.xls" hidden><b>Drop a file here</b> or tap to choose<div class="muted">Nothing is imported until you review the preview and confirm.</div></label><div class="err" id="ue"></div></div><div id="wiz"></div>`;
  $('#tpl').onclick = downloadTemplate;
  $('#exp').onclick = async (e) => { e.target.disabled = true; try { await exportAll({}); } catch (er) { toast(friendly(er)); } e.target.disabled = false; };
  const handle = async (file) => {
    if (!file) return; $('#ue').textContent = '';
    try {
      const sheets = readWorkbook(await file.arrayBuffer());
      if (!sheets.length) throw new Error('The file has no data rows (a header row plus at least one row is needed).');
      $('#drop').innerHTML = `<b>${esc(file.name)}</b> <span class="muted">— choose another file to replace</span><input type="file" id="file" accept=".xlsx,.xls" hidden>`;
      $('#file').onchange = (e) => handle(e.target.files[0]);
      wizard(sheets, file.name);
    } catch (e) { $('#ue').textContent = e.message.includes('has no data') ? e.message : 'Could not read that file. Please upload a valid .xlsx or .xls file.'; }
  };
  $('#file').onchange = (e) => handle(e.target.files[0]);
  const drop = $('#drop');
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); }; drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); handle(e.dataTransfer.files[0]); };
}

function wizard(sheets, filename) {
  const wiz = $('#wiz');
  const draw = (si) => {
    const s = sheets[si]; const mode0 = detectMode(s.headers), flat = suggestFlat(s.headers), chart = suggestChart(s.headers);
    const opts = (cur, blank) => `${blank ? '<option value="">— none —</option>' : ''}${s.headers.map((h) => `<option ${h === cur ? 'selected' : ''}>${esc(h)}</option>`).join('')}`;
    wiz.innerHTML = `<div class="glass panel"><h3>2. Match your columns</h3>
      <div class="toolbar">${sheets.length > 1 ? `<label>Sheet <select id="sheet">${sheets.map((x, i) => `<option value="${i}" ${i === si ? 'selected' : ''}>${esc(x.name)} (${x.rows.length} rows)</option>`).join('')}</select></label>` : `<span class="muted">${s.rows.length} data rows</span>`}
      <label>File layout <select id="mode"><option value="flat" ${mode0 === 'flat' ? 'selected' : ''}>One row per phone (Brand, Model, Box…)</option><option value="chart" ${mode0 === 'chart' ? 'selected' : ''}>Compatibility chart (a row per box, a column per brand)</option></select></label></div>
      <div id="cfg"></div><label class="chip chk" style="margin-top:12px"><input type="checkbox" id="skip" checked> Skip rows that already exist in the inventory</label>
      <div style="margin-top:14px"><button class="btn primary" id="prev">Preview import</button></div><div class="err" id="we"></div></div><div id="preview"></div>`;
    const drawCfg = () => {
      if ($('#mode').value === 'flat') {
        $('#cfg').innerHTML = `<p class="muted">Pick which Excel column holds each field. Model and Box Number are required.</p>${Object.entries(FIELD_LABELS).map(([f, l]) => `<div class="maprow"><span>${l}${f === 'model' || f === 'box_number' ? ' *' : ''}</span><select data-f="${f}">${opts(flat[f], true)}</select></div>`).join('')}<label class="chip chk"><input type="checkbox" id="keepx"> Keep other columns as custom fields</label>`;
      } else {
        $('#cfg').innerHTML = `<p class="muted">Each row is one box. Every brand column lists the models that belong in that box, separated by “/”. They are split into one searchable record per model.</p>
        <div class="maprow"><span>Box number column *</span><select id="c-box">${opts(chart.boxColumn)}</select></div>
        <div class="maprow"><span>Box label column</span><select id="c-label">${opts(chart.labelColumn, true)}</select></div>
        <div style="margin-top:10px"><b style="font-size:14px">Brand columns</b></div>
        ${s.headers.filter((h) => h !== chart.boxColumn && h !== chart.labelColumn).map((h) => { const b = chart.brandColumns.find((x) => x.column === h); return `<div class="maprow" style="grid-template-columns:26px 140px 1fr"><input type="checkbox" class="bc" data-col="${esc(h)}" ${b ? 'checked' : ''}><span>${esc(h)}</span><input class="bn" value="${esc(b?.brand || h)}" aria-label="Brand name for ${esc(h)}"></div>`; }).join('')}`;
      }
    };
    drawCfg(); $('#mode').onchange = drawCfg;
    if ($('#sheet')) $('#sheet').onchange = (e) => draw(+e.target.value);
    const config = () => {
      const mode = $('#mode').value, cfg = { mode, skipExisting: $('#skip').checked };
      if (mode === 'flat') { cfg.flat = { mapping: {}, keepExtra: $('#keepx').checked }; $$('[data-f]').forEach((x) => { if (x.value) cfg.flat.mapping[x.dataset.f] = x.value; }); }
      else cfg.chart = { boxColumn: $('#c-box').value, labelColumn: $('#c-label').value, brandColumns: $$('.bc').filter((c) => c.checked).map((c) => ({ column: c.dataset.col, brand: c.closest('.maprow').querySelector('.bn').value })) };
      return cfg;
    };
    $('#prev').onclick = async () => {
      $('#we').textContent = ''; $('#preview').innerHTML = '<div class="spin">Checking the data…</div>';
      try {
        const existing = new Set(must(await sb.rpc('existing_keys')));
        const cfg = config(); const a = analyze(s, cfg, existing);
        previewView(a, cfg, filename);
      } catch (e) { $('#preview').innerHTML = ''; $('#we').textContent = friendly(e); }
    };
  };
  draw(0);
}

function previewView(a, cfg, filename) {
  const box = $('#preview');
  const row = (c) => ({ row: c.row, ...c.rec, note: c.rec.review_reason || c.rec.notes });
  const tbl = (rows, cols, cls = () => '') => `<div class="tablewrap" style="max-height:420px;overflow:auto"><table><tr>${cols.map(([, l]) => `<th>${l}</th>`).join('')}</tr>${rows.map((r) => `<tr class="${cls(r)}">${cols.map(([k]) => `<td>${esc(r[k])}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${cols.length}" class="muted">Nothing here.</td></tr>`}</table></div>`;
  const base = [['row', 'Excel row'], ['brand', 'Brand'], ['model', 'Model'], ['model_number', 'Model no.'], ['box_number', 'Box']];
  const flagged = a.toImport.filter((c) => c.rec.review_reason);
  const dups = a.dupFile.length + a.dupDb.length;
  const tabs = {
    import: [`Will import`, a.toImport.length, () => tbl(a.toImport.slice(0, 120).map(row), [...base, ['note', 'Notes']], (r) => (r.review_reason ? 'warn' : '')) + (a.toImport.length > 120 ? `<p class="muted">Showing the first 120 of ${fmt(a.toImport.length)}.</p>` : '')],
    review: ['Flagged for review', flagged.length, () => tbl(flagged.slice(0, 150).map(row), [...base, ['review_reason', 'Why']], () => 'warn')],
    errors: ['Rejected rows', a.errors.length, () => tbl(a.errors.slice(0, 200).map((e) => ({ row: e.row, reason: e.reason, ...e.data })), [...base, ['reason', 'Problem']], () => 'bad') + '<p class="muted">Rejected rows are not imported. Fix them in Excel and import again.</p>'],
    dupe: ['Duplicates', dups, () => `<p class="muted">${fmt(a.dupFile.length)} repeated inside the file, ${fmt(a.dupDb.length)} already in the inventory. ${cfg.skipExisting ? 'Existing ones are skipped.' : 'Existing ones will be imported and flagged for review.'}</p>` + tbl([...a.dupFile.slice(0, 100).map((d) => ({ row: d.row, ...d.rec, where: `Same as row ${d.firstRow}` })), ...a.dupDb.slice(0, 100).map((d) => ({ row: d.row, ...d.rec, where: 'Already in inventory' }))], [...base, ['where', 'Duplicate of']])],
  };
  const n = a.toImport.length;
  box.innerHTML = `<div class="glass panel"><h3>3. Review &amp; confirm</h3>
    <div class="stats"><div class="glass stat"><div class="v">${fmt(n)}</div><div class="k">records will be imported</div></div><div class="glass stat ${flagged.length ? 'warn' : ''}"><div class="v">${fmt(flagged.length)}</div><div class="k">flagged for review</div></div><div class="glass stat ${a.errors.length ? 'warn' : ''}"><div class="v">${fmt(a.errors.length)}</div><div class="k">rows rejected</div></div><div class="glass stat"><div class="v">${fmt(dups)}</div><div class="k">duplicates found</div></div></div>
    <div class="tabs">${Object.entries(tabs).map(([k, [l, c]]) => `<button class="tab" data-tab="${k}">${l} (${fmt(c)})</button>`).join('')}</div><div id="tabbody"></div>
    <div style="margin-top:16px"><button class="btn primary" id="go" ${n ? '' : 'disabled'}>Import ${fmt(n)} records</button><span class="muted" id="prog" style="margin-left:12px"></span></div><div class="err" id="ge"></div></div>`;
  const show = (k) => { $$('.tab', box).forEach((t) => t.classList.toggle('on', t.dataset.tab === k)); $('#tabbody').innerHTML = tabs[k][2](); };
  $$('.tab', box).forEach((t) => (t.onclick = () => show(t.dataset.tab)));
  show(a.errors.length ? 'errors' : 'import');
  $('#go').onclick = async () => {
    if (!(await confirmDialog(`Import <b>${fmt(n)}</b> records from <b>${esc(filename)}</b>? ${a.errors.length ? `<br>${fmt(a.errors.length)} rejected rows will be left out.` : ''}<br>You can undo the whole import from the dashboard.`, 'Import', false))) return;
    $('#go').disabled = true; $('#ge').textContent = '';
    let batchId = null;
    try {
      const skipped = a.candidates - n + a.errors.length;
      const b = must(await sb.from('import_batches').insert({ filename, mode: cfg.mode, total_rows: a.totalRows, imported: 0, skipped, flagged: flagged.length }).select('id').single());
      batchId = b.id;
      const rows = a.toImport.map((c) => toDbRow(c.rec, batchId));
      for (let i = 0; i < rows.length; i += 500) {
        must(await sb.from('inventory').insert(rows.slice(i, i + 500)));
        $('#prog').textContent = `Imported ${fmt(Math.min(i + 500, rows.length))} of ${fmt(rows.length)}…`;
      }
      must(await sb.from('import_batches').update({ imported: rows.length }).eq('id', batchId));
      await audit(`Imported ${rows.length} records from Excel (${filename})`, null, `batch ${batchId}; skipped duplicates ${a.dupFile.length + (cfg.skipExisting ? a.dupDb.length : 0)}; rejected rows ${a.errors.length}; flagged ${flagged.length}`);
      brandsCache = null;
      box.innerHTML = `<div class="banner ok">✅ Imported <b>${fmt(rows.length)}</b> records. <a href="#/admin/inventory">View inventory</a> · <a href="#/">Try a search</a></div>`;
    } catch (e) {
      if (batchId) { await sb.from('inventory').delete().eq('batch_id', batchId); await sb.from('import_batches').delete().eq('id', batchId); }
      $('#ge').textContent = `Import failed and was rolled back: ${friendly(e)}`; $('#go').disabled = false;
    }
  };
}

boot();
