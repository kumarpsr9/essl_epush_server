(() => {
  'use strict';

  const API_BASE = location.protocol.startsWith('http') ? '' : 'http://localhost:3000';
  const KEY_STORE = 'epush.apiKey';
  const REFRESH_MS = 60_000;

  const $ = (id) => document.getElementById(id);
  const els = {
    main: $('main'), date: $('date'), time: $('time'), headline: $('headline'), subline: $('subline'),
    liveState: $('liveState'), updated: $('updated'), gateList: $('gateList'), chips: $('chips'),
    search: $('search'), rows: $('rows'), rowCount: $('rowCount'), dedup: $('dedup'),
    keyDialog: $('keyDialog'), keyForm: $('keyForm'), apiKey: $('apiKey'), keyError: $('keyError'),
  };

  const state = {
    report: null,      // /api/reports/hostel/devices
    students: [],      // /api/reports/hostel/students
    online: new Map(), // DeviceId -> { online, LastPing }
    device: 'all',
    filter: 'OUT',
    query: '',
    sort: { key: 'lastPunch', dir: 'desc' },
    expanded: new Set(),
    loadedAt: null,
  };

  const STATUS_FILTERS = [
    { id: 'OUT', label: 'Out' },
    { id: 'IN', label: 'In' },
    { id: 'NONE', label: 'No punches' },
    { id: 'ALL', label: 'All' },
  ];

  // ---------- helpers ----------
  const store = {
    get() { try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; } },
    set(v) { try { localStorage.setItem(KEY_STORE, v); } catch { /* private mode */ } },
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hhmm = (dt) => (dt ? dt.slice(11, 16) : '');
  const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const plural = (n, one, many) => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;
  const fmtDate = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
  const shiftDate = (d, days) => {
    const t = new Date(`${d}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + days);
    return t.toISOString().slice(0, 10);
  };
  const isLive = () => els.date.value === todayIST() && !els.time.value;

  // LastPing is stored in UTC by the ePush server.
  function sinceText(utc) {
    if (!utc) return 'never connected';
    const mins = Math.round((Date.now() - Date.parse(`${utc.replace(' ', 'T')}Z`)) / 60000);
    if (mins < 2) return 'seen just now';
    if (mins < 60) return `last seen ${mins} min ago`;
    if (mins < 1440) return `last seen ${Math.round(mins / 60)} h ago`;
    return `last seen ${Math.round(mins / 1440)} days ago`;
  }

  class AuthError extends Error {}

  async function api(path) {
    const res = await fetch(`${API_BASE}${path}`, { headers: { 'x-api-key': store.get() } });
    if (res.status === 401) throw new AuthError('Invalid API key');
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
  }

  // ---------- URL state ----------
  function readUrl() {
    const p = new URLSearchParams(location.search);
    els.date.value = /^\d{4}-\d{2}-\d{2}$/.test(p.get('date') || '') ? p.get('date') : todayIST();
    els.time.value = /^\d{2}:\d{2}$/.test(p.get('time') || '') ? p.get('time') : '';
    state.device = p.get('device') || 'all';
    if (STATUS_FILTERS.some((f) => f.id === p.get('status'))) state.filter = p.get('status');
  }

  function writeUrl() {
    const p = new URLSearchParams();
    if (els.date.value !== todayIST()) p.set('date', els.date.value);
    if (els.time.value) p.set('time', els.time.value);
    if (state.device !== 'all') p.set('device', state.device);
    if (state.filter !== 'OUT') p.set('status', state.filter);
    history.replaceState(null, '', `${location.pathname}${p.toString() ? `?${p}` : ''}`);
  }

  // ---------- loading ----------
  let loadSeq = 0;
  async function load() {
    const seq = ++loadSeq;
    const qs = new URLSearchParams({ date: els.date.value });
    if (els.time.value) qs.set('time', els.time.value);

    els.main.classList.add('loading');
    els.main.setAttribute('aria-busy', 'true');
    try {
      const [report, students, devices] = await Promise.all([
        api(`/api/reports/hostel/devices?${qs}`),
        api(`/api/reports/hostel/students?${qs}`),
        api('/api/devices').catch(() => ({ data: [] })),
      ]);
      if (seq !== loadSeq) return;
      state.report = report;
      state.students = students.data;
      state.online = new Map(devices.data.map((d) => [d.DeviceId, d]));
      state.loadedAt = new Date();
      if (state.device !== 'all' && !report.devices.some((d) => String(d.DeviceId) === state.device)) state.device = 'all';
      render();
    } catch (err) {
      if (seq !== loadSeq) return;
      if (err instanceof AuthError) {
        openKeyDialog(store.get() ? 'That key was not accepted. Check API_KEY in the server .env file.' : '');
        renderMessage('Enter the API key to load the register.');
      } else {
        renderMessage(`Couldn't load the register: ${err.message}. Check that the API server is running, then try again.`, true);
      }
    } finally {
      if (seq === loadSeq) {
        els.main.classList.remove('loading');
        els.main.setAttribute('aria-busy', 'false');
      }
    }
  }

  // ---------- derived data ----------
  const statusOf = (s) => (s.hasPunches ? s.status : 'NONE');

  function scopedStudents() {
    if (state.device === 'all') return state.students;
    return state.students.filter((s) => String(s.lastDeviceId) === state.device);
  }

  function visibleStudents() {
    const q = state.query.trim().toLowerCase();
    const { key, dir } = state.sort;
    const sign = dir === 'asc' ? 1 : -1;
    return scopedStudents()
      .filter((s) => state.filter === 'ALL' || statusOf(s) === state.filter)
      .filter((s) => !q || [s.EmployeeName, s.EmployeeCode, s.UserId].some((v) => v && String(v).toLowerCase().includes(q)))
      .sort((a, b) => {
        const av = a[key] ?? '';
        const bv = b[key] ?? '';
        if (av === bv) return String(a.EmployeeName).localeCompare(String(b.EmployeeName));
        if (av === '') return 1; // empty values always last
        if (bv === '') return -1;
        return (typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv))) * sign;
      });
  }

  // ---------- rendering ----------
  function render() {
    renderSummary();
    renderGates();
    renderChips();
    renderRows();
    els.dedup.textContent = state.report.dedupSeconds;
    writeUrl();
  }

  function renderMessage(text, isError = false) {
    els.headline.textContent = isError ? 'The register is unavailable' : 'Register locked';
    els.subline.textContent = text;
    els.liveState.textContent = '';
    els.updated.textContent = '';
    els.gateList.innerHTML = `<div class="notice ${isError ? 'error' : ''}">${esc(text)}<br>
      <button class="btn" type="button" data-action="${isError ? 'retry' : 'key'}">${isError ? 'Try again' : 'Enter API key'}</button></div>`;
    els.rows.innerHTML = '';
    els.rowCount.textContent = '';
  }

  function renderSummary() {
    const live = isLive();
    const { totals, devices } = state.report;
    const are = live ? 'are' : 'were';
    const when = live ? '' : `${els.time.value ? `At ${els.time.value} on` : 'At the end of'} ${fmtDate(els.date.value)}. `;

    if (state.device === 'all') {
      els.headline.textContent = totals.out === 0
        ? `Every student ${live ? 'is' : 'was'} in the hostel`
        : `${totals.out.toLocaleString('en-IN')} of ${plural(totals.students, 'student', 'students')} ${are} out of the hostel`;
      els.subline.textContent = `${when}${plural(totals.in, 'student', 'students')} counted in, including ${totals.noPunches.toLocaleString('en-IN')} who ${live ? "haven't" : "hadn't"} punched ${live ? 'today' : 'that day'}.`;
    } else {
      const g = devices.find((d) => String(d.DeviceId) === state.device);
      els.headline.textContent = `${plural(g.studentsOut, 'student', 'students')} last seen at ${g.DeviceName} ${g.studentsOut === 1 ? (live ? 'is' : 'was') : are} out`;
      els.subline.textContent = `${when}${plural(g.studentsIn, 'student', 'students')} came back in through this gate. It recorded ${plural(g.outPunches, 'exit', 'exits')} and ${plural(g.inPunches, 'entry', 'entries')}.`;
    }

    els.liveState.className = `live${live ? '' : ' past'}`;
    els.liveState.textContent = live ? 'Live, refreshes every minute' : `Snapshot as of ${state.report.asOf.slice(11, 16)}`;
    els.updated.textContent = `Updated ${state.loadedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
  }

  function splitBar(outN, inN) {
    const total = outN + inN;
    const o = total ? (outN / total) * 100 : 0;
    return `<div class="split" aria-hidden="true">${total ? `<span class="o" style="width:${o}%"></span><span class="i" style="width:${100 - o}%"></span>` : ''}</div>
      <div class="split-legend"><span class="o">${outN} out</span><span class="i">${inN} in</span></div>`;
  }

  function renderGates() {
    const { totals, devices } = state.report;
    const sumPunches = devices.reduce((a, d) => ({ o: a.o + d.outPunches, i: a.i + d.inPunches }), { o: 0, i: 0 });
    const onlineCount = devices.filter((d) => state.online.get(d.DeviceId)?.online).length;

    const allRow = `
      <button type="button" class="gate all" data-device="all" aria-pressed="${state.device === 'all'}">
        <div>
          <div class="gate-name">All gates</div>
          <div class="gate-meta">${onlineCount} of ${devices.length} devices online</div>
        </div>
        <div>${splitBar(totals.out, totals.in)}</div>
        <div class="gate-punches"><b>${sumPunches.o}</b> exits, <b>${sumPunches.i}</b> entries<br>${totals.noPunches} students with no punches</div>
      </button>`;

    const rows = devices.map((d) => {
      const dev = state.online.get(d.DeviceId);
      const on = !!dev?.online;
      return `
      <button type="button" class="gate" data-device="${d.DeviceId}" aria-pressed="${state.device === String(d.DeviceId)}">
        <div>
          <div class="gate-name">${esc(d.DeviceName)}</div>
          <div class="gate-meta"><span class="dot ${on ? 'on' : ''}"></span>${on ? 'Online' : `Offline, ${sinceText(dev?.LastPing)}`}</div>
        </div>
        <div>${splitBar(d.studentsOut, d.studentsIn)}</div>
        <div class="gate-punches"><b>${d.outPunches}</b> exits, <b>${d.inPunches}</b> entries</div>
      </button>`;
    }).join('');

    els.gateList.innerHTML = allRow + rows;
  }

  function renderChips() {
    const scoped = scopedStudents();
    const count = (id) => (id === 'ALL' ? scoped.length : scoped.filter((s) => statusOf(s) === id).length);
    els.chips.innerHTML = STATUS_FILTERS.map((f) => `
      <button type="button" class="chip" data-filter="${f.id}" aria-pressed="${state.filter === f.id}">
        ${f.label} <span class="n">${count(f.id)}</span>
      </button>`).join('');
  }

  function statusPill(s) {
    if (!s.hasPunches) return '<span class="pill none">No punches</span>';
    return `<span class="pill ${s.status}">${s.status === 'OUT' ? 'Out' : 'In'}</span>`;
  }

  function renderRows() {
    const list = visibleStudents();
    document.querySelectorAll('th[data-sort]').forEach((th) => {
      th.setAttribute('aria-sort', th.dataset.sort === state.sort.key ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
    });

    if (!list.length) {
      const msg = {
        OUT: 'No students are out. Everyone who left has punched back in.',
        IN: 'No students are counted in here.',
        NONE: 'Every student has punched at least once.',
        ALL: 'No students match.',
      }[state.filter];
      els.rows.innerHTML = `<tr><td colspan="8" class="empty">${state.query ? `No students match "${esc(state.query)}".` : msg}</td></tr>`;
      els.rowCount.textContent = '';
      return;
    }

    els.rows.innerHTML = list.map((s) => {
      const open = state.expanded.has(s.UserId);
      const id = `d-${esc(s.UserId)}`;
      const main = `
        <tr>
          <td>${s.movements.length ? `<button type="button" class="expand" data-user="${esc(s.UserId)}" aria-expanded="${open}" aria-controls="${id}" aria-label="Show movements for ${esc(s.EmployeeName)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>` : ''}</td>
          <td><div class="name">${esc(s.EmployeeName || 'Unknown user')}</div><div class="code">${esc(s.EmployeeCode || s.UserId)}</div></td>
          <td>${statusPill(s)}</td>
          <td>${hhmm(s.firstOut) || '<span class="muted">–</span>'}</td>
          <td>${hhmm(s.lastIn) || '<span class="muted">–</span>'}</td>
          <td>${hhmm(s.lastPunch) || '<span class="muted">–</span>'}</td>
          <td>${esc(s.lastDeviceName || '') || '<span class="muted">–</span>'}</td>
          <td class="num">${s.punchCount}</td>
        </tr>`;
      if (!open) return main;
      const steps = s.movements.map((m) => `
        <li class="${m.type}"><span class="t">${hhmm(m.time)}</span><span class="k">${m.type === 'OUT' ? 'Went out' : 'Came back'}</span><span class="g">${esc(m.deviceName)}</span></li>`).join('');
      return `${main}
        <tr class="detail" id="${id}"><td colspan="8">
          <ol class="timeline" aria-label="Movements">${steps}</ol>
          ${s.ignoredDuplicates ? `<div class="dupes">${plural(s.ignoredDuplicates, 'repeat scan was', 'repeat scans were')} ignored.</div>` : ''}
        </td></tr>`;
    }).join('');

    els.rowCount.textContent = `Showing ${plural(list.length, 'student', 'students')}`;
  }

  // ---------- CSV ----------
  function exportCsv() {
    if (!state.report) return;
    const cols = [
      ['Roll number', (s) => s.EmployeeCode || s.UserId],
      ['Name', (s) => s.EmployeeName],
      ['Status', (s) => (s.hasPunches ? s.status : 'IN (no punches)')],
      ['Went out', (s) => hhmm(s.firstOut)],
      ['Came back', (s) => hhmm(s.lastIn)],
      ['Last punch', (s) => hhmm(s.lastPunch)],
      ['Last gate', (s) => s.lastDeviceName],
      ['Punches', (s) => s.punchCount],
      ['Movements', (s) => s.movements.map((m) => `${m.type} ${hhmm(m.time)} ${m.deviceName}`).join('; ')],
    ];
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [cols.map(([h]) => cell(h)).join(',')]
      .concat(visibleStudents().map((s) => cols.map(([, f]) => cell(f(s))).join(',')));
    const gate = state.device === 'all' ? 'all-gates'
      : state.report.devices.find((d) => String(d.DeviceId) === state.device).DeviceName.replace(/[^\w-]+/g, '-');
    const name = `hostel-${els.date.value}${els.time.value ? `-${els.time.value.replace(':', '')}` : ''}-${gate}-${state.filter.toLowerCase()}.csv`;
    const url = URL.createObjectURL(new Blob(['﻿', lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- API key dialog ----------
  function openKeyDialog(error = '') {
    els.keyError.textContent = error;
    els.apiKey.value = store.get();
    if (!els.keyDialog.open) els.keyDialog.showModal();
    els.apiKey.focus();
  }

  els.keyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = els.apiKey.value.trim();
    if (!v) { els.keyError.textContent = 'Enter the key to continue.'; return; }
    store.set(v);
    els.keyDialog.close();
    load();
  });
  $('keyCancel').addEventListener('click', () => els.keyDialog.close());

  // ---------- events ----------
  els.gateList.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]');
    if (action) { action.dataset.action === 'retry' ? load() : openKeyDialog(); return; }
    const gate = e.target.closest('.gate');
    if (!gate || !state.report) return;
    state.device = gate.dataset.device;
    state.expanded.clear();
    render();
  });

  els.chips.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.filter = chip.dataset.filter;
    renderChips();
    renderRows();
    writeUrl();
  });

  els.rows.addEventListener('click', (e) => {
    const btn = e.target.closest('.expand');
    if (!btn) return;
    const id = btn.dataset.user;
    state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
    renderRows();
    els.rows.querySelector(`.expand[data-user="${CSS.escape(id)}"]`)?.focus();
  });

  document.querySelector('thead').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const key = th.dataset.sort;
    state.sort = { key, dir: state.sort.key === key && state.sort.dir === 'desc' ? 'asc' : (key === 'EmployeeName' && state.sort.key !== key ? 'asc' : 'desc') };
    renderRows();
  });

  let searchTimer;
  els.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = els.search.value; if (state.report) renderRows(); }, 150);
  });

  const reload = () => { state.expanded.clear(); load(); };
  els.date.addEventListener('change', () => { if (els.date.value) reload(); });
  els.time.addEventListener('change', reload);
  $('prevDay').addEventListener('click', () => { els.date.value = shiftDate(els.date.value, -1); reload(); });
  $('nextDay').addEventListener('click', () => { els.date.value = shiftDate(els.date.value, 1); reload(); });
  $('today').addEventListener('click', () => { els.date.value = todayIST(); els.time.value = ''; reload(); });
  $('refresh').addEventListener('click', load);
  $('settings').addEventListener('click', () => openKeyDialog());
  $('exportCsv').addEventListener('click', exportCsv);

  setInterval(() => { if (isLive() && !document.hidden && !els.keyDialog.open) load(); }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && isLive() && state.loadedAt && Date.now() - state.loadedAt > REFRESH_MS) load();
  });

  readUrl();
  if (store.get()) load(); else { renderMessage('Enter the API key to load the register.'); openKeyDialog(); }
})();
