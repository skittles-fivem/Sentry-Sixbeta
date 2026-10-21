'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (name) => `<svg class="i" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const store = {
    get(k, d) { try { const v = localStorage.getItem(`sm:${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(`sm:${k}`, JSON.stringify(v)); } catch { /* private mode */ } }
  };

  function bytes(n) {
    if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
    const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
    let v = Number(n);
    let i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
  }
  const plural = (n, w) => `${Number(n || 0).toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
  const when = (ts) => (ts ? new Date(ts).toLocaleString() : '—');
  function ago(ts) {
    if (!ts) return 'never';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(ts).toLocaleDateString();
  }
  const humanize = (s) => String(s || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

  async function api(path, opts = {}, retried = false) {
    const init = { credentials: 'same-origin', headers: { 'X-Requested-With': 'sentry-six-manager' } };
    if (opts.method) init.method = opts.method;
    if (opts.body !== undefined) {
      init.method = init.method || 'POST';
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, init);
    if (res.status === 401 && !path.startsWith('/api/auth/')) {
      location.href = `/login?next=${encodeURIComponent(location.pathname + location.hash)}`;
      throw new Error('Signed out');
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 403 && data.code === 'CONFIRM_PASSWORD' && !retried) {
      // changes that could hand someone the shares or the server need the password again
      await confirmPassword();
      return api(path, opts, true);
    }
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  /** Ask for the password and confirm it with the server; throws if cancelled. */
  async function confirmPassword() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const password = await passwordDialog(attempt ? 'That password was not right. Try again.' : 'This change affects where footage comes from or what code runs, so Sentry Six Manager asks for your password again.');
      if (password === null) throw new Error('Not changed: the password was not confirmed.');
      try {
        await api('/api/auth/confirm', { body: { password } }, true);
        return;
      } catch (err) {
        if (/Too many/.test(err.message)) throw err;
      }
    }
    throw new Error('Not changed: the password was not confirmed.');
  }

  function passwordDialog(message) {
    return new Promise((resolve) => {
      const dlg = $('dialog');
      $('dialog-form').innerHTML = `<h2>Confirm with your password</h2><p>${esc(message)}</p>
        <label class="field" style="margin-top:14px">Password<input class="input" type="password" name="confirm-password" autocomplete="current-password"></label>
        <div class="form-actions"><button class="btn" value="cancel">Cancel</button><button class="btn solid" value="ok">Confirm</button></div>`;
      const input = $('dialog-form').querySelector('[name=confirm-password]');
      dlg.onclose = () => resolve(dlg.returnValue === 'ok' && input.value ? input.value : null);
      dlg.returnValue = '';
      dlg.showModal();
      input.focus();
    });
  }

  function toast(msg, bad = false) {
    const el = document.createElement('div');
    el.className = `toast${bad ? ' bad' : ''}`;
    el.textContent = msg;
    $('toasts').append(el);
    setTimeout(() => el.remove(), bad ? 9000 : 5000);
  }

  /** Confirm dialog; resolves true/false. */
  function confirmDialog({ title, body, ok = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
      const dlg = $('dialog');
      $('dialog-form').innerHTML = `<h2>${esc(title)}</h2>${body}<div class="form-actions"><button class="btn" value="cancel">Cancel</button><button class="btn ${danger ? 'danger' : 'solid'}" value="ok">${esc(ok)}</button></div>`;
      dlg.onclose = () => resolve(dlg.returnValue === 'ok');
      dlg.returnValue = '';
      dlg.showModal();
    });
  }

  const state = {
    route: 'overview',
    vehicles: [],
    vehicleId: store.get('vehicle', null),
    notes: [],
    footage: { category: 'all', date: '', offset: 0, data: null, selected: new Set(), expanded: new Set() },
    system: null
  };
  const current = () => state.vehicles.find((v) => v.id === state.vehicleId) || state.vehicles[0] || null;

  // ---------- shell ----------
  // thumbnails that fail to load show their category instead (no inline handlers: CSP)
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (img instanceof HTMLImageElement && img.dataset.fallback !== undefined) img.replaceWith(Object.assign(document.createElement('span'), { textContent: img.dataset.fallback }));
  }, true);
  const app = $('app');
  if (store.get('collapsed', false)) app.classList.add('collapsed');
  $('collapse').addEventListener('click', () => {
    app.classList.toggle('collapsed');
    app.classList.remove('auto-collapsed');
    store.set('collapsed', app.classList.contains('collapsed'));
    setTimeout(() => fitFrames(), 50);
  });
  $('reduce-effects').addEventListener('change', (e) => {
    document.documentElement.classList.toggle('reduce-effects', e.target.checked);
    api('/api/settings/appearance', { method: 'PUT', body: { reduceEffects: e.target.checked } }).catch(() => {});
  });

  function setBadge(id, text, cls = '') {
    const b = $(id);
    b.hidden = !text;
    b.textContent = text || '';
    b.className = `count ${cls}`;
  }

  async function loadVehicles() {
    const { vehicles } = await api('/api/vehicles');
    state.vehicles = vehicles;
    if (!current() && vehicles.length) state.vehicleId = vehicles[0].id;
    else if (current()) state.vehicleId = current().id;
    const binItems = vehicles.reduce((n, v) => n + v.binItems, 0);
    setBadge('badge-bin', binItems ? String(binItems) : '');
  }

  async function loadNotes() {
    const { notifications } = await api('/api/notifications?open=1');
    state.notes = notifications;
    setBadge('badge-notes', notifications.length ? String(notifications.length) : '', 'alert');
  }

  function pills() {
    if (!state.vehicles.length) {
      return `<div class="pills"><a class="pill add" href="#/settings">${icon('plus')} Add your first vehicle</a></div>`;
    }
    return `<div class="pills" role="tablist" aria-label="Vehicles">${state.vehicles.map((v) => {
      const s = v.share;
      const dot = !s ? '' : s.healthy ? (s.writable === false ? 'warn' : 'ok') : 'bad';
      const n = v.inventory ? plural(v.inventory.recordings, 'recording') : v.scanning ? 'scanning…' : 'not scanned yet';
      return `<button class="pill${v.id === current()?.id ? ' active' : ''}" role="tab" aria-selected="${v.id === current()?.id}" data-vehicle="${esc(v.id)}">
        <span class="row"><span class="dot ${dot}"></span>${esc(v.name)}</span><span class="sub">${esc(n)}</span></button>`;
    }).join('')}</div>`;
  }

  function head(eyebrow, title, extra = '') {
    return `<div class="page-head"><div><p class="eyebrow">${esc(eyebrow)}</p><h1>${esc(title)}</h1></div>
      <div class="head-actions">${extra}<button class="btn" data-action="signout">Sign out</button></div></div>`;
  }

  const page = $('page');
  page.addEventListener('click', async (e) => {
    const pill = e.target.closest('[data-vehicle]');
    if (pill) {
      state.vehicleId = pill.dataset.vehicle;
      store.set('vehicle', state.vehicleId);
      state.footage.offset = 0;
      state.footage.selected.clear();
      return render();
    }
    const act = e.target.closest('[data-action]');
    if (act && act.dataset.action === 'signout') {
      await api('/api/auth/logout', { body: {} }).catch(() => {});
      location.href = '/login';
    }
  });

  // ---------- pages ----------
  const pages = {};

  pages.overview = async () => {
    const v = current();
    let html = head('Your archive workspace', 'Overview') + pills();
    if (!v) {
      html += `<div class="card"><h2>Add a vehicle</h2><p>Each vehicle has its own footage share (SMB) or folder. Add one in Settings to start.</p><div class="form-actions" style="justify-content:flex-start"><a class="btn solid" href="#/settings">Open settings</a></div></div>`;
      page.innerHTML = html;
      return;
    }
    const s = v.share || {};
    const ready = s.healthy && s.writable !== false;
    html += `<div class="toolbar"><div class="left">
        <span class="chip ${ready ? '' : s.healthy ? 'amber' : 'red'}">${ready ? 'Management ready' : s.healthy ? 'Read-only share' : 'Share unavailable'}</span>
        <span class="muted">${esc(v.timezone)}</span></div>
      <div class="right"><a class="btn" href="#/settings/vehicle/${esc(v.id)}">Vehicle settings</a><button class="btn" id="refresh-inv">Refresh inventory</button></div></div>`;
    const inv = v.inventory;
    const used = s.totalBytes ? 1 - s.freeBytes / s.totalBytes : null;
    html += `<div class="grid2">
      <div class="card"><p class="card-label">Last discovered inventory</p><div class="big">${inv ? bytes(inv.bytes) : '—'}</div>
        <p>${inv ? `${plural(inv.recordings, 'recording')} · all categories · ${ago(inv.scannedAt)}` : v.scanning ? 'Scanning…' : 'Not scanned yet'}</p></div>
      <div class="card"><p class="card-label">Last observed free on ${esc(v.name)}</p><div class="big">${bytes(s.freeBytes)}</div>
        <p>${s.totalBytes ? `${bytes(s.totalBytes)} volume capacity · ${Math.round(used * 100)}% used${v.binBytes ? ` · ${bytes(v.binBytes)} in the Recycle Bin` : ''}` : 'Capacity unknown'}</p>
        ${used !== null ? `<div class="meter"><span class="${used > 0.95 ? 'bad' : used > 0.85 ? 'warn' : ''}" style="width:${Math.round(used * 100)}%"></span></div>` : ''}</div>
    </div>
    <div class="card row"><div><h2>Browse your archive</h2><p>Explore recordings by category and capture date. Files and existing event thumbnails are available in Footage.</p></div>
      <div style="display:flex;gap:12px;flex-wrap:wrap"><a class="btn" href="#/viewer">Open viewer</a><a class="btn" href="#/footage">Open footage</a></div></div>
    <div class="card row"><div><h2>Encoder</h2><p id="enc-line">Convert footage to H.265 or AV1 with the Sentry Studio converter. Telemetry is copied into every frame and verified before an original is replaced.</p></div>
      <a class="btn" href="#/encoder">Open encoder</a></div>`;
    const notes = state.notes.filter((n) => !n.vehicleId || n.vehicleId === v.id);
    html += `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><h2>Current archive alerts</h2><button class="btn" id="refresh-alerts">Refresh current alerts</button></div>
      <p class="muted small" style="margin-top:12px">${plural(notes.length, 'unresolved alert')}. Resolved alerts stay in Notifications.</p>
      ${notes.length ? `<ul class="alerts">${notes.slice(0, 5).map((n) => `<li class="alert-item"><span class="dot ${n.level === 'critical' ? 'bad' : n.level === 'info' ? 'ok' : 'warn'}"></span><div><b>${esc(n.title)}</b><span>${esc(n.message || '')}</span></div><span class="muted small">${ago(n.updatedAt)}</span></li>`).join('')}</ul>`
        : '<p style="margin:14px 0 18px">No unresolved storage or source incidents reported.</p>'}
      <a class="btn" href="#/notifications">Open notifications</a></div>`;
    page.innerHTML = html;
    $('refresh-inv').onclick = () => api(`/api/vehicles/${v.id}/scan`, { body: {} }).then(() => toast('Refreshing the inventory…'), (err) => toast(err.message, true));
    $('refresh-alerts').onclick = () => loadNotes().then(render);
  };

  pages.footage = async () => {
    const v = current();
    const f = state.footage;
    let html = head('Your archive workspace', 'Footage') + pills();
    if (!v) {
      page.innerHTML = `${html}<div class="empty">Add a vehicle in Settings first.</div>`;
      return;
    }
    const q = new URLSearchParams({ category: f.category, offset: String(f.offset), limit: '100' });
    if (f.date) q.set('date', f.date);
    let data;
    try {
      data = await api(`/api/vehicles/${v.id}/recordings?${q}`);
    } catch (err) {
      page.innerHTML = `${html}<div class="empty">${esc(err.message)}</div>`;
      return;
    }
    f.data = data;
    const shown = data.recordings;
    const sel = [...f.selected];
    const selRecs = shown.filter((r) => f.selected.has(r.id));
    html += `<div class="filters">
        <label class="field">Category<select class="input" id="f-cat">
          ${['all', 'Recent', 'Sentry', 'Saved', 'Other'].map((c) => `<option value="${c}"${f.category === c ? ' selected' : ''}>${c === 'all' ? 'All categories' : `${c}`}</option>`).join('')}</select></label>
        <label class="field">Capture date<input class="input" type="date" id="f-date" value="${esc(f.date)}"${data.dates.length ? ` min="${data.dates[data.dates.length - 1]}" max="${data.dates[0]}"` : ''}></label>
        ${f.date ? '<button class="btn ghost" id="f-clear">Clear date</button>' : ''}
      </div>
      <p class="hint">${plural(data.total, 'recording')} shown${data.scanning ? ' · scanning…' : ''} · capture times use the vehicle timezone${data.scannedAt ? ` · inventory ${ago(data.scannedAt)}` : ''}</p>
      <div class="selpanel"><div class="row">
        <b class="count">${sel.length} selected</b>
        <button class="btn" id="sel-trash"${sel.length ? '' : ' disabled'}>Move to trash</button>
        <button class="btn green" id="sel-protect"${sel.length ? '' : ' disabled'}>Protect</button>
        <button class="btn" id="sel-unprotect"${selRecs.some((r) => r.protected) ? '' : ' disabled'}>Unprotect</button>
        <button class="btn green" id="sel-review" type="button">Review conversion</button>
      </div>
      <details class="more"><summary>Conversion options</summary>
        <p>Conversion runs folder by folder in the Encoder tab: choose this vehicle's folder there, pick H.265 or AV1 and the profile, and keep originals or replace them. Tesla telemetry is copied byte-for-byte into every frame and checked (Quick or Full verification) before anything is replaced. Protected recordings can still be converted; they are only protected from the Recycle Bin and policies.</p>
      </details></div>
      <div class="selrow"><button class="btn" id="sel-all"${shown.length ? '' : ' disabled'}>Select shown (up to 100)</button><button class="btn" id="sel-clear"${sel.length ? '' : ' disabled'}>Clear selection</button></div>`;
    if (!shown.length) {
      html += `<div class="empty">${data.error ? esc(data.error) : data.scanning ? 'Scanning the share…' : 'No recordings match. Try another category or date, or refresh the inventory.'}</div>`;
    } else {
      html += `<div class="recs">${shown.map((r) => recCard(v, r)).join('')}</div>`;
      if (data.total > data.offset + shown.length || data.offset > 0) {
        html += `<div class="form-actions" style="justify-content:center">
          <button class="btn" id="pg-prev"${data.offset ? '' : ' disabled'}>Previous</button>
          <span class="muted" style="align-self:center">${data.offset + 1}–${data.offset + shown.length} of ${data.total}</span>
          <button class="btn" id="pg-next"${data.total > data.offset + shown.length ? '' : ' disabled'}>Next</button></div>`;
      }
    }
    page.innerHTML = html;

    $('f-cat').onchange = (e) => { f.category = e.target.value; f.offset = 0; render(); };
    $('f-date').onchange = (e) => { f.date = e.target.value; f.offset = 0; render(); };
    if ($('f-clear')) $('f-clear').onclick = () => { f.date = ''; f.offset = 0; render(); };
    if ($('pg-prev')) $('pg-prev').onclick = () => { f.offset = Math.max(0, f.offset - 100); render(); };
    if ($('pg-next')) $('pg-next').onclick = () => { f.offset += 100; render(); };
    $('sel-all').onclick = () => { shown.forEach((r) => f.selected.add(r.id)); render(); };
    $('sel-clear').onclick = () => { f.selected.clear(); render(); };
    $('sel-trash').onclick = () => trash(v, [...f.selected]);
    $('sel-protect').onclick = () => protect(v, [...f.selected], true);
    $('sel-unprotect').onclick = () => protect(v, [...f.selected], false);
    $('sel-review').onclick = () => reviewConversion(v);
    page.querySelectorAll('.rec').forEach((el) => {
      const id = el.dataset.id;
      el.querySelector('input[type=checkbox]').onchange = (e) => { if (e.target.checked) f.selected.add(id); else f.selected.delete(id); render(); };
      el.querySelector('[data-play]').onclick = () => play(v, id);
      el.querySelector('[data-files]').onclick = () => { if (f.expanded.has(id)) f.expanded.delete(id); else f.expanded.add(id); render(); };
      el.querySelector('[data-protect]').onclick = (e) => protect(v, [id], e.currentTarget.dataset.protect !== 'on');
      el.querySelector('[data-trash]')?.addEventListener('click', () => trash(v, [id]));
    });
    for (const id of f.expanded) loadFiles(v, id);
  };

  function recCard(v, r) {
    const f = state.footage;
    const chip = r.category === 'Saved' ? 'green' : r.category === 'Sentry' ? 'amber' : '';
    const thumb = (r.thumbRel || r.frontRel)
      ? `<img loading="lazy" alt="" data-fallback="${esc(r.category)}" src="/api/vehicles/${encodeURIComponent(v.id)}/recordings/${encodeURIComponent(r.id)}/thumbnail">`
      : esc(r.category);
    const range = r.start && r.end && r.end !== r.start ? ` – ${esc(r.end.slice(11))}` : '';
    return `<article class="rec${f.selected.has(r.id) ? ' selected' : ''}" data-id="${esc(r.id)}">
      <div class="rec-top">
        <input type="checkbox" aria-label="Select ${esc(r.start)}"${f.selected.has(r.id) ? ' checked' : ''}>
        <div class="thumb">${thumb}</div>
        <div class="rec-info"><span class="when">${esc(r.start || r.day)}${range}</span>
          <span class="meta"><span class="chip ${chip}">${esc(r.category)}</span><span>${plural(r.fileCount, 'file')}</span><span>${bytes(r.bytes)}</span>${r.eventAt ? `<span>event ${esc(r.eventAt.slice(11))}</span>` : ''}${r.cameras.length ? `<span>${plural(r.cameras.length, 'camera')}</span>` : ''}${r.protected ? '<span class="chip green">Protected</span>' : ''}</span>
          <span class="orig">Original capture: ${esc(r.startKey ? `${r.startKey.slice(0, 10)}T${r.startKey.slice(11).replace(/-/g, ':')}` : r.day)} · ${esc(r.folder)}</span></div>
        <div class="rec-actions"><button class="btn" data-play>Play recording</button><button class="btn" data-files>${f.expanded.has(r.id) ? 'Hide files' : 'Show files'}</button></div>
      </div>
      <div class="rec-bottom"><button class="btn${r.protected ? ' green' : ''}" data-protect="${r.protected ? 'on' : 'off'}">${r.protected ? 'Protected · unprotect' : 'Protect recording'}</button>
        ${r.protected ? '' : '<button class="btn ghost" data-trash>Move to trash</button>'}</div>
      ${f.expanded.has(r.id) ? `<ul class="files" id="files-${esc(r.id)}"><li><span>Loading…</span></li></ul>` : ''}
    </article>`;
  }

  async function loadFiles(v, id) {
    const el = document.getElementById(`files-${id}`);
    if (!el) return;
    try {
      const d = await api(`/api/vehicles/${v.id}/recordings/${id}`);
      const ev = d.event ? `<li><span>${esc([humanize(d.event.reason), d.event.city, d.event.street].filter(Boolean).join(' · ') || 'Event')}</span><span></span><span></span></li>` : '';
      el.innerHTML = ev + d.files.map((f) => `<li><span title="${esc(f.rel)}">${esc(f.rel)}</span><span>${bytes(f.size)}</span><a href="/api/media?path=${encodeURIComponent(f.path)}" download>Download</a></li>`).join('');
    } catch (err) {
      el.innerHTML = `<li><span>${esc(err.message)}</span></li>`;
    }
  }

  async function protect(v, ids, on) {
    if (!ids.length) return;
    await api(`/api/vehicles/${v.id}/protect`, { body: { ids, protected: on } }).then(() => toast(on ? 'Protected: policies and Move to trash will skip it.' : 'Protection removed.'), (err) => toast(err.message, true));
    render();
  }

  async function trash(v, ids) {
    if (!ids.length) return;
    const recs = (state.footage.data?.recordings || []).filter((r) => ids.includes(r.id));
    const total = recs.reduce((n, r) => n + r.bytes, 0);
    const ok = await confirmDialog({
      title: `Move ${plural(ids.length, 'recording')} to the Recycle Bin?`,
      body: `<p>${bytes(total)} moves to the Recycle Bin on the same share. Nothing is deleted: restore it any time, or delete it forever from the Recycle Bin.</p>${recs.some((r) => r.protected) ? '<p>Protected recordings are skipped.</p>' : ''}`,
      ok: 'Move to trash'
    });
    if (!ok) return;
    try {
      const out = await api(`/api/vehicles/${v.id}/trash`, { body: { ids } });
      const why = out.skipped.length ? ` ${out.skipped.length} skipped (${[...new Set(out.skipped.map((s) => s.reason))].join(', ')}).` : '';
      toast(`${plural(out.moved.length, 'recording')} moved to the Recycle Bin (${bytes(out.bytes)}).${why}`, out.skipped.length > 0 && !out.moved.length);
      ids.forEach((id) => state.footage.selected.delete(id));
    } catch (err) {
      toast(err.message, true);
    }
    await loadVehicles().catch(() => {});
    render();
  }

  async function play(v, id) {
    try {
      const d = await api(`/api/vehicles/${v.id}/recordings/${id}`);
      // events open their own folder; drives open the clip folder they are in
      openStudio('viewer', { folder: d.folderPath });
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ---------- embedded Studio (Viewer / Encoder) ----------
  const frames = {};
  function studioUrl(kind, extra = {}) {
    const v = current();
    const q = new URLSearchParams({ embed: kind, ...(v ? { root: v.studioRoot || v.root } : {}), ...extra });
    return `/studio/index.html?${q}`;
  }
  function openStudio(kind, extra = {}) {
    pendingFrame[kind] = studioUrl(kind, extra);
    if (location.hash === `#/${kind}`) render();
    else location.hash = `#/${kind}`;
  }
  const pendingFrame = {};
  /** Open the Encoder with this vehicle's footage folder as the source. */
  function reviewConversion(v) {
    const folder = v.studioRoot || v.root;
    const frame = frames.encoder?.querySelector('iframe');
    if (!frame) return openStudio('encoder', { source: folder });
    location.hash = '#/encoder';
    frame.contentWindow?.postMessage({ type: 'use-source', folder }, location.origin);
    return undefined;
  }
  function showFrame(kind) {
    const url = pendingFrame[kind] || frames[kind]?.dataset.src || studioUrl(kind);
    delete pendingFrame[kind];
    if (!frames[kind] || frames[kind].dataset.src !== url) {
      frames[kind]?.remove();
      const wrap = document.createElement('div');
      wrap.className = 'frame-wrap';
      wrap.dataset.src = url;
      wrap.innerHTML = `<iframe title="Sentry Studio ${kind}" src="${esc(url)}" allow="fullscreen; clipboard-write"></iframe>`;
      $('frames').append(wrap);
      frames[kind] = wrap;
    }
    for (const [k, el] of Object.entries(frames)) {
      if (k !== kind) hideFrame(el);
      else if (el.hidden) {
        el.hidden = false;
        el.querySelector('iframe')?.contentWindow?.postMessage({ type: 'shown' }, location.origin);
      }
    }
    fitFrames();
  }
  // A Studio tab that is put away stops playing, so six videos don't keep
  // decoding in the background (battery on phones and tablets).
  function hideFrame(el) {
    if (!el.hidden) el.querySelector('iframe')?.contentWindow?.postMessage({ type: 'pause' }, location.origin);
    el.hidden = true;
  }

  // Studio's viewer needs about 900px; on narrower screens (phones) it is
  // drawn at that width and scaled down to fit, instead of overlapping itself.
  const VIEWER_MIN_WIDTH = 900;
  function fitFrames() {
    const wrap = frames.viewer;
    const iframe = wrap?.querySelector('iframe');
    if (!iframe || wrap.hidden) return;
    const width = wrap.clientWidth;
    if (width && width < VIEWER_MIN_WIDTH) {
      const s = width / VIEWER_MIN_WIDTH;
      Object.assign(iframe.style, { width: `${VIEWER_MIN_WIDTH}px`, height: `${wrap.clientHeight / s}px`, transform: `scale(${s})`, transformOrigin: '0 0' });
    } else {
      Object.assign(iframe.style, { width: '', height: '', transform: '', transformOrigin: '' });
    }
  }
  window.addEventListener('resize', () => fitFrames());
  pages.viewer = () => {
    page.innerHTML = '';
    showFrame('viewer');
  };
  pages.encoder = () => {
    page.innerHTML = '';
    showFrame('encoder');
  };
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.data?.source !== 'sentry-studio') return;
    if (e.data.type === 'showInFolder') {
      state.footage.category = 'all';
      location.hash = '#/footage';
    }
  });

  pages.policies = async () => {
    const v = current();
    let html = head('Your archive workspace', 'Policies') + pills();
    if (!v) {
      page.innerHTML = `${html}<div class="empty">Add a vehicle in Settings first.</div>`;
      return;
    }
    const { policy, preview } = await api(`/api/vehicles/${v.id}/policy`);
    html += `<div class="card"><h2>Retention for ${esc(v.name)}</h2>
      <p>Recordings older than the number of days below are moved to the Recycle Bin once a day. Nothing is ever deleted by a policy, and protected recordings are always skipped. Leave a field empty to keep that category forever.</p>
      <form id="pol" style="margin-top:22px">
        <label class="check" style="margin-bottom:18px"><input type="checkbox" name="enabled"${policy.enabled ? ' checked' : ''}> Run this policy every day</label>
        <div class="keep">${['Recent', 'Sentry', 'Saved', 'Other'].map((c) => `<label class="field">Keep ${c} clips (days)<input class="input" type="number" min="1" max="3650" name="keep-${c}" value="${policy.keepDays[c] ?? ''}" placeholder="forever"></label>`).join('')}</div>
        <div class="form" style="margin-top:16px"><label class="field">Run at (server time)<input class="input" type="time" name="runAt" value="${esc(policy.runAt)}"></label></div>
        <div class="note${preview.recordings ? ' amber' : ''}">${preview.recordings ? `With these settings, the next run moves ${plural(preview.recordings, 'recording')} (${bytes(preview.bytes)}) to the Recycle Bin.` : 'With these settings, nothing would be moved right now.'}
          ${policy.lastRunAt ? `<br>Last run ${when(policy.lastRunAt)}: ${policy.lastResult?.error ? esc(policy.lastResult.error) : `${policy.lastResult?.moved ?? 0} moved, ${policy.lastResult?.skipped ?? 0} skipped`}.` : ''}</div>
        <div class="form-actions"><button class="btn" type="button" id="pol-run">Run now</button><button class="btn solid" type="submit">Save policy</button></div>
      </form></div>`;
    page.innerHTML = html;
    const form = $('pol');
    const read = () => {
      const fd = new FormData(form);
      return { enabled: fd.get('enabled') === 'on', runAt: fd.get('runAt'), keepDays: Object.fromEntries(['Recent', 'Sentry', 'Saved', 'Other'].map((c) => [c, fd.get(`keep-${c}`) || null])) };
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api(`/api/vehicles/${v.id}/policy`, { method: 'PUT', body: read() });
        toast('Policy saved.');
        render();
      } catch (err) {
        toast(err.message, true);
      }
    };
    $('pol-run').onclick = async () => {
      try {
        await api(`/api/vehicles/${v.id}/policy`, { method: 'PUT', body: read() });
        const p = await api(`/api/vehicles/${v.id}/policy`);
        if (!p.preview.recordings) return toast('Nothing to move right now.');
        if (!(await confirmDialog({ title: 'Run the policy now?', body: `<p>${plural(p.preview.recordings, 'recording')} (${bytes(p.preview.bytes)}) will move to the Recycle Bin. You can restore them from there.</p>`, ok: 'Run now' }))) return;
        const out = await api(`/api/vehicles/${v.id}/policy/run`, { body: {} });
        toast(`${plural(out.moved.length, 'recording')} moved to the Recycle Bin.`);
        render();
      } catch (err) {
        toast(err.message, true);
      }
    };
  };

  pages.jobs = async () => {
    const v = current();
    const { jobs } = await api(`/api/jobs${v ? `?vehicle=${encodeURIComponent(v.id)}` : ''}`);
    const running = jobs.filter((j) => j.status === 'running').length;
    setBadge('badge-jobs', running ? String(running) : '', 'busy');
    const chip = (s) => `<span class="chip ${s === 'done' ? 'green' : s === 'failed' ? 'red' : s === 'running' ? 'amber' : ''}">${esc(s)}</span>`;
    page.innerHTML = head('Your archive workspace', 'Jobs') + pills() + `<div class="card">
      ${jobs.length ? `<table class="table"><thead><tr><th>Job</th><th>Status</th><th>Details</th><th>Started</th><th>Took</th></tr></thead><tbody>
        ${jobs.map((j) => `<tr><td><b>${esc(j.title)}</b><br><span class="muted small">${esc(j.type)}</span></td><td>${chip(j.status)}</td><td class="small">${esc(j.detail || '')}</td><td class="small">${when(j.startedAt)}</td>
          <td class="small mono">${j.finishedAt ? `${Math.max(0, Math.round((j.finishedAt - j.startedAt) / 1000))} s` : '…'}</td></tr>`).join('')}</tbody></table>`
        : '<p>No jobs yet. Scans, conversions, Recycle Bin actions and policy runs show up here.</p>'}</div>`;
  };

  pages.bin = async () => {
    const v = current();
    const { items } = await api(`/api/bin${v ? `?vehicle=${encodeURIComponent(v.id)}` : ''}`);
    const total = items.reduce((n, i) => n + i.bytes, 0);
    page.innerHTML = head('Your archive workspace', 'Recycle Bin', items.length ? '<button class="btn danger" id="bin-empty">Empty Recycle Bin</button>' : '') + pills() + `
      <div class="note green" style="margin:0 0 20px">Nothing in the Recycle Bin is deleted automatically. Restore puts recordings back exactly where they were; only "Delete forever" and "Empty Recycle Bin" free the space.</div>
      <div class="card">${items.length ? `<p class="muted" style="margin-bottom:12px">${plural(items.length, 'item')} · ${bytes(total)}</p>
        <table class="table"><thead><tr><th>Recording</th><th>Size</th><th>Moved</th><th>Why</th><th></th></tr></thead><tbody>
        ${items.map((i) => `<tr data-item="${esc(i.id)}"><td><b>${esc(i.label)}</b><br><span class="muted small">${plural(i.files.length, 'file')}${i.files.some((f) => f.conflict) ? ' · some files could not be restored (name taken)' : ''}</span></td>
          <td class="mono small">${bytes(i.bytes)}</td><td class="small">${when(i.trashedAt)}</td><td class="small">${i.reason === 'policy' ? 'Policy' : 'You'}</td>
          <td class="actions"><button class="btn sm" data-restore>Restore</button><button class="btn sm danger" data-delete>Delete forever</button></td></tr>`).join('')}</tbody></table>`
        : '<p>The Recycle Bin is empty.</p>'}</div>`;
    page.querySelectorAll('[data-item]').forEach((row) => {
      const id = row.dataset.item;
      const item = items.find((i) => i.id === id);
      row.querySelector('[data-restore]').onclick = async () => {
        try {
          const out = await api(`/api/bin/${encodeURIComponent(id)}/restore`, { body: {} });
          toast(out.conflicts ? `Restored ${out.restored} file(s); ${out.conflicts} could not be (a file with that name exists).` : 'Restored.', out.conflicts > 0);
        } catch (err) {
          toast(err.message, true);
        }
        await loadVehicles().catch(() => {});
        render();
      };
      row.querySelector('[data-delete]').onclick = async () => {
        if (!(await confirmDialog({ title: 'Delete forever?', body: `<p><b>${esc(item.label)}</b> (${bytes(item.bytes)}) will be permanently deleted from the share. This cannot be undone.</p>`, ok: 'Delete forever', danger: true }))) return;
        try {
          await api(`/api/bin/${encodeURIComponent(id)}/delete`, { body: { confirm: true } });
          toast('Deleted.');
        } catch (err) {
          toast(err.message, true);
        }
        await loadVehicles().catch(() => {});
        render();
      };
    });
    if ($('bin-empty')) {
      $('bin-empty').onclick = async () => {
        if (!(await confirmDialog({ title: 'Empty the Recycle Bin?', body: `<p>${plural(items.length, 'item')} (${bytes(total)}) of ${esc(v ? v.name : 'all vehicles')} will be permanently deleted. This cannot be undone.</p>`, ok: 'Empty Recycle Bin', danger: true }))) return;
        try {
          const out = await api('/api/bin/empty', { body: { confirm: true, vehicle: v?.id || null } });
          toast(`Deleted ${plural(out.deleted, 'item')} (${bytes(out.bytes)}).`, out.failed > 0);
        } catch (err) {
          toast(err.message, true);
        }
        await loadVehicles().catch(() => {});
        render();
      };
    }
  };

  pages.notifications = async () => {
    const { notifications } = await api('/api/notifications');
    page.innerHTML = head('Your archive workspace', 'Notifications') + `<div class="card">
      ${notifications.length ? `<ul class="alerts" style="margin:0">${notifications.map((n) => `<li class="alert-item" style="${n.resolvedAt ? 'opacity:.6' : ''}"><span class="dot ${n.resolvedAt ? '' : n.level === 'critical' ? 'bad' : n.level === 'info' ? 'ok' : 'warn'}"></span>
        <div><b>${esc(n.title)}</b><span>${esc(n.message || '')}</span><br><span class="muted small">${when(n.createdAt)}${n.resolvedAt ? ` · resolved ${when(n.resolvedAt)}` : ''}</span></div>
        ${n.resolvedAt ? '<span></span>' : `<button class="btn sm" data-dismiss="${n.id}">Dismiss</button>`}</li>`).join('')}</ul>` : '<p>No notifications.</p>'}</div>`;
    page.querySelectorAll('[data-dismiss]').forEach((b) => {
      b.onclick = async () => {
        await api(`/api/notifications/${b.dataset.dismiss}/dismiss`, { body: {} }).catch(() => {});
        await loadNotes();
        render();
      };
    });
  };

  pages.settings = async (sub) => {
    const seq = renderSeq;
    const editing = sub?.startsWith('vehicle/') ? sub.slice(8) : sub === 'vehicle-new' ? 'new' : null;
    const [settings, upd, sys, sec] = await Promise.all([api('/api/settings'), api('/api/updates'), api('/api/system').catch(() => null), api('/api/security').catch(() => null)]);
    if (seq !== renderSeq) return; // the user moved on while this loaded
    state.system = sys || state.system;
    const sections = [['vehicles', 'Vehicles'], ['updates', 'Updates'], ['account', 'Account'], sec && ['security', 'Security'], sys && ['system', 'System']].filter(Boolean);
    const show = editing || !sections.some(([k]) => k === sub) ? 'vehicles' : sub;
    let html = head('Your archive workspace', 'Settings');
    html += `<nav class="set-tabs" aria-label="Settings sections">${sections.map(([k, label]) => `<button type="button" data-tab="${k}">${label}</button>`).join('')}</nav>`;
    html += `<div class="card" data-section="vehicles"><div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><h2>Vehicles</h2><a class="btn" href="#/settings/vehicle-new">${icon('plus')} Add vehicle</a></div>
      ${state.vehicles.length ? `<table class="table" style="margin-top:14px"><thead><tr><th>Name</th><th>Footage</th><th>Status</th><th></th></tr></thead><tbody>
      ${state.vehicles.map((v) => `<tr><td><b>${esc(v.name)}</b><br><span class="muted small">${esc(v.timezone)}</span></td>
        <td class="small"><span class="mono">${esc(v.source.type === 'smb' ? v.source.share : v.source.path)}</span>${v.security ? `<br><span class="muted">${esc(v.security)}</span>` : ''}</td>
        <td class="small">${v.share?.healthy ? (v.share.writable === false ? 'Read-only' : 'Connected') : esc(v.share?.lastError || 'Unavailable')}</td>
        <td class="actions"><a class="btn sm" href="#/settings/vehicle/${esc(v.id)}">Edit</a></td></tr>`).join('')}</tbody></table>` : '<p style="margin-top:12px">No vehicles yet.</p>'}
      ${editing ? vehicleForm(editing === 'new' ? null : state.vehicles.find((v) => v.id === editing)) : ''}</div>`;

    html += updatesCard(upd);

    html += `<div class="card" data-section="account"><h2>Account</h2><form id="pw" class="form" style="margin-top:16px">
        <label class="field">Current password<input class="input" type="password" name="current" autocomplete="current-password" required></label>
        <label class="field">New password<input class="input" type="password" name="next" autocomplete="new-password" minlength="8" required></label>
        <div class="full form-actions" style="margin-top:0"><button class="btn solid" type="submit">Change password</button></div></form></div>`;

    if (sec) html += securityCard(sec);

    if (sys) {
      const caps = sys.converter.capabilities || {};
      html += `<div class="card" data-section="system"><h2>System</h2><dl class="kv" style="margin-top:16px">
        <dt>Converter</dt><dd>${sys.converter.ready ? `ready · replace originals ${esc(caps.replacement)} · cleanup ${esc(caps.ownershipCleanup)}` : `not ready (${esc(sys.converter.error || 'starting')})`}</dd>
        <dt>Safe rename helper</dt><dd>${sys.nativeHelper ? 'installed' : 'missing (link + unlink fallback)'}</dd>
        <dt>GPUs</dt><dd>${sys.gpu.gpus.length || sys.gpu.nvidia.length ? [...sys.gpu.nvidia.map((g) => `NVIDIA ${esc(g.name)} (driver ${esc(g.driver)})`), ...sys.gpu.gpus.filter((g) => g.vendor !== 'nvidia').map((g) => `${esc(g.name || g.vendorName)} · ${esc(g.node)}${g.passedThrough ? (g.encodes ? ` · encodes ${Object.entries(g.encodes).filter(([, x]) => x).map(([k]) => k.toUpperCase()).join(', ') || 'nothing'}` : '') : ' · not passed into the container'}`)].join('<br>') : 'none visible (the CPU encoders are used)'}</dd>
        ${sys.gpu.hints.length ? `<dt>GPU hints</dt><dd>${sys.gpu.hints.map(esc).join('<br>')}</dd>` : ''}
        <dt>Data volume free</dt><dd>${bytes(sys.dataFree)}</dd>
        <dt>Server time zone</dt><dd>${esc(sys.timezone)}</dd></dl></div>`;
    }
    page.innerHTML = html;
    wireSettingsTabs(show, editing ? `#/settings/${sub}` : '#/settings', seq);
    wireSettings(editing);
    if (sec) wireSecurity(sec);
  };

  // Phones show one Settings section at a time, picked from the tabs (wider
  // screens hide the tabs and show every section). Switching keeps what was
  // typed and only rewrites the address, so a reload opens the same section.
  // Taps on a page that is being replaced are ignored.
  function wireSettingsTabs(show, vehiclesHash, seq) {
    const pick = (key) => {
      page.querySelectorAll('[data-tab]').forEach((b) => {
        b.classList.toggle('on', b.dataset.tab === key);
        if (b.dataset.tab === key) b.setAttribute('aria-current', 'true');
        else b.removeAttribute('aria-current');
      });
      page.querySelectorAll('[data-section]').forEach((c) => c.classList.toggle('on', c.dataset.section === key));
    };
    page.querySelectorAll('[data-tab]').forEach((b) => {
      b.onclick = () => {
        if (seq !== renderSeq) return;
        pick(b.dataset.tab);
        history.replaceState(null, '', b.dataset.tab === 'vehicles' ? vehiclesHash : `#/settings/${b.dataset.tab}`);
      };
    });
    pick(show);
  }

  function updatesCard(u) {
    const cur = u.current || {};
    const running = `${cur.sha ? `${esc(cur.sha.slice(0, 7))}${u.tag ? ` (${esc(u.tag)})` : ''}` : 'built from source'}${cur.builtAt ? ` · built ${esc(String(cur.builtAt).slice(0, 10))}` : ''}`;
    const how = '<code>docker compose pull &amp;&amp; docker compose up -d</code>';
    if (!u.enabled) {
      return `<div class="card" data-section="updates"><h2>Updates</h2>
        <p>${u.image ? `Checking for updates is turned off (UPDATE_CHECK=off). To update, run ${how} where you set up Sentry Six Manager.` : 'This copy was built from source. To update it, build the image again from the new code.'}</p>
        <dl class="kv" style="margin-top:16px"><dt>Running</dt><dd class="mono">${running}</dd></dl></div>`;
    }
    const l = u.latest;
    const latest = l ? `${l.revision ? `${esc(l.revision.slice(0, 7))} · ` : ''}published ${esc(String(l.created || '').slice(0, 10) || '?')}` : u.error ? esc(u.error) : 'not checked yet';
    return `<div class="card" data-section="updates"><h2>Updates</h2>
      <p>Updates come as a new image. To install one, run ${how} where you set up Sentry Six Manager. Settings, footage and the Recycle Bin stay as they are.</p>
      <dl class="kv" style="margin-top:16px"><dt>Running</dt><dd class="mono">${running}</dd>
        <dt>Newest</dt><dd${l ? ' class="mono"' : ''}>${latest}${u.checkedAt ? ` <span class="muted">(checked ${when(u.checkedAt)})</span>` : ''}</dd></dl>
      ${u.updateAvailable ? '<div class="note green">An update is available.</div>' : ''}
      <div class="form-actions"><button class="btn" id="upd-check" type="button">Check now</button></div></div>`;
  }

  function securityCard(sec) {
    const tls = sec.tls || {};
    const ca = tls.ca;
    const host = (sec.currentHost || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    const covered = !host || (tls.hostnames || []).map((h) => h.toLowerCase()).includes(host.toLowerCase());
    let body = `<dl class="kv" style="margin-top:16px">
      <dt>This connection</dt><dd>${sec.https ? 'HTTPS (encrypted)' : '<b class="bad-text">not encrypted</b>: others on the network could read your password and the footage. Use https:// or a reverse proxy that does HTTPS.'}</dd>
      <dt>Server process</dt><dd>${sec.runningAsRoot ? 'runs as root (not supervised; fine for development, not for the Docker image)' : 'runs as an unprivileged user; only the supervisor can mount shares'}</dd>`;
    if (sec.tlsMode === 'off') {
      body += '<dt>HTTPS</dt><dd>turned off (TLS_MODE=off): only use this behind a reverse proxy that does HTTPS.</dd></dl>';
    } else if (tls.mode === 'own') {
      body += `<dt>Certificate</dt><dd>your own (TLS_CERT_FILE) · ${esc((tls.certificate?.names || []).join(', '))} · valid until ${esc(tls.certificate?.validTo || '?')}</dd>
        <dt>Fingerprint</dt><dd class="mono small">${esc(tls.certificate?.fingerprint || '?')}</dd></dl>`;
    } else if (tls.error) {
      body += `<dt>Certificate</dt><dd>${esc(tls.error)}</dd></dl>`;
    } else {
      body += `<dt>Certificate authority</dt><dd>Sentry Six Manager's own · valid until ${esc(ca?.validTo || '?')}</dd>
        <dt>CA fingerprint (SHA-256)</dt><dd class="mono small" style="word-break:break-all">${esc(ca?.fingerprint || '?')}</dd>
        <dt>Certificate covers</dt><dd>${esc((tls.hostnames || []).join(', '))} · renews by itself before ${esc(tls.certificate?.validTo || '?')}</dd></dl>
        ${covered ? '' : `<div class="note amber">You opened this page as <b>${esc(host)}</b>, which the certificate does not cover yet, so browsers warn even when they trust the CA. <button class="btn sm" type="button" id="sec-add-host" data-host="${esc(host)}">Add ${esc(host)}</button></div>`}
        <p style="margin-top:14px">To stop browser warnings, and so nobody can pose as this server, install the certificate authority on each phone and computer you use: download it, then compare the fingerprint above with the one in the container log (<code>docker logs sentry-six-manager</code>) before trusting it. It can only vouch for local names and private IP addresses.</p>
        <details class="more" style="margin-top:10px"><summary>How to install it</summary>
          <ul class="small" style="margin:10px 0 0 18px;display:grid;gap:6px">
            <li><b>iPhone / iPad:</b> open the download in Safari, then Settings &gt; General &gt; VPN &amp; Device Management to install it, and Settings &gt; General &gt; About &gt; Certificate Trust Settings to turn on full trust.</li>
            <li><b>Android:</b> Settings &gt; Security &gt; Encryption &amp; credentials &gt; Install a certificate &gt; CA certificate.</li>
            <li><b>Windows:</b> open the file &gt; Install Certificate &gt; Local Machine &gt; Trusted Root Certification Authorities.</li>
            <li><b>macOS:</b> open it in Keychain Access (System), then set Trust to Always Trust.</li>
            <li><b>Firefox:</b> Settings &gt; Privacy &amp; Security &gt; Certificates &gt; View Certificates &gt; Authorities &gt; Import.</li>
          </ul></details>
        <form id="sec-hosts" class="form" style="margin-top:16px">
          <label class="field full">Extra names and addresses for the certificate<input class="input" name="hostnames" value="${esc((tls.editable || []).join(', '))}" placeholder="192.168.1.20, nas.local"></label>
          <p class="muted small full">The IP address or name you type in the browser to reach this server. Names from TLS_HOSTNAMES: ${esc((tls.fromEnv || []).join(', ') || 'none')}.</p>
          <div class="full form-actions" style="margin-top:0"><a class="btn" href="/api/security/ca.crt" download>Download certificate authority</a><button class="btn solid" type="submit">Save names</button></div>
        </form>`;
    }
    return `<div class="card" data-section="security"><h2>Security</h2>${body}</div>`;
  }

  function wireSecurity(sec) {
    const save = async (names) => {
      try {
        const out = await api('/api/security/hostnames', { method: 'PUT', body: { hostnames: names } });
        toast(out.caReplaced ? 'Saved. The certificate authority was replaced: install the new one on your devices.' : 'Saved. The certificate now covers those names.');
        render();
      } catch (err) {
        toast(err.message, true);
      }
    };
    const form = $('sec-hosts');
    if (form) {
      form.onsubmit = (e) => {
        e.preventDefault();
        save(String(new FormData(form).get('hostnames') || '').split(/[\s,]+/).filter(Boolean));
      };
    }
    const add = $('sec-add-host');
    if (add) add.onclick = () => save([...(sec.tls?.editable || []), add.dataset.host]);
  }

  function vehicleForm(v) {
    const versions = state.system?.smbVersions || { '3.1.1': 'SMB 3.1.1 (recommended)', '3.02': 'SMB 3.02', '3.0': 'SMB 3.0', 3: 'SMB 3.0 or newer' };
    const s = v?.source || { type: 'smb', version: state.system?.smbDefaultVersion || '3.1.1', encrypt: true };
    return `<form id="veh" class="form" style="margin-top:22px;padding-top:22px;border-top:1px solid var(--border)">
      <h3 class="full">${v ? `Edit ${esc(v.name)}` : 'Add a vehicle'}</h3>
      <label class="field">Name<input class="input" name="name" required value="${esc(v?.name || '')}" placeholder="Daily Driver"></label>
      <label class="field">Time zone<input class="input" name="timezone" value="${esc(v?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone)}" placeholder="America/Chicago"></label>
      <div class="field full">Footage source<div class="seg" id="src-type"><button type="button" data-type="smb" class="${s.type !== 'path' ? 'on' : ''}">SMB share</button><button type="button" data-type="path" class="${s.type === 'path' ? 'on' : ''}">Folder in the container</button></div></div>
      <div class="full form" data-src="smb"${s.type === 'path' ? ' hidden' : ''}>
        <label class="field full">Share<input class="input" name="share" value="${esc(s.share || '')}" placeholder="//192.168.1.50/TeslaCam"></label>
        <label class="field">User name<input class="input" name="username" value="${esc(s.username || '')}" autocomplete="off"></label>
        <label class="field">Password<input class="input" name="password" type="password" placeholder="${s.passwordSet ? 'saved — leave empty to keep' : ''}" autocomplete="new-password"></label>
        <label class="field">Domain (optional)<input class="input" name="domain" value="${esc(s.domain || '')}"></label>
        <label class="field">SMB version<select class="input" name="version">${Object.entries(versions).map(([x, label]) => `<option value="${esc(x)}"${String(s.version || '3.1.1') === x ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
        <label class="field">Port (optional)<input class="input" name="port" inputmode="numeric" value="${esc(s.port || '')}" placeholder="445"></label>
        <label class="check full"><input type="checkbox" name="encrypt"${s.encrypt === false ? '' : ' checked'}> Encrypt the connection (recommended). Without it the connection is still signed, so nobody can change the footage, but others on the network could watch it.</label>
        <p class="muted small full">Only SMB 3 is allowed and every connection is signed, so a man in the middle cannot read or change footage, or pose as your NAS. Files on the share can never run as programs inside the container. Use a dedicated NAS account with access to this share only.</p>
      </div>
      <div class="full" data-src="path"${s.type === 'path' ? '' : ' hidden'}>
        <label class="field">Folder<input class="input" name="path" value="${esc(s.path || '')}" placeholder="/footage/weekend-car"></label>
        <p class="muted small" style="margin-top:8px">A folder you mounted into the container yourself (bind mount or Docker CIFS volume).</p>
      </div>
      <div class="full form-actions">${v ? '<button class="btn danger" type="button" id="veh-del">Remove vehicle</button>' : ''}<a class="btn" href="#/settings">Cancel</a><button class="btn solid" type="submit">${v ? 'Save' : 'Add vehicle'}</button></div>
    </form>`;
  }

  function wireSettings(editing) {
    const veh = $('veh');
    if (veh) {
      let type = veh.querySelector('#src-type .on')?.dataset.type || 'smb';
      veh.querySelectorAll('#src-type button').forEach((b) => {
        b.onclick = () => {
          type = b.dataset.type;
          veh.querySelectorAll('#src-type button').forEach((x) => x.classList.toggle('on', x === b));
          veh.querySelectorAll('[data-src]').forEach((x) => { x.hidden = x.dataset.src !== type; });
        };
      });
      veh.onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(veh);
        const body = { name: fd.get('name'), timezone: fd.get('timezone'), source: type === 'path'
          ? { type: 'path', path: fd.get('path') }
          : { type: 'smb', share: fd.get('share'), username: fd.get('username'), password: fd.get('password') || undefined, domain: fd.get('domain'), version: fd.get('version'), encrypt: fd.get('encrypt') === 'on', port: fd.get('port') || null } };
        // only send the source when it changed, so a rename needs no password
        if (editing !== 'new') {
          const was = state.vehicles.find((x) => x.id === editing)?.source || {};
          const same = type === was.type && (type === 'path'
            ? body.source.path === was.path
            : ['share', 'username', 'domain', 'version'].every((k) => String(body.source[k] ?? '') === String(was[k] ?? ''))
              && body.source.encrypt === (was.encrypt !== false) && String(body.source.port ?? '') === String(was.port ?? '') && !body.source.password);
          if (same) delete body.source;
        }
        try {
          const saved = editing === 'new' ? await api('/api/vehicles', { body }) : await api(`/api/vehicles/${encodeURIComponent(editing)}`, { method: 'PUT', body });
          state.vehicleId = saved.id;
          store.set('vehicle', saved.id);
          toast('Saved. Connecting to the footage…');
          await loadVehicles();
          location.hash = '#/settings';
        } catch (err) {
          toast(err.message, true);
        }
      };
      if ($('veh-del')) {
        $('veh-del').onclick = async () => {
          if (!(await confirmDialog({ title: 'Remove this vehicle?', body: '<p>Sentry Six Manager forgets the vehicle and unmounts its share. No footage is deleted.</p>', ok: 'Remove', danger: true }))) return;
          await api(`/api/vehicles/${encodeURIComponent(editing)}`, { method: 'DELETE' }).catch((err) => toast(err.message, true));
          await loadVehicles();
          location.hash = '#/settings';
        };
      }
    }
    const check = $('upd-check');
    if (check) {
      check.onclick = async () => {
        check.disabled = true;
        try {
          const out = await api('/api/updates/check', { body: {} });
          toast(out.error || (out.updateAvailable ? 'An update is available.' : 'This is the latest version.'), Boolean(out.error));
        } catch (err) {
          toast(err.message, true);
        }
        render();
      };
    }
    $('pw').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api('/api/auth/password', { body: { current: fd.get('current'), next: fd.get('next') } });
        toast('Password changed.');
        e.target.reset();
      } catch (err) {
        toast(err.message, true);
      }
    };
  }

  // Phones show each table row as a stacked block; the cells carry their column name.
  function labelTableCells(root) {
    root.querySelectorAll('table.table').forEach((table) => {
      const names = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
      table.querySelectorAll('tbody tr').forEach((tr) => [...tr.children].forEach((td, i) => { if (names[i]) td.dataset.label = names[i]; }));
    });
  }

  // ---------- routing ----------
  let renderSeq = 0;
  async function render() {
    const seq = ++renderSeq;
    const [route, ...rest] = (location.hash.replace(/^#\/?/, '') || 'overview').split('/');
    state.route = pages[route] ? route : 'overview';
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === state.route));
    const label = document.querySelector(`#nav a[data-route="${state.route}"] span`)?.textContent || '';
    $('crumb').textContent = `Sentry Six Manager${label ? ` / ${label}` : ''}`;
    document.title = `${label || 'Overview'} · Sentry Six Manager`;
    const embedded = state.route === 'viewer' || state.route === 'encoder';
    $('topbar').hidden = embedded;
    // give Studio the room it needs on smaller windows; the sidebar comes back after
    if (embedded && innerWidth < 1200 && !app.classList.contains('collapsed')) app.classList.add('collapsed', 'auto-collapsed');
    if (!embedded && app.classList.contains('auto-collapsed')) app.classList.remove('collapsed', 'auto-collapsed');
    if (!embedded) for (const el of Object.values(frames)) hideFrame(el);
    try {
      await pages[state.route](rest.join('/'));
      labelTableCells(page);
    } catch (err) {
      if (seq === renderSeq) page.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
  }
  window.addEventListener('hashchange', render);

  // ---------- live updates ----------
  function connect() {
    const es = new EventSource('/api/events');
    es.addEventListener('changed', async (e) => {
      const { topics } = JSON.parse(e.data);
      if (topics.includes('vehicles') || topics.includes('inventory') || topics.includes('bin')) await loadVehicles().catch(() => {});
      if (topics.includes('notifications')) await loadNotes().catch(() => {});
      const affects = {
        overview: ['vehicles', 'inventory', 'notifications', 'bin'], footage: ['inventory'], jobs: ['jobs'],
        bin: ['bin'], notifications: ['notifications'], policies: ['inventory']
      }[state.route] || [];
      if (topics.some((t) => affects.includes(t)) && !document.querySelector('dialog[open]') && !document.activeElement?.matches('input, select, textarea')) render();
      if (topics.includes('jobs') && state.route !== 'jobs') {
        api('/api/jobs?limit=50').then(({ jobs }) => {
          const running = jobs.filter((j) => j.status === 'running');
          setBadge('badge-jobs', running.length ? String(running.length) : '', 'busy');
          setBadge('badge-encoder', running.some((j) => j.type === 'conversion') ? '●' : '', 'busy');
        }).catch(() => {});
      }
    });
  }

  (async () => {
    try {
      const s = await api('/api/settings');
      $('reduce-effects').checked = Boolean(s.appearance?.reduceEffects);
      document.documentElement.classList.toggle('reduce-effects', Boolean(s.appearance?.reduceEffects));
      await Promise.all([loadVehicles(), loadNotes()]);
    } catch {
      // shown by render
    }
    render();
    connect();
  })();
})();
