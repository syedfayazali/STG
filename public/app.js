// New Trendz Mobiles & Electronics - inventory lookup (vanilla JS single page app)
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');
const state = { user: null, searchRequiresLogin: false };

async function api(path, { method = 'GET', body, raw, headers = {} } = {}) {
  const opts = { method, headers: { 'X-Requested-With': 'nt', ...headers }, credentials: 'same-origin' };
  if (raw) opts.body = raw;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) state.user = null;
    throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
  }
  return data;
}

let toastT;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1800);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); } catch {
    const ta = document.createElement('textarea'); ta.value = text; document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast(`Copied ${text}`);
}

const dlg = $('#dlg');
function showDialog(html) { dlg.innerHTML = `<div class="dlg">${html}</div>`; if (!dlg.open) dlg.showModal(); return dlg; }
function closeDialog() { if (dlg.open) dlg.close(); }
function confirmDialog(message, ok = 'Confirm', danger = true) {
  return new Promise((resolve) => {
    showDialog(`<h3>Please confirm</h3><div>${message}</div><div class="actions"><button class="btn" id="c-no">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" id="c-yes">${esc(ok)}</button></div>`);
    $('#c-no').onclick = () => { closeDialog(); resolve(false); };
    $('#c-yes').onclick = () => { closeDialog(); resolve(true); };
    dlg.oncancel = () => resolve(false);
  });
}

// ---------------------------------------------------------------- routing
const route = () => (location.hash.replace(/^#\/?/, '') || '').split('?')[0];
window.addEventListener('hashchange', render);
async function boot() {
  try { Object.assign(state, await api('/api/session')); } catch { /* offline */ }
  render();
}
function render() {
  const r = route();
  if (r === 'login') return viewLogin();
  if (r.startsWith('admin')) {
    if (state.user?.role !== 'admin') { sessionStorageSet('after', location.hash); location.hash = '#/login'; return; }
    return viewAdmin(r.split('/')[1] || 'dashboard');
  }
  if (state.searchRequiresLogin && !state.user) { location.hash = '#/login'; return; }
  viewSearch();
}
function sessionStorageSet(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } }
function sessionStorageGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }

const LOGO = `<svg width="30" height="30" viewBox="0 0 64 64"><rect x="20" y="10" width="24" height="44" rx="5" fill="none" stroke="#fff" stroke-width="4"/><circle cx="32" cy="46" r="2.5" fill="#fff"/></svg>`;
const topbar = () => `<div class="topbar">${state.user
  ? `${state.user.role === 'admin' ? '<a href="#/admin/dashboard">Admin</a>' : ''}<button class="linkbtn" id="logout">Sign out (${esc(state.user.username)})</button>`
  : '<a href="#/login">Admin sign in</a>'}</div>`;
function bindLogout() { const b = $('#logout'); if (b) b.onclick = async () => { await api('/api/logout', { method: 'POST' }); state.user = null; location.hash = '#/'; render(); }; }

// ---------------------------------------------------------------- login
function viewLogin() {
  app.innerHTML = `${topbar()}<div class="wrap login"><div class="hero"><div class="logo">${LOGO}</div><h1 style="font-size:22px">SIGN IN</h1></div>
  <form id="lf"><label class="field">Username<input name="u" autocomplete="username" autocapitalize="none" required></label>
  <label class="field">Password<input name="p" type="password" autocomplete="current-password" required></label>
  <div class="err" id="le"></div><button class="btn primary" style="width:100%;margin-top:12px">Sign in</button></form>
  <p class="hint"><a href="#/">Back to search</a></p></div>`;
  bindLogout();
  $('#lf').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const f = new FormData(e.target);
      state.user = (await api('/api/login', { method: 'POST', body: { username: f.get('u'), password: f.get('p') } })).user;
      const after = sessionStorageGet('after');
      location.hash = state.user.role === 'admin' ? (after || '#/admin/dashboard') : '#/';
      render();
    } catch (err) { $('#le').textContent = err.message; }
  };
}

// ---------------------------------------------------------------- search
let searchSeq = 0, lastQuery = '';
function viewSearch() {
  app.innerHTML = `${topbar()}<div class="wrap"><div class="hero"><div class="logo">${LOGO}</div><h1>NEW TRENDZ MOBILES &amp; ELECTRONICS</h1><p>Find the box for any phone</p>
  <form class="searchbox" id="sf" role="search"><input id="q" type="search" placeholder="Search mobile model, brand or model number…" autocomplete="off" autocapitalize="none" spellcheck="false" enterkeyhint="search" aria-label="Search mobile model, brand or model number" value="${esc(lastQuery)}"><button class="btn primary big">Search Inventory</button></form>
  <div class="hint" id="hint">Try “Redmi Note 10 Pro”, “A72”, “Vivo Y200” or a model number</div></div>
  <div class="results" id="res"></div></div>`;
  bindLogout();
  const q = $('#q');
  let t;
  q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => runSearch(q.value), 220); });
  $('#sf').onsubmit = (e) => { e.preventDefault(); clearTimeout(t); runSearch(q.value); q.blur(); };
  if (lastQuery) runSearch(lastQuery); else q.focus();
}

async function runSearch(raw) {
  const q = raw.trim();
  lastQuery = q;
  const res = $('#res');
  if (!res) return;
  if (q.length < 1) { res.innerHTML = ''; $('#hint').hidden = false; return; }
  $('#hint').hidden = true;
  const my = ++searchSeq;
  try {
    const data = await api('/api/search?q=' + encodeURIComponent(q));
    if (my !== searchSeq) return;
    res.innerHTML = renderResults(data);
    $$('[data-copy]', res).forEach((b) => (b.onclick = () => copyText(b.dataset.copy)));
    const add = $('#nr-add'), imp = $('#nr-imp');
    if (add) add.onclick = () => { location.hash = state.user?.role === 'admin' ? '#/admin/inventory?add=1' : '#/login'; if (state.user?.role === 'admin') sessionStorageSet('addq', q); };
    if (imp) imp.onclick = () => { location.hash = state.user?.role === 'admin' ? '#/admin/import' : '#/login'; };
  } catch (e) {
    if (my !== searchSeq) return;
    if (e.status === 401) { location.hash = '#/login'; return; }
    res.innerHTML = `<div class="banner warn">Search is unavailable right now (${esc(e.message)}). Please try again.</div>`;
  }
}

const badgeClass = (t) => ({ 'Exact Match': 'exact', 'Model Match': 'model', 'Brand Match': 'brand' }[t] || 'partial');
function boxBlock(b, compact) {
  const bits = [b.quantity != null ? `${b.quantity} unit${b.quantity === 1 ? '' : 's'}` : '', [b.variant, b.ram, b.storage, b.color].filter(Boolean).join(' · ')].filter(Boolean).join(' — ');
  return `<div class="boxblock"><div class="lbl">BOX NUMBER</div><div class="num"><span>${esc(b.box_number)}</span><button class="copy" data-copy="${esc(b.box_number)}" aria-label="Copy box number ${esc(b.box_number)}">Copy</button></div>${bits ? `<div class="sub">${esc(bits)}</div>` : ''}</div>`;
}
function groupCard(g, { exact, compact }) {
  const warn = [...new Set(g.boxes.map((b) => b.review_reason).filter(Boolean))];
  const notes = [...new Set(g.boxes.map((b) => b.notes).filter(Boolean))];
  const poster = [...new Set(g.boxes.map((b) => b.poster_model).filter(Boolean))];
  return `<article class="card ${exact ? 'exact' : ''} ${compact ? 'compact' : ''}"><div>
    <h3>${esc([g.brand, g.model].filter(Boolean).join(' '))}</h3>
    <div class="meta">${g.model_number ? `Model Number: <b>${esc(g.model_number)}</b> · ` : ''}<span class="badge ${badgeClass(g.matchType)}">${esc(g.matchType)}</span>
      ${g.boxes.length > 1 ? ` <span class="muted">· in ${g.boxes.length} boxes</span>` : ''}</div>
    ${!compact && poster.length ? `<div class="note">Box card: ${esc(poster.join(', '))}</div>` : ''}
    ${warn.length ? `<div class="warnline">⚠ Unverified entry — ${esc(warn[0])}. Please double-check the box.</div>` : ''}
    ${notes.length ? `<div class="note">${esc(notes.join(' · '))}</div>` : ''}
  </div><div class="boxes">${g.boxes.map((b) => boxBlock(b, compact)).join('')}</div></article>`;
}
function renderResults(d) {
  const total = d.exact.length + d.others.length;
  if (!total) {
    return `<div class="empty"><h2>No matching mobile found.</h2><p class="muted">No verified match was found for “${esc(d.query)}”. Check the spelling, or try fewer words.<br>No box number is shown unless it comes from the inventory.</p>
      <div class="row"><button class="btn primary" id="nr-add">Add New Model</button><button class="btn" id="nr-imp">Import Excel</button></div></div>`;
  }
  let html = '';
  if (d.exact.length) {
    html += `<div class="sect">${d.exact.length > 1 ? `${d.exact.length} different phones match exactly` : 'Exact match'}</div>`;
    if (d.exact.length > 1) html += `<div class="banner warn">More than one phone matches “${esc(d.query)}”. Check the brand and model before taking a box.</div>`;
    html += d.exact.map((g) => groupCard(g, { exact: true })).join('');
    if (d.others.length) html += `<details class="more"><summary>Show ${d.others.length} similar model${d.others.length === 1 ? '' : 's'}</summary>${d.others.map((g) => groupCard(g, { compact: true })).join('')}</details>`;
  } else {
    const brandOnly = d.others.every((g) => g.matchType === 'Brand Match');
    html += brandOnly
      ? `<div class="sect">All ${esc(d.others[0].brand)} models</div><div class="banner info">Add the model name to narrow this down${d.truncated ? ' — showing the first results only' : ''}.</div>`
      : `<div class="sect">No exact match — possible matches</div><div class="banner warn">Nothing matches “${esc(d.query)}” exactly. These are <b>possible</b> matches — please check each one.</div>`;
    html += d.others.map((g) => groupCard(g, { compact: true })).join('');
  }
  if (d.truncated && !d.exact.length) html += `<p class="hint">More results exist — type more of the model name to narrow down.</p>`;
  return html;
}

// ---------------------------------------------------------------- admin shell
const TABS = [['dashboard', 'Dashboard'], ['inventory', 'Inventory'], ['import', 'Import / Export'], ['duplicates', 'Duplicates'], ['audit', 'Audit log']];
async function viewAdmin(tab) {
  app.innerHTML = `<div class="adminbar"><div class="wrap wide"><b>NEW TRENDZ · ADMIN</b>${TABS.map(([k, l]) => `<a href="#/admin/${k}" class="${k === tab ? 'on' : ''}">${l}</a>`).join('')}<span class="sp"></span><a href="#/">Search screen</a><a href="#" id="logout">Sign out</a></div></div>
  <div class="wrap wide page" id="page"><div class="spin">Loading…</div></div>`;
  $('#logout').onclick = async (e) => { e.preventDefault(); await api('/api/logout', { method: 'POST' }); state.user = null; location.hash = '#/'; render(); };
  const page = $('#page');
  try {
    if (tab === 'dashboard') await viewDashboard(page);
    else if (tab === 'inventory') await viewInventory(page);
    else if (tab === 'import') await viewImport(page);
    else if (tab === 'duplicates') await viewDuplicates(page);
    else if (tab === 'audit') await viewAudit(page);
    else page.innerHTML = '<p>Page not found.</p>';
  } catch (e) {
    if (e.status === 401 || e.status === 403) { state.user = null; render(); return; }
    page.innerHTML = `<div class="banner warn">${esc(e.message)}</div>`;
  }
}

const fmt = (n) => Number(n).toLocaleString('en-IN');
async function viewDashboard(page) {
  const d = await api('/api/dashboard');
  const max = Math.max(1, ...d.brands.map((b) => b.records));
  page.innerHTML = `<h2>Dashboard</h2>
  <div class="stats">
    <div class="stat"><div class="v">${fmt(d.totalModels)}</div><div class="k">Total models</div></div>
    <div class="stat"><div class="v">${fmt(d.totalRecords)}</div><div class="k">Inventory records</div></div>
    <div class="stat"><div class="v">${fmt(d.totalUnits)}</div><div class="k">Total units${d.recordsWithQuantity < d.totalRecords ? ` (${fmt(d.recordsWithQuantity)} records have a quantity)` : ''}</div></div>
    <div class="stat"><div class="v">${fmt(d.brands.length)}</div><div class="k">Brands</div></div>
    <div class="stat"><div class="v">${fmt(d.boxes)}</div><div class="k">Boxes</div></div>
    <a class="stat ${d.needReview ? 'warn' : ''}" href="#/admin/inventory?review=1"><div class="v">${fmt(d.needReview)}</div><div class="k">Records requiring review</div></a>
    <a class="stat ${d.duplicates ? 'warn' : ''}" href="#/admin/duplicates"><div class="v">${fmt(d.duplicates)}</div><div class="k">Possible duplicate groups</div></a>
  </div>
  <div class="grid2"><div class="panel bars"><h3>Records by brand</h3>${d.brands.map((b) => `<div class="bar"><span>${esc(b.brand)}</span><span><div class="fill" style="width:${(b.records / max) * 100}%"></div></span><span class="muted">${fmt(b.records)}</span></div>`).join('') || '<p class="muted">No data yet — import your Excel file.</p>'}</div>
  <div><div class="panel"><h3>Recently imported</h3>${d.recentImports.length ? `<table><tr><th>When</th><th>File</th><th>Added</th><th></th></tr>${d.recentImports.map((b) => `<tr><td>${esc(b.created_at)}</td><td>${esc(b.filename)}</td><td>${fmt(b.imported)}</td><td><button class="btn sm danger" data-undo="${b.id}">Undo</button></td></tr>`).join('')}</table>` : '<p class="muted">No imports yet.</p>'}</div>
  <div class="panel"><h3>Recently added records</h3>${d.recentModels.length ? `<table>${d.recentModels.map((r) => `<tr><td>${esc(r.brand)} ${esc(r.model)}</td><td class="box">${esc(r.box_number)}</td></tr>`).join('')}</table>` : '<p class="muted">Nothing yet.</p>'}</div></div></div>`;
  $$('[data-undo]', page).forEach((b) => (b.onclick = async () => {
    if (!(await confirmDialog('Remove <b>every record</b> created by this import? Records you added or edited by hand are not affected, but edits to imported records will be lost.', 'Undo import'))) return;
    const r = await api('/api/import/' + b.dataset.undo, { method: 'DELETE' }); toast(`Removed ${r.removed} records`); render();
  }));
}

// ---------------------------------------------------------------- inventory
const invState = { q: '', brand: '', box: '', sort: 'newest', page: 1, review: '', batch: '' };
async function viewInventory(page) {
  const qs = new URLSearchParams((location.hash.split('?')[1]) || '');
  if (qs.get('review') === '1') invState.review = '1';
  const brands = await api('/api/brands');
  page.innerHTML = `<h2>Inventory</h2>
  <div class="toolbar"><button class="btn primary" id="add">+ Add model</button><a class="btn" href="#/admin/import">Import Excel</a><a class="btn" id="export" href="#">Export to Excel</a></div>
  <div class="toolbar"><input id="f-q" placeholder="Search…" value="${esc(invState.q)}" style="flex:1 1 200px"><select id="f-brand"><option value="">All brands</option>${brands.map((b) => `<option value="${esc(b.brand)}" ${invState.brand === b.brand ? 'selected' : ''}>${esc(b.brand)} (${b.records})</option>`).join('')}</select>
  <input id="f-box" placeholder="Box number" style="width:130px" value="${esc(invState.box)}">
  <select id="f-sort">${[['newest', 'Newest first'], ['brand', 'Brand / model'], ['model', 'Model'], ['box', 'Box number'], ['updated', 'Recently updated']].map(([v, l]) => `<option value="${v}" ${invState.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
  <label class="chip"><input type="checkbox" id="f-review" ${invState.review ? 'checked' : ''}> Needs review only</label></div>
  <div class="toolbar" id="bulk" hidden><b id="bulkn"></b><input id="bulkbox" placeholder="New box number" style="width:150px"><button class="btn sm" id="bulkmove">Move to box</button><button class="btn sm danger" id="bulkdel">Delete selected</button></div>
  <div class="tablewrap"><table><thead><tr><th><input type="checkbox" id="all" aria-label="Select all"></th><th>Brand</th><th>Model</th><th>Model no.</th><th>Box</th><th>Qty</th><th>Details</th><th></th></tr></thead><tbody id="rows"></tbody></table></div><div class="pager" id="pager"></div>`;
  const sel = new Set();
  let data;
  const load = async () => {
    const p = new URLSearchParams({ q: invState.q, brand: invState.brand, box: invState.box, sort: invState.sort, page: invState.page, review: invState.review, batch: invState.batch });
    data = await api('/api/inventory?' + p);
    sel.clear(); drawRows();
  };
  const drawRows = () => {
    $('#rows').innerHTML = data.rows.map((r) => `<tr class="${r.review_reason ? 'warn' : ''}"><td><input type="checkbox" data-sel="${r.id}" ${sel.has(r.id) ? 'checked' : ''}></td><td>${esc(r.brand)}</td><td>${esc(r.model)}</td><td>${esc(r.model_number)}</td><td class="box">${esc(r.box_number)}</td><td>${r.quantity ?? ''}</td>
      <td class="muted">${esc([r.variant, r.ram, r.storage, r.color].filter(Boolean).join(' · '))}${r.review_reason ? `<div style="color:var(--amber)">⚠ ${esc(r.review_reason)}</div>` : ''}${r.extra?.poster_model ? `<div>Box card: ${esc(r.extra.poster_model)}</div>` : ''}</td>
      <td style="white-space:nowrap"><button class="btn sm" data-edit="${r.id}">Edit</button> <button class="btn sm danger" data-del="${r.id}">Delete</button></td></tr>`).join('') || `<tr><td colspan="8" class="muted" style="padding:24px;text-align:center">No records found.</td></tr>`;
    const pages = Math.max(1, Math.ceil(data.total / data.size));
    $('#pager').innerHTML = `<button class="btn sm" id="pp" ${data.page <= 1 ? 'disabled' : ''}>‹ Prev</button><span>${fmt(data.total)} records · page ${data.page} of ${pages}</span><button class="btn sm" id="pn" ${data.page >= pages ? 'disabled' : ''}>Next ›</button>`;
    $('#pp').onclick = () => { invState.page--; load(); }; $('#pn').onclick = () => { invState.page++; load(); };
    updateBulk();
    $$('[data-sel]').forEach((c) => (c.onchange = () => { c.checked ? sel.add(+c.dataset.sel) : sel.delete(+c.dataset.sel); updateBulk(); }));
    $$('[data-edit]').forEach((b) => (b.onclick = () => editDialog(data.rows.find((r) => r.id === +b.dataset.edit), load)));
    $$('[data-del]').forEach((b) => (b.onclick = async () => {
      const r = data.rows.find((x) => x.id === +b.dataset.del);
      if (!(await confirmDialog(`Delete <b>${esc(r.brand)} ${esc(r.model)}</b> in box <b>${esc(r.box_number)}</b>? This cannot be undone.`, 'Delete'))) return;
      await api('/api/inventory/' + r.id, { method: 'DELETE' }); toast('Deleted'); load();
    }));
  };
  const updateBulk = () => { $('#bulk').hidden = !sel.size; $('#bulkn').textContent = `${sel.size} selected`; $('#all').checked = data.rows.length > 0 && sel.size === data.rows.length; };
  $('#all').onchange = (e) => { sel.clear(); if (e.target.checked) data.rows.forEach((r) => sel.add(r.id)); drawRows(); };
  $('#bulkdel').onclick = async () => {
    if (!(await confirmDialog(`Delete <b>${sel.size}</b> selected records? This cannot be undone.`, `Delete ${sel.size} records`))) return;
    await api('/api/inventory/bulk-delete', { method: 'POST', body: { ids: [...sel], confirm: true } }); toast('Deleted'); load();
  };
  $('#bulkmove').onclick = async () => {
    const box = $('#bulkbox').value.trim(); if (!box) return toast('Enter the new box number');
    if (!(await confirmDialog(`Move <b>${sel.size}</b> selected records to box <b>${esc(box)}</b>?`, 'Move', false))) return;
    await api('/api/inventory/bulk-update', { method: 'POST', body: { ids: [...sel], box_number: box, confirm: true } }); toast('Updated'); load();
  };
  let t;
  const refilter = () => { invState.q = $('#f-q').value; invState.box = $('#f-box').value; invState.brand = $('#f-brand').value; invState.sort = $('#f-sort').value; invState.review = $('#f-review').checked ? '1' : ''; invState.page = 1; invState.batch = ''; load(); };
  ['#f-q', '#f-box'].forEach((s) => $(s).addEventListener('input', () => { clearTimeout(t); t = setTimeout(refilter, 250); }));
  ['#f-brand', '#f-sort', '#f-review'].forEach((s) => $(s).addEventListener('change', refilter));
  $('#add').onclick = () => editDialog(null, load);
  $('#export').onclick = (e) => { e.preventDefault(); const p = new URLSearchParams({ q: invState.q, brand: invState.brand, box: invState.box, review: invState.review }); location.href = '/api/export?' + p; };
  await load();
  if (qs.get('add') === '1') { const q = sessionStorageGet('addq') || ''; editDialog(null, load, q); history.replaceState(null, '', '#/admin/inventory'); }
}

function editDialog(rec, onSaved, prefillModel = '') {
  const r = rec || { brand: '', model: prefillModel, model_number: '', box_number: '', variant: '', ram: '', storage: '', color: '', imei: '', quantity: null, notes: '', extra: {} };
  const f = (name, label, o = {}) => `<label class="field ${o.full ? 'full' : ''}">${label}${o.area ? `<textarea name="${name}" rows="2">${esc(r[name])}</textarea>` : `<input name="${name}" value="${esc(r[name] ?? '')}" ${o.req ? 'required' : ''} ${o.num ? 'type="number" min="0" step="1" inputmode="numeric"' : ''}>`}</label>`;
  showDialog(`<h3>${rec ? 'Edit record' : 'Add model'}</h3><form id="ef"><div class="form">
    ${f('brand', 'Brand')}${f('model', 'Model name *', { req: 1 })}${f('model_number', 'Model number')}${f('box_number', 'Box number *', { req: 1 })}
    ${f('variant', 'Variant')}${f('ram', 'RAM')}${f('storage', 'Storage')}${f('color', 'Color')}${f('imei', 'IMEI (optional)')}${f('quantity', 'Quantity', { num: 1 })}${f('notes', 'Notes', { full: 1, area: 1 })}
    <div class="field full">Custom fields<div id="xf"></div><button type="button" class="btn sm" id="xadd" style="width:max-content;margin-top:6px">+ Add field</button></div></div>
    <div class="err" id="ee"></div><div class="actions"><button type="button" class="btn" id="ecancel">Cancel</button><button class="btn primary">${rec ? 'Save changes' : 'Add model'}</button></div></form>`);
  const xf = $('#xf');
  const addX = (k = '', v = '') => { const d = document.createElement('div'); d.className = 'maprow'; d.style.gridTemplateColumns = '1fr 1fr auto'; d.innerHTML = `<input placeholder="Name" value="${esc(k)}" class="xk"><input placeholder="Value" value="${esc(v)}" class="xv"><button type="button" class="btn sm" aria-label="Remove">✕</button>`; $('button', d).onclick = () => d.remove(); xf.append(d); };
  Object.entries(r.extra || {}).forEach(([k, v]) => addX(k, v));
  $('#xadd').onclick = () => addX();
  $('#ecancel').onclick = closeDialog;
  $('#ef').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    fd.extra = {}; $$('.maprow', xf).forEach((d) => { const k = $('.xk', d).value.trim(); if (k) fd.extra[k] = $('.xv', d).value; });
    const send = (extra = {}) => api(rec ? '/api/inventory/' + rec.id : '/api/inventory', { method: rec ? 'PUT' : 'POST', body: { ...fd, ...extra } });
    try { await send(); closeDialog(); toast(rec ? 'Saved' : 'Added'); onSaved(); } catch (err) {
      if (err.status === 409) {
        const d = err.data.duplicates[0];
        if (await confirmDialog(`${esc(err.message)}<br><br>Existing: <b>${esc(d.brand)} ${esc(d.model)}</b> ${d.model_number ? `(${esc(d.model_number)}) ` : ''}in box <b>${esc(d.box_number)}</b>.<br><br>Save anyway as a separate record?`, 'Save anyway', false)) {
          try { await send({ allowDuplicate: true }); closeDialog(); toast('Saved'); onSaved(); } catch (e2) { $('#ee')?.replaceChildren(e2.message); }
        } else if (!dlg.open) editDialog(rec, onSaved);
      } else $('#ee').textContent = err.message;
    }
  };
}

// ---------------------------------------------------------------- duplicates / audit
async function viewDuplicates(page) {
  const groups = await api('/api/duplicates');
  page.innerHTML = `<h2>Possible duplicates</h2><p class="muted">Records with the same brand, model, model number <b>and</b> box. Nothing is removed automatically — review each group and delete the extra ones you do not need.</p>
  ${groups.length ? groups.map((g) => `<div class="panel"><div class="tablewrap"><table><tr><th>ID</th><th>Brand</th><th>Model</th><th>Model no.</th><th>Box</th><th>Qty</th><th>Added</th><th></th></tr>${g.rows.map((r) => `<tr><td>${r.id}</td><td>${esc(r.brand)}</td><td>${esc(r.model)}</td><td>${esc(r.model_number)}</td><td class="box">${esc(r.box_number)}</td><td>${r.quantity ?? ''}</td><td>${esc(r.created_at)}</td><td><button class="btn sm danger" data-del="${r.id}">Delete this one</button></td></tr>`).join('')}</table></div></div>`).join('') : '<div class="banner info">No duplicates found. 🎉</div>'}`;
  $$('[data-del]', page).forEach((b) => (b.onclick = async () => {
    if (!(await confirmDialog(`Delete record <b>#${b.dataset.del}</b>? This cannot be undone.`, 'Delete'))) return;
    await api('/api/inventory/' + b.dataset.del, { method: 'DELETE' }); toast('Deleted'); render();
  }));
}
let auditPage = 1;
async function viewAudit(page) {
  const d = await api('/api/audit?page=' + auditPage);
  const pages = Math.max(1, Math.ceil(d.total / d.size));
  page.innerHTML = `<h2>Audit log</h2><div class="tablewrap"><table><tr><th>Date / time (UTC)</th><th>User</th><th>Action</th><th>Details</th></tr>${d.rows.map((r) => `<tr><td style="white-space:nowrap">${esc(r.at)}</td><td>${esc(r.username)}</td><td>${esc(r.action)}</td><td class="muted">${esc(r.detail)}${r.record_id ? ` (record #${r.record_id})` : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Nothing logged yet.</td></tr>'}</table></div>
  <div class="pager"><button class="btn sm" id="pp" ${auditPage <= 1 ? 'disabled' : ''}>‹ Newer</button><span>page ${auditPage} of ${pages}</span><button class="btn sm" id="pn" ${auditPage >= pages ? 'disabled' : ''}>Older ›</button></div>`;
  $('#pp').onclick = () => { auditPage--; render(); }; $('#pn').onclick = () => { auditPage++; render(); };
}

// ---------------------------------------------------------------- import wizard
const FIELD_LABELS = { brand: 'Brand', model: 'Model *', model_number: 'Model Number', box_number: 'Box Number *', variant: 'Variant', ram: 'RAM', storage: 'Storage', color: 'Color', imei: 'IMEI', quantity: 'Quantity', notes: 'Notes' };
async function viewImport(page) {
  page.innerHTML = `<h2>Import / Export</h2>
  <div class="toolbar"><a class="btn" href="/api/template">⬇ Download Excel template</a><a class="btn" href="/api/export">⬇ Export all inventory to Excel</a></div>
  <div class="panel"><h3>1. Upload an Excel file (.xlsx or .xls)</h3><label class="drop" id="drop"><input type="file" id="file" accept=".xlsx,.xls" hidden><b>Drop a file here</b> or tap to choose<div class="muted">Nothing is imported until you review the preview and confirm.</div></label><div class="err" id="ue"></div></div><div id="wiz"></div>`;
  const handle = async (file) => {
    if (!file) return;
    $('#ue').textContent = '';
    $('#drop').innerHTML = `<div class="spin">Reading ${esc(file.name)}…</div>`;
    try {
      const up = await api('/api/import/upload?filename=' + encodeURIComponent(file.name), { method: 'POST', raw: await file.arrayBuffer(), headers: { 'Content-Type': 'application/octet-stream' } });
      $('#drop').innerHTML = `<b>${esc(file.name)}</b> <span class="muted">— choose another file to replace</span><input type="file" id="file" accept=".xlsx,.xls" hidden>`;
      $('#file').onchange = (e) => handle(e.target.files[0]);
      wizard(up, file.name);
    } catch (e) { $('#ue').textContent = e.message; $('#drop').innerHTML = `<input type="file" id="file" accept=".xlsx,.xls" hidden><b>Drop a file here</b> or tap to choose`; $('#file').onchange = (ev) => handle(ev.target.files[0]); }
  };
  $('#file').onchange = (e) => handle(e.target.files[0]);
  const drop = $('#drop');
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); }; drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); handle(e.dataTransfer.files[0]); };
}

function wizard(up, filename) {
  const wiz = $('#wiz');
  const draw = (si) => {
    const s = up.sheets[si];
    const opts = (cur, blank) => `${blank ? '<option value="">— none —</option>' : ''}${s.headers.map((h) => `<option ${h === cur ? 'selected' : ''}>${esc(h)}</option>`).join('')}`;
    wiz.innerHTML = `<div class="panel"><h3>2. Match your columns</h3>
      <div class="toolbar">${up.sheets.length > 1 ? `<label>Sheet <select id="sheet">${up.sheets.map((x, i) => `<option value="${i}" ${i === si ? 'selected' : ''}>${esc(x.name)} (${x.rows} rows)</option>`).join('')}</select></label>` : `<span class="muted">${s.rows} data rows</span>`}
      <label>File layout <select id="mode"><option value="flat" ${s.mode === 'flat' ? 'selected' : ''}>One row per phone (Brand, Model, Box…)</option><option value="chart" ${s.mode === 'chart' ? 'selected' : ''}>Compatibility chart (box row, one column per brand)</option></select></label></div>
      <div id="cfg"></div>
      <label class="chip" style="margin-top:10px"><input type="checkbox" id="skip" checked> Skip rows that already exist in the inventory</label>
      <div style="margin-top:14px"><button class="btn primary" id="prev">Preview import</button></div><div class="err" id="we"></div></div><div id="preview"></div>`;
    const drawCfg = () => {
      const mode = $('#mode').value;
      if (mode === 'flat') {
        $('#cfg').innerHTML = `<p class="muted">Pick which Excel column holds each field. Model and Box Number are required.</p>${Object.entries(FIELD_LABELS).map(([f, l]) => `<div class="maprow"><span>${l}</span><select data-f="${f}">${opts(s.flat[f], true)}</select></div>`).join('')}<label class="chip"><input type="checkbox" id="keepx"> Keep other columns as custom fields</label>`;
      } else {
        $('#cfg').innerHTML = `<p class="muted">Each row is one box. Every brand column lists the models that belong in that box, separated by “/”. They are split into one searchable record per model.</p>
        <div class="maprow"><span>Box number column *</span><select id="c-box">${opts(s.chart.boxColumn)}</select></div>
        <div class="maprow"><span>Box label column</span><select id="c-label">${opts(s.chart.labelColumn, true)}</select></div>
        <div style="margin-top:8px"><b style="font-size:14px">Brand columns</b></div>
        ${s.headers.filter((h) => h !== s.chart.boxColumn && h !== s.chart.labelColumn).map((h) => { const b = s.chart.brandColumns.find((x) => x.column === h); return `<div class="maprow" style="grid-template-columns:24px 140px 1fr"><input type="checkbox" class="bc" data-col="${esc(h)}" ${b ? 'checked' : ''}><span>${esc(h)}</span><input class="bn" value="${esc(b?.brand || h)}" aria-label="Brand name for ${esc(h)}"></div>`; }).join('')}`;
      }
    };
    drawCfg();
    $('#mode').onchange = drawCfg;
    if ($('#sheet')) $('#sheet').onchange = (e) => draw(+e.target.value);
    const config = () => {
      const mode = $('#mode').value;
      const cfg = { mode, skipExisting: $('#skip').checked };
      if (mode === 'flat') { cfg.flat = { mapping: {}, keepExtra: $('#keepx').checked }; $$('[data-f]').forEach((x) => { if (x.value) cfg.flat.mapping[x.dataset.f] = x.value; }); }
      else cfg.chart = { boxColumn: $('#c-box').value, labelColumn: $('#c-label').value, brandColumns: $$('.bc').filter((c) => c.checked).map((c) => ({ column: c.dataset.col, brand: c.closest('.maprow').querySelector('.bn').value })) };
      return cfg;
    };
    $('#prev').onclick = async () => {
      $('#we').textContent = ''; $('#preview').innerHTML = '<div class="spin">Checking the data…</div>';
      try {
        const body = { uploadId: up.uploadId, sheet: s.name, config: config() };
        const p = await api('/api/import/preview', { method: 'POST', body });
        previewView(p, body, filename);
      } catch (e) { $('#preview').innerHTML = ''; $('#we').textContent = e.message; }
    };
  };
  draw(Math.max(0, up.sheets.findIndex((x) => x.rows > 0)));
}

function previewView(p, body, filename) {
  const box = $('#preview');
  const tbl = (rows, cols, cls = () => '') => `<div class="tablewrap" style="max-height:420px;overflow:auto"><table><tr>${cols.map(([, l]) => `<th>${l}</th>`).join('')}</tr>${rows.map((r) => `<tr class="${cls(r)}">${cols.map(([k]) => `<td>${esc(typeof k === 'function' ? k(r) : r[k])}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${cols.length}" class="muted">Nothing here.</td></tr>`}</table></div>`;
  const base = [['row', 'Excel row'], ['brand', 'Brand'], ['model', 'Model'], ['model_number', 'Model no.'], ['box_number', 'Box']];
  const tabs = {
    import: ['Will import', p.willImport, () => tbl(p.sample, [...base, [(r) => r.notes || r.review_reason, 'Notes']], (r) => (r.review_reason ? 'warn' : '')) + (p.willImport > p.sample.length ? `<p class="muted">Showing the first ${p.sample.length} of ${fmt(p.willImport)}.</p>` : '')],
    review: ['Flagged for review', p.flagged, () => tbl(p.flaggedSample, [...base, ['review_reason', 'Why']], () => 'warn')],
    errors: ['Rejected rows', p.errors, () => tbl(p.errorList.map((e) => ({ row: e.row, reason: e.reason, ...e.data })), [...base, ['reason', 'Problem']], () => 'bad') + '<p class="muted">Rejected rows are not imported. Fix them in Excel and import again.</p>'],
    dupe: ['Duplicates', p.duplicatesInFile + p.duplicatesInDb, () => `<p class="muted">${fmt(p.duplicatesInFile)} repeated inside the file, ${fmt(p.duplicatesInDb)} already in the inventory. ${body.config.skipExisting ? 'Existing ones are skipped.' : 'Existing ones will be imported and flagged for review.'}</p>` + tbl([...p.dupFileList.map((d) => ({ ...d, where: `Same as row ${d.firstRow}` })), ...p.dupDbList.map((d) => ({ ...d, where: 'Already in inventory' }))], [...base, ['where', 'Duplicate of']])],
  };
  box.innerHTML = `<div class="panel"><h3>3. Review &amp; confirm</h3>
    <div class="stats"><div class="stat"><div class="v">${fmt(p.willImport)}</div><div class="k">records will be imported</div></div><div class="stat ${p.flagged ? 'warn' : ''}"><div class="v">${fmt(p.flagged)}</div><div class="k">flagged for review</div></div><div class="stat ${p.errors ? 'warn' : ''}"><div class="v">${fmt(p.errors)}</div><div class="k">rows rejected</div></div><div class="stat"><div class="v">${fmt(p.duplicatesInFile + p.duplicatesInDb)}</div><div class="k">duplicates found</div></div></div>
    <div class="tabs">${Object.entries(tabs).map(([k, [l, n]]) => `<button class="tab" data-tab="${k}">${l} (${fmt(n)})</button>`).join('')}</div><div id="tabbody"></div>
    <div style="margin-top:16px"><button class="btn primary" id="go" ${p.willImport ? '' : 'disabled'}>Import ${fmt(p.willImport)} records</button></div><div class="err" id="ge"></div></div>`;
  const show = (k) => { $$('.tab', box).forEach((t) => t.classList.toggle('on', t.dataset.tab === k)); $('#tabbody').innerHTML = tabs[k][2](); };
  $$('.tab', box).forEach((t) => (t.onclick = () => show(t.dataset.tab)));
  show(p.errors ? 'errors' : 'import');
  $('#go').onclick = async () => {
    if (!(await confirmDialog(`Import <b>${fmt(p.willImport)}</b> records from <b>${esc(filename)}</b>? ${p.errors ? `<br>${fmt(p.errors)} rejected rows will be left out.` : ''}<br>You can undo the whole import from the dashboard.`, 'Import', false))) return;
    $('#go').disabled = true;
    try {
      const r = await api('/api/import/confirm', { method: 'POST', body });
      box.innerHTML = `<div class="banner info">✅ Imported <b>${fmt(r.imported)}</b> records. <a href="#/admin/inventory">View inventory</a> · <a href="#/">Try a search</a></div>`;
    } catch (e) { $('#ge').textContent = e.message; $('#go').disabled = false; }
  };
}

boot();
