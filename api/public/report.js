(() => {
  'use strict';

  const REFRESH_MS = 60_000;

  const $ = (id) => document.getElementById(id);
  const els = {
    main: $('main'), date: $('date'), time: $('time'), dateText: $('dateText'),
    headlineBox: $('headlineBox'), headlineAction: $('headlineAction'), headlineIcon: $('headlineIcon'), headline: $('headline'), subline: $('subline'),
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
    issuedNotLeft: null, // open outpasses the student hasn't used yet (live view only)
    user: null,        // from AppNav: wardens carry the DeviceIds they may see
  };

  const STATUS_FILTERS = [
    { id: 'OUT', label: 'Out' },
    { id: 'PASS', label: 'On outpass' },
    { id: 'IN', label: 'In' },
    { id: 'NONE', label: 'No punches' },
    { id: 'ALL', label: 'All' },
  ];
  // Reached from a KPI card or the banner; shown as a tab only while selected.
  const EXTRA_FILTERS = [
    { id: 'NOPASS', label: 'Out, no outpass', after: 'OUT' },
    { id: 'INSIDE', label: 'In hostel', after: 'IN' },
  ];
  const ALL_FILTERS = [...STATUS_FILTERS, ...EXTRA_FILTERS];

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
  const COLS = 8; // columns in the students table
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
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
    location.replace(`/?next=${encodeURIComponent(location.pathname + location.search)}`);
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
    if (ALL_FILTERS.some((f) => f.id === p.get('status'))) state.filter = p.get('status');
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
      const optional = (p) => p.catch((e) => { if (e instanceof AuthError) throw e; return null; });
      const [report, students, devices, passes] = await Promise.all([
        api(`/api/reports/hostel/devices?${qs}`),
        api(`/api/reports/hostel/students?${qs}`),
        optional(api('/api/devices')).then((d) => d || { data: [] }),
        isLive() ? optional(api('/api/outpasses')) : null,
      ]);
      if (seq !== loadSeq) return;
      state.issuedNotLeft = passes ? passes.data.filter((p) => p.state === 'issued').length : null;
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
  // Students away overnight on an outpass are OUT even without punches today.
  const statusOf = (s) => (s.hasPunches || s.awayOvernight ? s.status : 'NONE');
  const noPass = (s) => statusOf(s) === 'OUT' && !s.outpass;
  const onPass = (s) => statusOf(s) === 'OUT' && !!s.outpass;
  const matches = (s, filter) => ({
    ALL: true,
    NOPASS: noPass(s),
    PASS: onPass(s),
    INSIDE: statusOf(s) !== 'OUT',
  })[filter] ?? statusOf(s) === filter;

  function scopedStudents() {
    if (state.device === 'all') return state.students;
    return state.students.filter((s) => String(s.lastDeviceId) === state.device);
  }

  function visibleStudents() {
    const q = state.query.trim().toLowerCase();
    const { key, dir } = state.sort;
    const sign = dir === 'asc' ? 1 : -1;
    return scopedStudents()
      .filter((s) => matches(s, state.filter))
      .filter((s) => !q || [s.EmployeeName, s.EmployeeCode, s.UserId, s.SUC, s.Campus, s.Block, s.RoomNo, s.ContactNo].some((v) => v && String(v).toLowerCase().includes(q)))
      .sort((a, b) => {
        const av = a[key] ?? '';
        const bv = b[key] ?? '';
        if (av === bv) return collator.compare(String(a.EmployeeName), String(b.EmployeeName));
        if (av === '') return 1; // empty values always last
        if (bv === '') return -1;
        return (typeof av === 'number' ? av - bv : collator.compare(String(av), String(bv))) * sign;
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
    els.rows.innerHTML = `<tr><td colspan="${COLS}" class="empty-cell">${'<div class="sk" style="margin:10px 0"></div>'.repeat(5)}</td></tr>`;
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
    const { devices } = state.report;
    const are = live ? 'are' : 'were';
    const when = live ? '' : `${els.time.value ? `At ${els.time.value} on` : 'At the end of'} ${fmtDate(els.date.value)}. `;
    let outN;
    let noPassN = 0;

    if (state.device === 'all') {
      // Counted from the same rows as the KPI cards so the two always agree.
      const rows = state.students;
      const n = (f) => rows.filter((s) => matches(s, f)).length;
      const out = n('OUT');
      const pass = n('PASS');
      const overdue = rows.filter((s) => onPass(s) && s.outpass.overdue).length;
      const noPunch = n('NONE');
      outN = out;
      noPassN = n('NOPASS');
      const isWas = (k) => (k === 1 ? (live ? 'is' : 'was') : are);
      els.headline.textContent = out === 0
        ? `Every student ${live ? 'is' : 'was'} in the hostel`
        : noPassN
          ? `${plural(noPassN, 'student', 'students')} ${isWas(noPassN)} out without an outpass`
          : `${plural(out, 'student', 'students')} ${isWas(out)} out, all on an outpass`;
      const passPart = out ? ` ${num(pass)} on an outpass${overdue ? ` (${num(overdue)} overdue)` : ''}.` : '';
      const noPunchPart = noPunch
        ? `, including ${num(noPunch)} who ${noPunch === 1 ? (live ? "hasn't" : "hadn't") : (live ? "haven't" : "hadn't")} punched ${live ? 'today' : 'that day'}` : '';
      els.subline.textContent = `${when}${num(out)} out in total.${passPart} ${plural(n('INSIDE'), 'student', 'students')} inside${noPunchPart}.`;
    } else {
      const g = devices.find((d) => String(d.DeviceId) === state.device);
      outN = g.studentsOut;
      els.headline.textContent = `${plural(g.studentsOut, 'student', 'students')} last seen at ${g.DeviceName} ${g.studentsOut === 1 ? (live ? 'is' : 'was') : are} out`;
      els.subline.textContent = `${when}${plural(g.studentsIn, 'student', 'students')} came back in through this gate. It recorded ${plural(g.outPunches, 'exit', 'exits')} and ${plural(g.inPunches, 'entry', 'entries')}.`;
    }
    els.headlineBox.hidden = false;
    els.headlineBox.className = `attn ${noPassN ? 'attn--danger' : outN ? 'attn--warn' : 'attn--good'}`;
    els.headlineIcon.innerHTML = `<i class="bi ${noPassN ? 'bi-exclamation-octagon' : outN ? 'bi-exclamation-triangle' : 'bi-check-circle'}"></i>`;
    els.headlineAction.hidden = !noPassN || state.filter === 'NOPASS';

    els.dateText.textContent = fmtDate(els.date.value);
    els.liveState.innerHTML = live
      ? '<span class="chip chip--good"><i class="bi bi-broadcast" aria-hidden="true"></i> Live · refreshes every minute</span>'
      : `<span class="chip chip--muted"><i class="bi bi-clock-history" aria-hidden="true"></i> Snapshot as of ${esc(state.report.asOf.slice(11, 16))}</span>`;
    els.updated.textContent = `Updated ${state.loadedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
  }

  // Four cards: who is out, who is out on a pass (and late), who is inside, gate health.
  function renderKpis() {
    const scoped = scopedStudents();
    const total = scoped.length;
    const count = (id) => scoped.filter((s) => matches(s, id)).length;
    const pct = (n, of = total) => (of ? Math.round((n / of) * 100) : 0);
    const devices = state.report.devices;
    const onlineCount = devices.filter((d) => state.online.get(d.DeviceId)?.online).length;
    const live = isLive();

    const out = count('OUT');
    const passN = count('PASS');
    const noPassN = count('NOPASS');
    const overdue = scoped.filter((s) => onPass(s) && s.outpass.overdue).length;
    const inside = count('INSIDE');
    const noPunch = count('NONE');

    const tile = (filter, mod, icon, label, value, note, bar) => `
      <button type="button" class="kpi ${mod}" data-filter="${filter}" aria-pressed="${state.filter === filter}">
        <span class="kpi-top"><span class="kpi-icon"><i class="bi ${icon}" aria-hidden="true"></i></span><span class="kpi-label">${label}</span></span>
        <span class="kpi-value">${value}</span>
        <span class="kpi-note">${note}</span>
        <span class="kpi-bar" aria-hidden="true"><span style="width:${bar}%"></span></span>
      </button>`;

    const passNote = [
      overdue ? `<b class="kpi-alert">${num(overdue)} overdue</b>` : 'None overdue',
      state.issuedNotLeft ? `${num(state.issuedNotLeft)} issued, not left yet` : '',
    ].filter(Boolean).join(' · ');

    els.kpis.innerHTML = [
      tile('OUT', 'kpi--warn', 'bi-box-arrow-right', 'Out of hostel', num(out),
        out ? `${num(passN)} on outpass${noPassN ? `, ${num(noPassN)} without` : ''}` : `Nobody ${live ? 'is' : 'was'} out`, pct(out)),
      tile('PASS', overdue ? 'kpi--bad' : 'kpi--violet', overdue ? 'bi-alarm' : 'bi-ticket-perforated', 'On outpass', num(passN),
        passNote, pct(overdue, passN) || (passN ? 100 : 0)),
      tile('INSIDE', 'kpi--good', 'bi-house-check', 'In hostel', num(inside),
        noPunch ? `${num(noPunch)} ${live ? (noPunch === 1 ? "hasn't" : "haven't") : "hadn't"} punched ${live ? 'today' : 'that day'}` : 'Everyone punched at least once', pct(inside)),
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
        <span class="rg-gate-name"><i class="bi bi-grid" aria-hidden="true"></i><span><b>${state.user?.isAdmin === false ? 'All your gates' : 'All gates'}</b>
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
    const count = (id) => scoped.filter((s) => matches(s, id)).length;
    const tabs = [...STATUS_FILTERS];
    const extra = EXTRA_FILTERS.find((f) => f.id === state.filter);
    if (extra) tabs.splice(tabs.findIndex((f) => f.id === extra.after) + 1, 0, extra);
    els.chips.innerHTML = tabs.map((f) => `
      <button type="button" role="tab" data-filter="${f.id}" aria-selected="${state.filter === f.id}">
        ${f.label} <span class="n">${num(count(f.id))}</span>
      </button>`).join('');
    els.kpis.querySelectorAll('.kpi[data-filter]').forEach((k) => k.setAttribute('aria-pressed', String(k.dataset.filter === state.filter)));
  }

  function statusChip(s) {
    const st = statusOf(s);
    if (st === 'NONE') return '<span class="chip chip--muted"><i class="bi bi-dash-circle" aria-hidden="true"></i> No punches</span>';
    if (st === 'IN') return '<span class="chip chip--good"><i class="bi bi-check-circle" aria-hidden="true"></i> In</span>';
    const p = s.outpass;
    if (!p) return '<span class="chip chip--warn"><i class="bi bi-box-arrow-right" aria-hidden="true"></i> Out</span>';
    const label = p.overdue ? 'Overdue' : s.awayOvernight && !s.hasPunches ? 'Away on leave' : 'Out on outpass';
    return `<span class="chip ${p.overdue ? 'chip--bad' : 'chip--warn'}"><i class="bi ${p.overdue ? 'bi-alarm' : 'bi-ticket-perforated'}" aria-hidden="true"></i> ${label}</span>
      <a class="rg-pass" href="/outpasses.html" title="Open outpasses">${esc(p.passNo)} · back by ${esc(p.returnBy.slice(0, 10) === els.date.value ? p.returnBy.slice(11, 16) : fmtShort(p.returnBy))}</a>`;
  }
  const fmtShort = (dt) => `${new Date(`${dt.slice(0, 10)}T12:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} ${dt.slice(11, 16)}`;

  // Roll number, then whichever of campus / block / room / bed / mobile are filled in.
  function metaLine(s) {
    const parts = [
      `<span>${esc(s.EmployeeCode || s.UserId)}</span>`,
      s.SUC && `<span title="Student Unique Code">SUC ${esc(s.SUC)}</span>`,
      s.Campus && `<span title="Campus">${esc(s.Campus)}</span>`,
      s.Block && `<span title="Block">${esc(s.Block)}</span>`,
      s.RoomNo && `<span>Room ${esc(s.RoomNo)}</span>`,
      s.BedNo && `<span>Bed ${esc(s.BedNo)}</span>`,
      s.ContactNo && `<a class="rg-tel" href="tel:${esc(String(s.ContactNo).replace(/[^\d+]/g, ''))}" title="Call ${esc(s.EmployeeName || '')}"><i class="bi bi-telephone" aria-hidden="true"></i> ${esc(s.ContactNo)}</a>`,
    ];
    return `<div class="rg-meta">${parts.filter(Boolean).join('')}</div>`;
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
          NOPASS: ['bi-shield-check', 'Everyone out has an outpass', 'No student is out without a pass.'],
          PASS: ['bi-ticket-perforated', 'Nobody is out on an outpass', 'Students out on a pass show here, with their return time.'],
          INSIDE: ['bi-door-open', 'Nobody is inside', 'Every student on these gates is out.'],
          NONE: ['bi-check2-all', 'Everyone has punched', 'Every student has at least one punch today.'],
          ALL: ['bi-people', 'No students', 'No students are registered on these gates.'],
        }[state.filter];
      els.rows.innerHTML = `<tr class="empty-row"><td colspan="${COLS}" class="empty-cell"><div class="empty"><i class="bi ${icon}" aria-hidden="true"></i><h4>${title}</h4><p>${msg}</p></div></td></tr>`;
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
          <td class="c-student"><div class="rg-name">${name}</div>${metaLine(s)}</td>
          <td class="c-status" data-label="Status">${statusChip(s)}</td>
          <td data-label="Went out">${hhmm(s.firstOut) ? `<span class="rg-time">${hhmm(s.firstOut)}</span>` : dash}</td>
          <td data-label="Came back">${hhmm(s.lastIn) ? `<span class="rg-time">${hhmm(s.lastIn)}</span>` : dash}</td>
          <td data-label="Last punch">${hhmm(s.lastPunch) ? `<span class="rg-time">${hhmm(s.lastPunch)}</span>` : dash}</td>
          <td class="c-gate" data-label="Last gate">${esc(s.lastDeviceName || '') || dash}</td>
          <td class="num" data-label="Punches">${s.punchCount}</td>
        </tr>`;
      if (!open) return main;
      const steps = s.movements.map((m) => `
        <li class="${m.type}"><span class="t">${hhmm(m.time)}</span><span class="k">${m.type === 'OUT' ? 'Went out' : 'Came back'}</span><span class="g">${esc(m.deviceName)}</span></li>`).join('');
      return `${main}
        <tr class="detail" id="${id}"><td colspan="${COLS}">
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
      ['SUC', (s) => s.SUC],
      ['Name', (s) => s.EmployeeName],
      ['Campus', (s) => s.Campus],
      ['Block', (s) => s.Block],
      ['Room', (s) => s.RoomNo],
      ['Bed', (s) => s.BedNo],
      ['Mobile', (s) => s.ContactNo],
      ['Status', (s) => ({ NONE: 'IN (no punches)', IN: 'IN', OUT: s.outpass ? (s.outpass.overdue ? 'OUT (outpass overdue)' : 'OUT (on outpass)') : 'OUT (no outpass)' })[statusOf(s)]],
      ['Outpass', (s) => (s.outpass ? `${s.outpass.passNo}, back by ${s.outpass.returnBy.slice(0, 16)}` : '')],
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

  // ---------- events ----------
  const setFilter = (f) => {
    state.filter = f;
    renderChips();
    renderRows();
    writeUrl();
  };

  els.headlineAction.addEventListener('click', () => {
    setFilter('NOPASS');
    els.headlineAction.hidden = true;
    document.getElementById('studentsTitle').scrollIntoView({ behavior: 'smooth' });
  });

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

  setInterval(() => { if (state.report && isLive() && !document.hidden) load(); }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && isLive() && state.report && state.loadedAt && Date.now() - state.loadedAt > REFRESH_MS) load();
  });

  function renderNoGates() {
    els.main.setAttribute('aria-busy', 'false');
    els.main.innerHTML = `
      <div class="card-x" style="margin:24px 0">
        <div class="empty"><i class="bi bi-door-closed" aria-hidden="true"></i><h4>No gates assigned to you yet</h4>
        <p>Ask an admin to map your account to your hostel's gates. The register will show those students once they do.</p></div>
      </div>`;
  }

  readUrl();
  renderSkeleton();
  AppNav.ready
    .then((user) => {
      state.user = user;
      if (!user.isAdmin && !user.deviceIds.length) return renderNoGates();
      return load();
    })
    .catch((err) => (err instanceof AppNav.AuthError ? toLogin() : renderError(`Couldn't reach the server: ${err.message}.`)));
})();
