(() => {
  'use strict';

  const REFRESH_MS = 60_000;

  const $ = (id) => document.getElementById(id);
  const els = {
    main: $('main'), date: $('date'), time: $('time'), dateText: $('dateText'),
    headlineBox: $('headlineBox'), headlineIcon: $('headlineIcon'), headline: $('headline'), subline: $('subline'),
    liveState: $('liveState'), updated: $('updated'), errorBox: $('errorBox'), kpis: $('kpis'),
    gateList: $('gateList'), chips: $('chips'), search: $('search'), rows: $('rows'), rowCount: $('rowCount'), dedup: $('dedup'),
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
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hhmm = (dt) => (dt ? dt.slice(11, 16) : '');
  const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const num = (n) => n.toLocaleString('en-IN');
  const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;
  // dd MMM yyyy, per DESIGN.md
  const fmtDate = (d) => {
    const t = new Date(`${d}T00:00:00`);
    const day = t.toLocaleDateString('en-IN', { weekday: 'long' });
    return `${day}, ${t.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}`;
  };
  const shiftDate = (d, days) => {
    const t = new Date(`${d}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + days);
    return t.toISOString().slice(0, 10);
  };
  const isLive = () => els.date.value === todayIST() && !els.time.value;
  const dash = '<span class="dash" aria-label="none">–</span>';

  // LastPing is stored in UTC by the ePush server.
  function sinceText(utc) {
    if (!utc) return 'never connected';
    const mins = Math.round((Date.now() - Date.parse(`${utc.replace(' ', 'T')}Z`)) / 60000);
    if (mins < 2) return 'seen just now';
    if (mins < 60) return `seen ${mins} min ago`;
    if (mins < 1440) return `seen ${Math.round(mins / 60)} h ago`;
    return `seen ${Math.round(mins / 1440)} days ago`;
  }

  function toLogin() {
    location.replace(`/login.html?next=${encodeURIComponent(location.pathname + location.search)}`);
  }

  class AuthError extends Error {}

  async function api(path, opts = {}) {
    const res = await fetch(path, { credentials: 'same-origin', ...opts });
    if (res.status === 401) throw new AuthError('Session expired');
    if (res.status === 204) return null;
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

    if (!state.report) renderSkeleton();
    els.main.setAttribute('aria-busy', 'true');
    try {
      const [report, students, devices] = await Promise.all([
        api(`/api/reports/hostel/devices?${qs}`),
        api(`/api/reports/hostel/students?${qs}`),
        api('/api/devices').catch((e) => { if (e instanceof AuthError) throw e; return { data: [] }; }),
      ]);
      if (seq !== loadSeq) return;
      state.report = report;
      state.students = students.data;
      state.online = new Map(devices.data.map((d) => [d.DeviceId, d]));
      state.loadedAt = new Date();
      if (state.device !== 'all' && !report.devices.some((d) => String(d.DeviceId) === state.device)) state.device = 'all';
      els.errorBox.innerHTML = '';
      render();
    } catch (err) {
      if (seq !== loadSeq) return;
      if (err instanceof AuthError) { toLogin(); return; }
      renderError(`Couldn't load the register: ${err.message}. Check that the API server is running, then try again.`);
    } finally {
      if (seq === loadSeq) els.main.setAttribute('aria-busy', 'false');
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
    renderKpis();
    renderGates();
    renderChips();
    renderRows();
    els.dedup.textContent = state.report.dedupSeconds;
    writeUrl();
  }

  function renderSkeleton() {
    els.dateText.textContent = fmtDate(els.date.value);
    els.kpis.innerHTML = '<div class="sk sk-kpi"></div>'.repeat(4);
    els.gateList.innerHTML = '<div class="sk sk-row"></div>'.repeat(3);
    els.rows.innerHTML = `<tr><td colspan="8" class="empty-cell">${'<div class="sk" style="margin:10px 0"></div>'.repeat(5)}</td></tr>`;
  }

  function renderError(text) {
    els.errorBox.innerHTML = `
      <div class="alert-x rg-error" role="alert"><i class="bi bi-exclamation-circle" aria-hidden="true"></i>
        <span>${esc(text)}</span>
        <button class="btn-x btn-x--ghost" type="button" data-action="retry">Try again</button>
      </div>`;
    if (!state.report) {
      els.kpis.innerHTML = '';
      els.headlineBox.hidden = true;
      els.gateList.innerHTML = '<div class="empty"><i class="bi bi-wifi-off" aria-hidden="true"></i><h4>Register unavailable</h4><p>Gate data will appear here once the server responds.</p></div>';
      els.rows.innerHTML = '';
      els.rowCount.textContent = '';
    }
  }

  function renderSummary() {
    const live = isLive();
    const { totals, devices } = state.report;
    const are = live ? 'are' : 'were';
    const when = live ? '' : `${els.time.value ? `At ${els.time.value} on` : 'At the end of'} ${fmtDate(els.date.value)}. `;
    let outN;

    if (state.device === 'all') {
      outN = totals.out;
      els.headline.textContent = totals.out === 0
        ? `Every student ${live ? 'is' : 'was'} in the hostel`
        : `${num(totals.out)} of ${plural(totals.students, 'student', 'students')} ${are} out of the hostel`;
      els.subline.textContent = `${when}${plural(totals.in, 'student', 'students')} counted in, including ${num(totals.noPunches)} who ${live ? "haven't" : "hadn't"} punched ${live ? 'today' : 'that day'}.`;
    } else {
      const g = devices.find((d) => String(d.DeviceId) === state.device);
      outN = g.studentsOut;
      els.headline.textContent = `${plural(g.studentsOut, 'student', 'students')} last seen at ${g.DeviceName} ${g.studentsOut === 1 ? (live ? 'is' : 'was') : are} out`;
      els.subline.textContent = `${when}${plural(g.studentsIn, 'student', 'students')} came back in through this gate. It recorded ${plural(g.outPunches, 'exit', 'exits')} and ${plural(g.inPunches, 'entry', 'entries')}.`;
    }
    els.headlineBox.hidden = false;
    els.headlineBox.className = `attn ${outN ? 'attn--warn' : 'attn--good'}`;
    els.headlineIcon.innerHTML = `<i class="bi ${outN ? 'bi-exclamation-triangle' : 'bi-check-circle'}"></i>`;

    els.dateText.textContent = fmtDate(els.date.value);
    els.liveState.innerHTML = live
      ? '<span class="chip chip--good"><i class="bi bi-broadcast" aria-hidden="true"></i> Live · refreshes every minute</span>'
      : `<span class="chip chip--muted"><i class="bi bi-clock-history" aria-hidden="true"></i> Snapshot as of ${esc(state.report.asOf.slice(11, 16))}</span>`;
    els.updated.textContent = `Updated ${state.loadedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
  }

  function renderKpis() {
    const scoped = scopedStudents();
    const total = scoped.length;
    const count = (id) => scoped.filter((s) => statusOf(s) === id).length;
    const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
    const devices = state.report.devices;
    const onlineCount = devices.filter((d) => state.online.get(d.DeviceId)?.online).length;

    const tile = (filter, mod, icon, label, n, note) => `
      <button type="button" class="kpi ${mod}" data-filter="${filter}" aria-pressed="${state.filter === filter}">
        <span class="kpi-top"><span class="kpi-icon"><i class="bi ${icon}" aria-hidden="true"></i></span><span class="kpi-label">${label}</span></span>
        <span class="kpi-value">${num(n)}</span>
        <span class="kpi-note">${note}</span>
        <span class="kpi-bar" aria-hidden="true"><span style="width:${pct(n)}%"></span></span>
      </button>`;

    els.kpis.innerHTML = [
      tile('OUT', 'kpi--warn', 'bi-box-arrow-right', 'Out of hostel', count('OUT'), `${pct(count('OUT'))}% of ${plural(total, 'student', 'students')}`),
      tile('IN', 'kpi--good', 'bi-box-arrow-in-left', 'Came back in', count('IN'), `${pct(count('IN'))}% punched back in`),
      tile('NONE', '', 'bi-dash-circle', 'No punches', count('NONE'), `${pct(count('NONE'))}% counted in, no scans`),
      `<div class="kpi kpi--teal">
        <span class="kpi-top"><span class="kpi-icon"><i class="bi bi-hdd-network" aria-hidden="true"></i></span><span class="kpi-label">Gates online</span></span>
        <span class="kpi-value">${onlineCount} <small style="font-size:15px;color:var(--muted)">of ${devices.length}</small></span>
        <span class="kpi-note">${onlineCount === devices.length ? 'All gate devices connected' : `${devices.length - onlineCount} offline`}</span>
        <span class="kpi-bar" aria-hidden="true"><span style="width:${devices.length ? (onlineCount / devices.length) * 100 : 0}%"></span></span>
      </div>`,
    ].join('');
  }

  function splitBar(outN, inN) {
    const total = outN + inN;
    const o = total ? (outN / total) * 100 : 0;
    return `<div class="split" aria-hidden="true">${total ? `<span class="o" style="width:${o}%"></span><span class="i" style="width:${100 - o}%"></span>` : ''}</div>
      <div class="split-legend"><span class="o">${num(outN)} out</span><span class="i">${num(inN)} in</span></div>`;
  }

  function renderGates() {
    const { totals, devices } = state.report;
    const sumPunches = devices.reduce((a, d) => ({ o: a.o + d.outPunches, i: a.i + d.inPunches }), { o: 0, i: 0 });
    const onlineCount = devices.filter((d) => state.online.get(d.DeviceId)?.online).length;

    const allRow = `
      <button type="button" class="rg-gate" data-device="all" aria-pressed="${state.device === 'all'}">
        <span class="rg-gate-name"><i class="bi bi-grid" aria-hidden="true"></i><span><b>All gates</b>
          <span class="chip chip--muted">${onlineCount} of ${devices.length} online</span></span></span>
        <div>${splitBar(totals.out, totals.in)}</div>
        <div class="rg-gate-punches"><b>${num(sumPunches.o)}</b> exits, <b>${num(sumPunches.i)}</b> entries<br>${plural(totals.noPunches, 'student', 'students')} with no punches</div>
      </button>`;

    const rows = devices.map((d) => {
      const dev = state.online.get(d.DeviceId);
      const on = !!dev?.online;
      const status = on
        ? '<span class="chip chip--good"><i class="bi bi-check-circle" aria-hidden="true"></i> Online</span>'
        : `<span class="chip chip--bad"><i class="bi bi-x-circle" aria-hidden="true"></i> Offline, ${esc(sinceText(dev?.LastPing))}</span>`;
      return `
      <button type="button" class="rg-gate" data-device="${d.DeviceId}" aria-pressed="${state.device === String(d.DeviceId)}">
        <span class="rg-gate-name"><i class="bi bi-door-open" aria-hidden="true"></i><span><b>${esc(d.DeviceName)}</b>${status}</span></span>
        <div>${splitBar(d.studentsOut, d.studentsIn)}</div>
        <div class="rg-gate-punches"><b>${num(d.outPunches)}</b> exits, <b>${num(d.inPunches)}</b> entries</div>
      </button>`;
    }).join('');

    els.gateList.innerHTML = allRow + rows;
  }

  function renderChips() {
    const scoped = scopedStudents();
    const count = (id) => (id === 'ALL' ? scoped.length : scoped.filter((s) => statusOf(s) === id).length);
    els.chips.innerHTML = STATUS_FILTERS.map((f) => `
      <button type="button" role="tab" data-filter="${f.id}" aria-selected="${state.filter === f.id}">
        ${f.label} <span class="n">${num(count(f.id))}</span>
      </button>`).join('');
    els.kpis.querySelectorAll('.kpi[data-filter]').forEach((k) => k.setAttribute('aria-pressed', String(k.dataset.filter === state.filter)));
  }

  function statusChip(s) {
    if (!s.hasPunches) return '<span class="chip chip--muted"><i class="bi bi-dash-circle" aria-hidden="true"></i> No punches</span>';
    return s.status === 'OUT'
      ? '<span class="chip chip--warn"><i class="bi bi-box-arrow-right" aria-hidden="true"></i> Out</span>'
      : '<span class="chip chip--good"><i class="bi bi-check-circle" aria-hidden="true"></i> In</span>';
  }

  function renderRows() {
    const list = visibleStudents();
    document.querySelectorAll('th[data-sort]').forEach((th) => {
      th.setAttribute('aria-sort', th.dataset.sort === state.sort.key ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
    });

    if (!list.length) {
      const [icon, title, msg] = state.query
        ? ['bi-search', 'No matches', `No students match "${esc(state.query)}". Check the spelling or roll number.`]
        : {
          OUT: ['bi-house-check', 'Nobody is out', 'Everyone who left has punched back in.'],
          IN: ['bi-person-dash', 'No one counted in here', 'No student has punched back in at this gate.'],
          NONE: ['bi-check2-all', 'Everyone has punched', 'Every student has at least one punch today.'],
          ALL: ['bi-people', 'No students', 'No students are registered on these gates.'],
        }[state.filter];
      els.rows.innerHTML = `<tr class="empty-row"><td colspan="8" class="empty-cell"><div class="empty"><i class="bi ${icon}" aria-hidden="true"></i><h4>${title}</h4><p>${msg}</p></div></td></tr>`;
      els.rowCount.textContent = '';
      return;
    }

    els.rows.innerHTML = list.map((s) => {
      const open = state.expanded.has(s.UserId);
      const id = `d-${esc(s.UserId)}`;
      const name = esc(s.EmployeeName || 'Unknown user');
      const main = `
        <tr class="${open ? 'is-open' : ''}">
          <td class="c-expand">${s.movements.length ? `<button type="button" class="expand" data-user="${esc(s.UserId)}" aria-expanded="${open}" aria-controls="${id}" aria-label="Show movements for ${name}" title="Show movements"><i class="bi bi-chevron-right" aria-hidden="true"></i><span class="lbl">${open ? 'Hide' : 'Show'} ${plural(s.movements.length, 'movement', 'movements')}</span></button>` : ''}</td>
          <td class="c-student"><div class="rg-name">${name}</div><div class="rg-code">${esc(s.EmployeeCode || s.UserId)}</div></td>
          <td class="c-status" data-label="Status">${statusChip(s)}</td>
          <td data-label="Went out">${hhmm(s.firstOut) ? `<span class="rg-time">${hhmm(s.firstOut)}</span>` : dash}</td>
          <td data-label="Came back">${hhmm(s.lastIn) ? `<span class="rg-time">${hhmm(s.lastIn)}</span>` : dash}</td>
          <td data-label="Last punch">${hhmm(s.lastPunch) ? `<span class="rg-time">${hhmm(s.lastPunch)}</span>` : dash}</td>
          <td data-label="Last gate">${esc(s.lastDeviceName || '') || dash}</td>
          <td class="num" data-label="Punches">${s.punchCount}</td>
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

  // ---------- session ----------
  async function loadUser() {
    const { user } = await api('/auth/me');
    $('userName').textContent = user.name;
    $('userRole').textContent = user.role;
    $('userAvatar').textContent = user.name.slice(0, 2);
    $('userBox').hidden = false;
  }

  $('logout').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    location.replace('/login.html');
  });

  // ---------- events ----------
  const setFilter = (f) => {
    state.filter = f;
    renderChips();
    renderRows();
    writeUrl();
  };

  els.errorBox.addEventListener('click', (e) => { if (e.target.closest('[data-action="retry"]')) load(); });

  els.gateList.addEventListener('click', (e) => {
    const gate = e.target.closest('.rg-gate');
    if (!gate || !state.report) return;
    state.device = gate.dataset.device;
    state.expanded.clear();
    render();
  });

  els.kpis.addEventListener('click', (e) => {
    const k = e.target.closest('.kpi[data-filter]');
    if (k) setFilter(k.dataset.filter);
  });

  els.chips.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-filter]');
    if (b) setFilter(b.dataset.filter);
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
  $('exportCsv').addEventListener('click', exportCsv);

  setInterval(() => { if (isLive() && !document.hidden) load(); }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && isLive() && state.loadedAt && Date.now() - state.loadedAt > REFRESH_MS) load();
  });

  readUrl();
  renderSkeleton();
  loadUser()
    .then(load)
    .catch((err) => (err instanceof AuthError ? toLogin() : renderError(`Couldn't reach the server: ${err.message}.`)));
})();
