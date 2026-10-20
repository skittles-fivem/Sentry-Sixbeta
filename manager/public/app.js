'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const TYPES = [
    { key: 'RecentClips', label: 'Recent', cls: 'seg-recent' },
    { key: 'SentryClips', label: 'Sentry', cls: 'seg-sentry' },
    { key: 'SavedClips', label: 'Saved', cls: 'seg-saved' },
    { key: 'Other', label: 'Other', cls: 'seg-other' }
  ];
  const STATE_LABELS = {
    encoding: ['Encoding', 'busy'],
    ready: ['Ready', 'ok'],
    idle: ['Up to date', 'ok'],
    paused: ['Paused', 'warn'],
    'waiting-share': ['Waiting for share', 'warn'],
    'no-encoder': ['No encoder', 'bad'],
    detecting: ['Detecting…', 'busy'],
    disabled: ['Disabled', '']
  };

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(`sentry-manager:${key}`);
        return v === null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(`sentry-manager:${key}`, JSON.stringify(value));
      } catch {
        // private mode etc.
      }
    }
  };

  const state = {
    status: null,
    days: [],
    sortAsc: store.get('sortAsc', true),
    selected: new Set(),
    anchor: null,
    history: [],
    logs: [],
    tab: 'history',
    firstLoad: true
  };

  // ---------- formatting ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function fmtBytes(n) {
    if (n === null || n === undefined || !Number.isFinite(n)) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    const digits = i === 0 || v >= 100 ? 0 : v >= 10 ? 1 : 2;
    return `${v.toFixed(digits)} ${units[i]}`;
  }
  const fmtInt = (n) => (Number(n) || 0).toLocaleString();
  function parseDay(day) {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  const todayKey = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const fmtDay = (day, opts = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) => parseDay(day).toLocaleDateString(undefined, opts);
  function ago(ts) {
    if (!ts) return '—';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 10) return 'just now';
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(ts).toLocaleString();
  }
  const plural = (n, word) => `${fmtInt(n)} ${word}${n === 1 ? '' : 's'}`;

  // ---------- api ----------
  async function api(path, body) {
    const opts = body === undefined
      ? {}
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
  }

  function toast(message, bad = false) {
    const el = document.createElement('div');
    el.className = `toast${bad ? ' bad' : ''}`;
    el.textContent = message;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), bad ? 9000 : 5000);
  }

  const icon = (name) => `<svg class="i" aria-hidden="true"><use href="#i-${name}"/></svg>`;

  // ---------- days ----------
  function sortedDays() {
    return state.sortAsc ? state.days : [...state.days].reverse();
  }

  function renderDays() {
    const list = $('days');
    const days = sortedDays();
    $('days-empty').hidden = days.length > 0;
    if (!days.length) {
      const st = state.status;
      $('days-empty-text').textContent = !st ? 'Loading…'
        : !st.share.healthy ? 'The share is not available, so there is nothing to show yet.'
          : st.scan.running ? 'Scanning footage…' : 'No TeslaCam footage found on the share.';
    }
    const maxBytes = Math.max(1, ...days.map((d) => d.bytes));
    const today = todayKey();
    list.innerHTML = days.map((d) => {
      const sel = state.selected.has(d.day);
      const segs = TYPES.map((t) => {
        const b = d.byType[t.key].bytes;
        return b ? `<span class="${t.cls}" style="width:${(b / maxBytes) * 100}%"></span>` : '';
      }).join('');
      const brk = TYPES.filter((t) => d.byType[t.key].files).map((t) =>
        `<span class="k"><span class="sw ${t.cls}"></span>${t.label} ${fmtBytes(d.byType[t.key].bytes)}</span>`).join('');
      const enc = d.encode;
      const encodable = enc.encoded + enc.pending + enc.skipped + enc.failed;
      const doneish = enc.encoded + enc.skipped;
      let encHtml = '<span class="muted">—</span>';
      if (encodable) {
        const pct = Math.round((doneish / encodable) * 100);
        encHtml = enc.pending === 0 && enc.failed === 0
          ? `<span class="done-line" title="All clips handled">${icon('check')}${enc.savedBytes ? `−${fmtBytes(enc.savedBytes)}` : 'done'}</span>`
          : `<span>${fmtInt(doneish)}/${fmtInt(encodable)}${enc.failed ? ` · <span style="color:var(--danger)">${enc.failed} failed</span>` : ''}</span><span class="mini"><span style="width:${pct}%"></span></span>`;
      }
      const doneCls = encodable && enc.pending === 0 && enc.failed === 0 ? ' done' : '';
      return `<li class="day${sel ? ' selected' : ''}${state.anchor === d.day ? ' anchor' : ''}" data-day="${d.day}" tabindex="0"
        aria-label="${esc(fmtDay(d.day))}, ${fmtBytes(d.bytes)}${sel ? ', selected' : ''}">
        <input type="checkbox" ${sel ? 'checked' : ''} aria-label="Select ${esc(d.day)} only" tabindex="-1">
        <div class="d-date"><strong>${esc(fmtDay(d.day))}${d.day === today ? '<span class="today-tag">TODAY</span>' : ''}</strong><span>${d.day}</span></div>
        <div class="d-size"><strong>${fmtBytes(d.bytes)}</strong><div class="bar">${segs}</div></div>
        <div class="d-break">${brk}${d.events ? `<span class="k muted">${plural(d.events, 'event')}</span>` : ''}</div>
        <div class="d-enc${doneCls}">${encHtml}</div>
        <div class="d-act">${enc.pending ? `<button class="icon-btn" type="button" data-act="prioritize" title="Encode this day next" aria-label="Encode ${d.day} next">${icon('bolt')}</button>` : ''}</div>
      </li>`;
    }).join('');

    if (state.firstLoad && days.length) {
      state.firstLoad = false;
      if (state.sortAsc) list.scrollTop = list.scrollHeight;
    }
    renderSelection();
  }

  function selectThrough(day) {
    if (state.anchor === day && state.selected.size) {
      state.selected.clear();
      state.anchor = null;
    } else {
      state.selected = new Set(state.days.filter((d) => d.day <= day).map((d) => d.day));
      state.anchor = day;
    }
    renderDays();
  }

  function toggleOne(day) {
    if (state.selected.has(day)) state.selected.delete(day);
    else state.selected.add(day);
    state.anchor = null;
    renderDays();
  }

  function selectionSummary(types = TYPES.map((t) => t.key)) {
    const days = state.days.filter((d) => state.selected.has(d.day));
    let bytes = 0;
    let files = 0;
    for (const d of days) {
      for (const t of types) {
        bytes += d.byType[t].bytes;
        files += d.byType[t].files;
      }
    }
    return { days, bytes, files };
  }

  function renderSelection() {
    // drop selections for days that no longer exist
    const present = new Set(state.days.map((d) => d.day));
    for (const d of state.selected) if (!present.has(d)) state.selected.delete(d);
    const { days, bytes, files } = selectionSummary();
    $('selbar').hidden = days.length === 0;
    if (!days.length) return;
    $('sel-count').textContent = `${plural(days.length, 'day')} selected`;
    const first = days[0].day;
    const last = days[days.length - 1].day;
    $('sel-detail').textContent = `${first === last ? fmtDay(first) : `${fmtDay(first)} → ${fmtDay(last)}`} · ${fmtBytes(bytes)} · ${plural(files, 'file')}`;
  }

  async function loadDays() {
    try {
      const data = await api('/api/days');
      state.days = data.days;
      renderDays();
    } catch (err) {
      toast(`Could not load days: ${err.message}`, true);
    }
  }

  // ---------- purge ----------
  function openPurge() {
    const { days } = selectionSummary();
    if (!days.length) return;
    const first = days[0].day;
    const last = days[days.length - 1].day;
    $('purge-title').textContent = `Purge ${plural(days.length, 'day')}?`;
    $('purge-range').textContent = first === last ? fmtDay(first) : `${fmtDay(first)} through ${fmtDay(last)}`;
    const fs = $('purge-types');
    fs.querySelectorAll('label').forEach((l) => l.remove());
    for (const t of TYPES) {
      const s = selectionSummary([t.key]);
      const label = document.createElement('label');
      label.innerHTML = `<input type="checkbox" name="type" value="${t.key}" ${s.files ? 'checked' : 'disabled'}>
        <span class="sw ${t.cls}"></span><span>${t.label} clips</span><span class="amt">${s.files ? `${fmtBytes(s.bytes)} · ${plural(s.files, 'file')}` : 'none'}</span>`;
      fs.appendChild(label);
    }
    updatePurgeTotal();
    $('purge-dialog').showModal();
  }

  function purgeTypes() {
    return [...$('purge-types').querySelectorAll('input:checked')].map((i) => i.value);
  }

  function updatePurgeTotal() {
    const s = selectionSummary(purgeTypes());
    $('purge-total').textContent = `${fmtBytes(s.bytes)} · ${plural(s.files, 'file')}`;
    $('btn-confirm-purge').disabled = s.files === 0;
    $('btn-confirm-purge').textContent = s.files ? `Delete ${fmtBytes(s.bytes)}` : 'Delete';
  }

  async function doPurge() {
    const days = [...state.selected].sort();
    const types = purgeTypes();
    $('btn-purge').disabled = true;
    try {
      const r = await api('/api/purge', { days, types });
      toast(`Purged ${plural(r.deletedFiles, 'file')} and freed ${fmtBytes(r.freedBytes)}${r.errors.length ? ` (${r.errors.length} could not be deleted)` : ''}.`, r.errors.length > 0);
      state.selected.clear();
      state.anchor = null;
      await Promise.all([loadDays(), loadHistory()]);
    } catch (err) {
      toast(`Purge failed: ${err.message}`, true);
    } finally {
      $('btn-purge').disabled = false;
    }
  }

  // ---------- status ----------
  function setChip(id, text, cls, title) {
    const chip = $(id);
    chip.className = `chip ${cls || ''}`;
    chip.querySelector('.label').textContent = text;
    if (title) chip.title = title;
  }

  function setBadge(id, text, cls) {
    const el = $(id);
    el.className = `badge ${cls || ''}`;
    el.textContent = text;
  }

  function renderStatus() {
    const st = state.status;
    if (!st) return;
    const { share, encoder, footage, scan } = st;

    $('footage-path').textContent = share.share ? `${share.share} → ${share.path}` : share.path;

    // banner
    const banner = $('banner');
    let msg = null;
    let bad = false;
    if (share.lastError) {
      msg = `<strong>${esc(share.lastError)}</strong>${share.hint ? `<small>${esc(share.hint)}</small>` : ''}`;
      bad = true;
    } else if (share.warning) {
      msg = `<strong>${esc(share.warning)}</strong>`;
    } else if (encoder.state === 'no-encoder') {
      msg = `<strong>No working encoder was found, so automatic encoding is off.</strong><small>${esc((encoder.encoder?.notes || []).join(' '))}</small>`;
      bad = true;
    }
    banner.hidden = !msg;
    if (msg) {
      banner.className = `banner${bad ? ' bad' : ''}`;
      banner.innerHTML = `${icon('warning')}<div>${msg}</div>`;
    }

    // chips
    if (share.healthy) {
      setChip('chip-share', share.writable === false ? 'Share read-only' : share.mode === 'smb' ? 'SMB connected' : `${share.fsType || 'Folder'} mounted`,
        share.writable === false ? 'warn' : 'ok', share.share || share.path);
    } else {
      setChip('chip-share', share.mode === 'smb' ? 'SMB disconnected' : 'Footage unavailable', 'bad', share.lastError || '');
    }
    const sel = encoder.encoder?.selected;
    const [stateText, stateCls] = STATE_LABELS[encoder.state] || [encoder.state, ''];
    setChip('chip-encoder', sel ? `${sel.name}` : stateText, encoder.state === 'encoding' ? 'busy' : sel ? 'ok' : encoder.state === 'detecting' ? 'busy' : 'bad');

    // stats
    $('stat-total').textContent = fmtBytes(footage.bytes);
    $('stat-files').textContent = footage.files ? plural(footage.files, 'file') : (scan.running ? 'scanning…' : '');
    $('stat-days').textContent = fmtInt(footage.days);
    $('stat-range').textContent = footage.oldest ? `${fmtDay(footage.oldest, { month: 'short', day: 'numeric', year: 'numeric' })} → ${fmtDay(footage.newest, { month: 'short', day: 'numeric', year: 'numeric' })}` : '';
    $('stat-saved').textContent = fmtBytes(encoder.totals.originalBytes - encoder.totals.encodedBytes);
    $('stat-encoded').textContent = `${plural(encoder.totals.encoded, 'clip')} encoded`;
    $('stat-free').textContent = fmtBytes(share.freeBytes);
    if (share.totalBytes) {
      const used = 1 - share.freeBytes / share.totalBytes;
      $('stat-capacity').textContent = `of ${fmtBytes(share.totalBytes)} · ${Math.round(used * 100)}% used`;
      const fill = $('meter-capacity');
      fill.style.width = `${Math.round(used * 100)}%`;
      fill.className = `meter-fill${used > 0.95 ? ' bad' : used > 0.85 ? ' warn' : ''}`;
    } else {
      $('stat-capacity').textContent = '';
    }

    // encoding panel
    setBadge('enc-state', stateText, stateCls);
    const encEl = $('enc-encoder');
    if (sel) {
      const tele = sel.supportsSei
        ? '<span class="tele ok">Tesla telemetry (SEI) is kept</span>'
        : '<span class="tele warn">Tesla telemetry (SEI) is dropped by this encoder</span>';
      encEl.innerHTML = `<strong>${esc(sel.name)}</strong><span class="muted small mono">${esc(sel.codec)}${sel.device ? ` · ${esc(sel.device)}` : ''}</span>${tele}`;
    } else {
      encEl.innerHTML = `<span class="muted">${encoder.detecting ? 'Detecting encoders…' : 'No usable encoder.'}</span>`;
    }
    $('jobs').innerHTML = encoder.active.map((j) => `
      <div class="job">
        <div class="job-top"><span>${esc(j.phase)} · ${esc(j.day)}</span><span>${j.phase === 'encoding' ? `${j.percent.toFixed(0)}%${j.speed ? ` · ${esc(j.speed)}` : ''}` : ''}</span></div>
        <div class="job-name" title="${esc(j.rel)}">&lrm;${esc(j.rel)}&lrm;</div>
        <div class="progress"><span style="width:${j.phase === 'encoding' ? j.percent : j.phase === 'probing' ? 2 : 100}%"></span></div>
      </div>`).join('');
    $('enc-queued').textContent = fmtInt(encoder.queued);
    $('enc-done').textContent = fmtInt(encoder.totals.encoded);
    $('enc-skipped').textContent = fmtInt(encoder.totals.skipped);
    $('enc-failed').textContent = fmtInt(encoder.totals.failed);
    const s = encoder.settings;
    $('enc-settings').textContent = `${s.codec.toUpperCase()} · quality ${s.quality} · clips older than ${s.minAgeMinutes} min · ${s.types.join(', ')}`;
    const pauseBtn = $('btn-pause');
    pauseBtn.hidden = !encoder.enabled;
    pauseBtn.innerHTML = encoder.paused ? `${icon('play_arrow')}<span>Resume</span>` : `${icon('pause')}<span>Pause</span>`;
    $('btn-retry').hidden = !encoder.totals.failed;
    $('btn-detect').disabled = encoder.detecting;

    const det = encoder.encoder;
    $('cands').innerHTML = det ? det.candidates.map((c) => `
      <li class="cand ${c.works ? 'ok' : 'no'}">${icon(c.works ? 'check' : 'close')}
        <div><strong>${esc(c.name)}</strong> <span class="mono muted">${esc(c.codec)}${c.device ? ` · ${esc(c.device)}` : ''}</span>
          <small>${c.works ? (c.supportsSei ? 'works · keeps telemetry' : 'works · drops telemetry') : esc(c.error || 'not usable')}</small>
          ${c.hint ? `<small class="hint-line">${esc(c.hint)}</small>` : ''}
        </div>
      </li>`).join('') : '';
    $('enc-notes').innerHTML = det ? det.notes.map((n) => `<li>${esc(n)}</li>`).join('') : '';
    $('enc-ffmpeg').textContent = det?.ffmpeg ? `${det.ffmpeg} · checked ${ago(det.detectedAt)}` : '';

    // share panel
    setBadge('share-state', share.healthy ? (share.writable === false ? 'Read-only' : 'Connected') : 'Unavailable', share.healthy ? (share.writable === false ? 'warn' : 'ok') : 'bad');
    $('share-source').textContent = share.share ? `${share.share}  →  ${share.path}` : share.path;
    const err = $('share-error');
    err.hidden = !share.lastError;
    if (share.lastError) err.innerHTML = `${esc(share.lastError)}${share.hint ? `<small>${esc(share.hint)}</small>` : ''}`;
    $('share-fs').textContent = share.fsType ? `${share.fsType}${share.mode === 'smb' ? ' (by manager)' : ''}` : (share.mounted ? 'mounted' : 'not mounted');
    $('share-write').textContent = share.writable === null ? '—' : share.writable ? (share.renameOverwrite === false ? 'yes (safe-replace mode)' : 'yes') : 'no';
    $('share-checked').textContent = ago(share.checkedAt);
    $('share-scan').textContent = scan.running ? 'scanning…' : ago(scan.lastScanAt);
    $('btn-scan').disabled = scan.running || !share.healthy;
    $('btn-purge').disabled = st.purging || !share.writable;
  }

  // ---------- activity ----------
  async function loadHistory() {
    try {
      const data = await api('/api/history');
      state.history = data.history;
      renderHistory();
    } catch {
      // shown elsewhere
    }
  }

  function renderHistory() {
    const el = $('history');
    if (!state.history.length) {
      el.innerHTML = '<li class="empty-line" style="display:block">Nothing yet. Encodes and purges show up here.</li>';
      return;
    }
    el.innerHTML = state.history.slice(0, 60).map((h) => `
      <li><span class="st ${esc(h.status)}"></span><div class="what">
        <div>${esc(h.status === 'purged' ? 'Purged' : h.status === 'encoded' ? 'Encoded' : h.status === 'skipped' ? 'Kept original' : 'Failed')}${h.message ? ` · ${esc(h.message)}` : ''}</div>
        ${h.rel ? `<span class="p" title="${esc(h.rel)}">${esc(h.rel)}</span>` : ''}
        <time>${ago(h.at)}${h.originalSize && h.encodedSize ? ` · ${fmtBytes(h.originalSize)} → ${fmtBytes(h.encodedSize)}` : ''}</time>
      </div></li>`).join('');
  }

  function renderLogs() {
    $('logs').innerHTML = state.logs.slice(-150).reverse().map((l) => `
      <li><span class="st ${esc(l.level)}"></span><div class="what"><div>${esc(l.message)}</div><time>${new Date(l.at).toLocaleTimeString()} · ${esc(l.scope)}</time></div></li>`).join('');
  }

  // ---------- wiring ----------
  $('days').addEventListener('click', (e) => {
    const li = e.target.closest('li.day');
    if (!li) return;
    const day = li.dataset.day;
    const act = e.target.closest('[data-act]');
    if (act) {
      api('/api/encoding/prioritize', { day }).then((r) => toast(`${plural(r.queued, 'clip')} from ${fmtDay(day)} moved to the front of the queue.`), (err) => toast(err.message, true));
      return;
    }
    if (e.target.matches('input[type=checkbox]')) {
      e.preventDefault();
      toggleOne(day);
      return;
    }
    selectThrough(day);
  });
  $('days').addEventListener('keydown', (e) => {
    const li = e.target.closest('li.day');
    if (!li) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      selectThrough(li.dataset.day);
    } else if (e.key === ' ') {
      e.preventDefault();
      toggleOne(li.dataset.day);
    }
  });

  $('btn-sort').addEventListener('click', () => {
    state.sortAsc = !state.sortAsc;
    store.set('sortAsc', state.sortAsc);
    updateSortUi();
    renderDays();
  });
  function updateSortUi() {
    $('sort-label').textContent = state.sortAsc ? 'Oldest first' : 'Newest first';
    $('btn-latest').querySelector('use').setAttribute('href', state.sortAsc ? '#i-vertical_align_bottom' : '#i-vertical_align_top');
  }
  $('btn-latest').addEventListener('click', () => {
    const items = $('days').querySelectorAll('li.day');
    const target = state.sortAsc ? items[items.length - 1] : items[0];
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      target.focus({ preventScroll: true });
    }
  });
  $('btn-clear').addEventListener('click', () => {
    state.selected.clear();
    state.anchor = null;
    renderDays();
  });
  $('btn-purge').addEventListener('click', openPurge);
  $('purge-types').addEventListener('change', updatePurgeTotal);
  $('purge-dialog').addEventListener('close', () => {
    if ($('purge-dialog').returnValue === 'confirm') doPurge();
  });

  const post = (path, okMsg) => () => api(path, {}).then(() => okMsg && toast(okMsg), (err) => toast(err.message, true));
  $('btn-scan').addEventListener('click', post('/api/scan', 'Rescan started.'));
  $('btn-detect').addEventListener('click', post('/api/encoder/detect', 'Re-detecting encoders…'));
  $('btn-retry').addEventListener('click', post('/api/encoding/retry-failed', 'Failed clips will be retried.'));
  $('btn-reconnect').addEventListener('click', () => {
    $('btn-reconnect').disabled = true;
    api('/api/share/reconnect', {})
      .then((r) => toast(r.share.healthy ? 'Share is connected.' : `Still not connected: ${r.share.lastError || 'unknown error'}`, !r.share.healthy), (err) => toast(err.message, true))
      .finally(() => { $('btn-reconnect').disabled = false; });
  });
  $('btn-pause').addEventListener('click', () => {
    const paused = state.status?.encoder.paused;
    post(paused ? '/api/encoding/resume' : '/api/encoding/pause')();
  });

  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    state.tab = b.dataset.tab;
    document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    $('history').hidden = state.tab !== 'history';
    $('logs').hidden = state.tab !== 'logs';
    if (state.tab === 'logs') renderLogs();
  }));

  function connect() {
    const es = new EventSource('/api/events');
    es.addEventListener('status', (e) => {
      const prev = state.status;
      state.status = JSON.parse(e.data);
      renderStatus();
      if (!prev) loadDays();
      else if (!state.days.length && !state.status.scan.running) renderDays();
    });
    let daysTimer = null;
    es.addEventListener('days', () => {
      clearTimeout(daysTimer);
      daysTimer = setTimeout(() => {
        loadDays();
        loadHistory();
      }, 300);
    });
    es.addEventListener('log', (e) => {
      state.logs.push(JSON.parse(e.data));
      if (state.logs.length > 300) state.logs.splice(0, state.logs.length - 300);
      if (state.tab === 'logs') renderLogs();
    });
    es.onerror = () => setChip('chip-encoder', 'Manager offline', 'bad');
  }

  updateSortUi();
  api('/api/logs').then((d) => { state.logs = d.lines; }).catch(() => {});
  loadHistory();
  connect();
  setInterval(() => state.status && renderStatus(), 30000);
})();
