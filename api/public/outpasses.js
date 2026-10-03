(() => {
  'use strict';

  const { api, toast, esc, AuthError, toLogin } = AppNav;
  const $ = (id) => document.getElementById(id);
  const REFRESH_MS = 60_000;

  const state = {
    me: null,
    now: null,          // server IST clock, 'YYYY-MM-DD HH:MM:SS'
    passes: [],
    today: { issued: 0, returned: 0, late: 0 },
    openPasses: [],     // always the open list, for tiles and duplicate checks
    totals: null,       // register totals for the night check
    students: null,     // loaded when the issue dialog first opens
    tab: 'open',
    query: '',
    target: null,
    picked: null,
  };

  const TABS = [
    { id: 'open', label: 'Open' },
    { id: 'overdue', label: 'Overdue' },
    { id: 'history', label: 'History' },
  ];
  const REASONS = ['Shopping', 'Medical', 'Going home', 'College work', 'Bank', 'Family visit'];
  const APPROVERS = ['Parent on phone', 'Chief warden', 'HOD', 'Principal'];

  // ---------- time (all IST wall-clock strings) ----------
  const toMs = (s) => Date.parse(`${s.replace(' ', 'T').slice(0, 19)}+05:30`);
  const fromMs = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' });
  const nowStr = () => state.now || fromMs(Date.now());
  const day = (s) => s.slice(0, 10);
  const hhmm = (s) => s.slice(11, 16);
  const toInput = (s) => s.slice(0, 16).replace(' ', 'T');
  const roundUp5 = (ms) => Math.ceil(ms / 300_000) * 300_000;
  function whenText(s) {
    const d = day(s);
    const today = day(nowStr());
    const tomorrow = fromMs(toMs(`${today} 12:00:00`) + 86_400_000).slice(0, 10);
    const yesterday = fromMs(toMs(`${today} 12:00:00`) - 86_400_000).slice(0, 10);
    const label = d === today ? 'Today' : d === tomorrow ? 'Tomorrow' : d === yesterday ? 'Yesterday'
      : new Date(`${d}T12:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    return `${label} ${hhmm(s)}`;
  }
  function duration(min) {
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (h < 48) return m ? `${h} h ${m} min` : `${h} h`;
    return `${Math.round(h / 24)} days`;
  }

  function handle(err, show) {
    if (err instanceof AuthError) return toLogin();
    show(err.message);
  }

  const meta = (p) => [
    `<span>${esc(p.code)}</span>`,
    p.suc && `<span title="Student Unique Code">SUC ${esc(p.suc)}</span>`,
    p.campus && `<span>${esc(p.campus)}</span>`,
    p.block && `<span>${esc(p.block)}</span>`,
    p.room && `<span>Room ${esc(p.room)}</span>`,
    p.bed && `<span>Bed ${esc(p.bed)}</span>`,
    p.phone && `<a href="tel:${esc(String(p.phone).replace(/[^\d+]/g, ''))}"><i class="bi bi-telephone" aria-hidden="true"></i> ${esc(p.phone)}</a>`,
  ].filter(Boolean).join('');

  // ---------- load ----------
  async function load() {
    const qs = new URLSearchParams({ view: state.tab === 'history' ? 'history' : 'open' });
    if (state.tab === 'history') { qs.set('from', $('from').value); qs.set('to', $('to').value); }
    try {
      const [list, register] = await Promise.all([
        api(`api/outpasses?${qs}`),
        api('api/reports/hostel/devices').catch((e) => { if (e instanceof AuthError) throw e; return null; }),
      ]);
      state.now = list.now;
      state.passes = list.data;
      state.today = list.today;
      if (list.view === 'open') state.openPasses = list.data;
      else if (!state.openPasses.length) state.openPasses = (await api('api/outpasses')).data;
      state.totals = register?.totals || null;
      $('errorBox').innerHTML = '';
      render();
    } catch (err) {
      handle(err, (msg) => {
        $('errorBox').innerHTML = `<div class="alert-x" role="alert" style="margin-bottom:18px"><i class="bi bi-exclamation-circle" aria-hidden="true"></i>
          <span>Couldn't load outpasses: ${esc(msg)}</span>
          <button class="btn-x btn-x--ghost" type="button" data-action="retry" style="margin-left:auto">Try again</button></div>`;
      });
    } finally {
      $('main').setAttribute('aria-busy', 'false');
    }
  }

  // ---------- render ----------
  function render() {
    renderCheck();
    renderKpis();
    $('tabs').innerHTML = TABS.map((t) => {
      const n = t.id === 'open' ? state.openPasses.length : t.id === 'overdue' ? state.openPasses.filter((p) => p.state === 'overdue').length : null;
      return `<button type="button" role="tab" data-tab="${t.id}" aria-selected="${state.tab === t.id}">${t.label}${n !== null ? ` <span class="n">${n}</span>` : ''}</button>`;
    }).join('');
    $('dates').hidden = state.tab !== 'history';
    renderRows();
  }

  function renderCheck() {
    const t = state.totals;
    if (!t) { $('checkBox').hidden = true; return; }
    const noPass = t.outNoPass || 0;
    const overdue = t.outOverdue || 0;
    const box = $('checkBox');
    box.hidden = false;
    $('checkLink').hidden = !noPass;
    if (noPass) {
      box.className = 'attn attn--danger';
      $('checkIcon').innerHTML = '<i class="bi bi-exclamation-octagon"></i>';
      $('checkTitle').textContent = `${noPass} ${noPass === 1 ? 'student is' : 'students are'} out without an outpass`;
      $('checkText').textContent = `Their last gate punch was going out and no pass covers them. ${t.outOnPass} out on a pass${overdue ? `, ${overdue} overdue` : ''}.`;
    } else {
      box.className = `attn ${overdue ? 'attn--danger' : 'attn--good'}`;
      $('checkIcon').innerHTML = `<i class="bi ${overdue ? 'bi-alarm' : 'bi-shield-check'}"></i>`;
      $('checkTitle').textContent = 'Everyone who is out has an outpass';
      $('checkText').textContent = overdue
        ? `${overdue} of them ${overdue === 1 ? 'is' : 'are'} past their return time. Call them or extend the pass.`
        : `${t.outOnPass} ${t.outOnPass === 1 ? 'student is' : 'students are'} out on a pass. Everyone else is inside.`;
    }
  }

  function renderKpis() {
    const open = state.openPasses;
    const n = (s) => open.filter((p) => p.state === s).length;
    const tile = (tab, mod, icon, label, value, note) => `
      <button type="button" class="kpi ${mod}" data-tab="${tab}" aria-pressed="false">
        <span class="kpi-top"><span class="kpi-icon"><i class="bi ${icon}" aria-hidden="true"></i></span><span class="kpi-label">${label}</span></span>
        <span class="kpi-value">${value}</span><span class="kpi-note">${note}</span>
      </button>`;
    $('kpis').innerHTML = [
      tile('open', 'kpi--warn', 'bi-box-arrow-right', 'Out on a pass', n('out') + n('overdue'), `${n('issued')} issued, not left yet`),
      tile('overdue', 'kpi--bad', 'bi-alarm', 'Overdue', n('overdue'), n('overdue') ? 'Past their return time' : 'Nobody is late'),
      tile('history', 'kpi--good', 'bi-box-arrow-in-left', 'Reported back today', state.today.returned, state.today.late ? `${state.today.late} came back late` : 'All on time'),
      tile('history', '', 'bi-ticket-perforated', 'Issued today', state.today.issued, 'Not counting cancelled passes'),
    ].join('');
  }

  const leftBy = (p) => (p.departSource === 'scan' ? `, scanned by ${esc(p.departedBy)}` : '');

  function stateCell(p) {
    const late = p.lateMinutes ? ` · ${duration(p.lateMinutes)} late` : '';
    switch (p.state) {
      case 'issued':
        return `<span class="chip chip--muted"><i class="bi bi-hourglass" aria-hidden="true"></i> Not left yet</span><span class="sub">Issued by ${esc(p.issuedBy)}</span>`;
      case 'out':
        return `<span class="chip chip--warn"><i class="bi bi-box-arrow-right" aria-hidden="true"></i> Out</span><span class="sub">Left ${whenText(p.departedAt)}${leftBy(p)}</span>`;
      case 'overdue':
        return `<span class="chip chip--bad"><i class="bi bi-alarm" aria-hidden="true"></i> Overdue ${duration(p.lateMinutes)}</span><span class="sub">Left ${whenText(p.departedAt)}${leftBy(p)}</span>`;
      case 'returned':
        return `<span class="chip ${p.lateMinutes ? 'chip--warn' : 'chip--good'}"><i class="bi bi-box-arrow-in-left" aria-hidden="true"></i> Back ${whenText(p.returnedAt)}</span>
          <span class="sub">${p.returnSource === 'manual' ? `Marked by ${esc(p.returnedBy)}` : p.returnSource === 'scan' ? `Scanned by ${esc(p.returnedBy)}` : 'Gate punch'}${late}${p.returnNote ? ` · ${esc(p.returnNote)}` : ''}</span>`;
      case 'cancelled':
        return `<span class="chip chip--muted"><i class="bi bi-x-circle" aria-hidden="true"></i> Cancelled</span><span class="sub">By ${esc(p.cancelledBy)}</span>`;
      default:
        return '<span class="chip chip--muted"><i class="bi bi-dash-circle" aria-hidden="true"></i> Not used</span><span class="sub">Never punched out</span>';
    }
  }

  function actions(p) {
    const b = [`<a class="btn-x btn-x--ghost" href="outpass-print.html?id=${p.id}" target="_blank" rel="noopener"><i class="bi bi-printer" aria-hidden="true"></i> Print</a>`];
    if (p.state === 'out' || p.state === 'overdue') {
      b.push(`<button class="btn-x btn-x--ghost" type="button" data-act="return" data-id="${p.id}"><i class="bi bi-box-arrow-in-left" aria-hidden="true"></i> Reported back</button>`);
    }
    if (['issued', 'out', 'overdue'].includes(p.state)) {
      b.push(`<button class="btn-x btn-x--ghost" type="button" data-act="extend" data-id="${p.id}"><i class="bi bi-clock" aria-hidden="true"></i> Extend</button>`);
    }
    if (p.state === 'issued') b.push(`<button class="btn-x btn-x--quiet" type="button" data-act="cancel" data-id="${p.id}">Cancel</button>`);
    return b.join('');
  }

  function visible() {
    const q = state.query.trim().toLowerCase();
    return state.passes
      .filter((p) => state.tab !== 'overdue' || p.state === 'overdue')
      .filter((p) => !q || [p.name, p.code, p.suc, p.passNo, p.room, p.destination, p.approvedBy].some((v) => v && String(v).toLowerCase().includes(q)));
  }

  function renderRows() {
    const list = visible();
    $('count').textContent = `${list.length} ${list.length === 1 ? 'pass' : 'passes'}`;
    if (!list.length) {
      const [icon, title, msg] = state.query ? ['bi-search', 'No matches', `No outpasses match "${esc(state.query)}".`]
        : state.tab === 'overdue' ? ['bi-check2-all', 'Nobody is overdue', 'Every student out on a pass is still within their return time.']
          : state.tab === 'open' ? ['bi-ticket-perforated', 'No open outpasses', 'Issue an outpass when a student asks to go out.']
            : ['bi-calendar-x', 'No outpasses in these dates', 'Pick other dates to see older passes.'];
      $('rows').innerHTML = `<tr class="empty-row"><td colspan="5"><div class="empty"><i class="bi ${icon}" aria-hidden="true"></i><h4>${title}</h4><p>${msg}</p></div></td></tr>`;
      return;
    }
    $('rows').innerHTML = list.map((p) => `
      <tr>
        <td class="c-pass"><div class="op-no">${esc(p.passNo)}</div><div class="op-type"><span class="chip ${p.type === 'leave' ? '' : 'chip--muted'}">${p.type === 'leave' ? 'Leave' : 'Outing'}</span></div></td>
        <td class="c-student"><div class="op-name">${esc(p.name || p.code)}</div><div class="op-meta">${meta(p)}</div>
          <div class="op-reason">${esc(p.reason)}${p.destination ? ` · ${esc(p.destination)}` : ''}</div>
          ${p.approvedBy ? `<div class="op-approved">Approved by <b>${esc(p.approvedBy)}</b></div>` : ''}</td>
        <td class="c-win op-win"><b>${whenText(p.outFrom)}</b> → <b>${whenText(p.returnBy)}</b>${p.extendedBy ? `<span class="sub">Extended by ${esc(p.extendedBy)}</span>` : ''}</td>
        <td class="c-state op-state">${stateCell(p)}</td>
        <td class="c-actions"><div class="op-actions">${actions(p)}</div></td>
      </tr>`).join('');
  }

  // ---------- dialogs: shared ----------
  const dlgError = (id, msg) => { $(id).querySelector('span').textContent = msg || ''; $(id).hidden = !msg; };
  document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  async function submitWith(btn, busyText, errorId, fn) {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = busyText;
    try {
      await fn();
    } catch (err) {
      handle(err, (msg) => dlgError(errorId, msg));
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  // ---------- issue ----------
  const issueDlg = $('issueDialog');
  const typeValue = () => issueDlg.querySelector('input[name="type"]:checked').value;

  function defaultTimes() {
    const now = toMs(nowStr());
    const from = fromMs(roundUp5(now));
    const today = day(from);
    let back;
    if (typeValue() === 'outing') {
      const evening = `${today} 18:30:00`;
      back = toMs(evening) - now > 60 * 60_000 ? evening : fromMs(Math.min(roundUp5(now + 2 * 3_600_000), toMs(`${today} 23:55:00`)));
    } else {
      back = `${fromMs(toMs(`${today} 12:00:00`) + 86_400_000).slice(0, 10)} 18:00:00`;
    }
    $('outFrom').value = toInput(from);
    $('returnBy').value = toInput(back);
  }

  async function openIssue() {
    issueDlg.querySelector('form').reset();
    ['issueError'].forEach((id) => dlgError(id, ''));
    ['pickErr', 'timeErr', 'reasonErr', 'approvedByErr'].forEach((id) => { $(id).textContent = ''; });
    ['pickBox', 'outFromBox', 'returnByBox', 'reasonBox', 'approvedByBox'].forEach((id) => $(id).classList.remove('is-invalid'));
    $('issueForm').hidden = false;
    $('issueDone').hidden = true;
    $('issueCancel').hidden = false;
    $('issueCancel').textContent = 'Cancel';
    $('donePrint').hidden = true;
    $('issueSubmit').textContent = 'Issue outpass';
    $('issueTitle').textContent = 'Issue outpass';
    $('issueSub').textContent = 'The student can leave through any gate once it is issued.';
    setPicked(null);
    defaultTimes();
    $('quick').innerHTML = REASONS.map((r) => `<button type="button">${r}</button>`).join('');
    $('approverQuick').innerHTML = APPROVERS.map((r) => `<button type="button">${r}</button>`).join('');
    // Suggest approvers already used on recent passes.
    const seen = [...new Set([...state.openPasses, ...state.passes].map((p) => p.approvedBy).filter(Boolean))];
    $('approverList').innerHTML = seen.map((a) => `<option value="${esc(a)}">`).join('');
    issueDlg.showModal();
    $('pick').focus();
    if (!state.students) {
      try {
        state.students = (await api('api/students')).data;
        matches = search($('pick').value);
        active = matches.length ? 0 : -1;
        if ($('pick').value.trim()) renderPicker();
      } catch (err) {
        handle(err, (msg) => dlgError('issueError', `Couldn't load students: ${msg}`));
      }
    }
  }

  // Student picker (combobox)
  let matches = [];
  let active = -1;
  function search(q) {
    q = q.trim().toLowerCase();
    if (!q || !state.students) return [];
    return state.students.filter((s) => [s.name, s.code, s.suc, s.room, s.phone].some((v) => v && String(v).toLowerCase().includes(q))).slice(0, 8);
  }
  function renderPicker() {
    const list = $('pickList');
    const q = $('pick').value.trim();
    const show = !!q;
    list.hidden = !show;
    $('pick').setAttribute('aria-expanded', String(show));
    if (!show) return;
    list.innerHTML = matches.length
      ? matches.map((s, i) => `<li role="option" id="opt-${i}" data-i="${i}" aria-selected="${i === active}"><b>${esc(s.name === s.code ? `${s.code} (name not added)` : s.name)}</b>
          <span>${esc(s.code)}${s.suc ? ` · SUC ${esc(s.suc)}` : ''}${s.campus ? ` · ${esc(s.campus)}` : ''}${s.block ? ` · ${esc(s.block)}` : ''}${s.room ? ` · Room ${esc(s.room)}` : ''}</span></li>`).join('')
      : `<li class="none">${state.students ? 'No student matches' : 'Loading students…'}</li>`;
    if (active >= 0) $('pick').setAttribute('aria-activedescendant', `opt-${active}`);
    else $('pick').removeAttribute('aria-activedescendant');
  }
  function setPicked(s) {
    state.picked = s;
    $('pickFld').hidden = !!s;
    const box = $('picked');
    box.hidden = !s;
    if (!s) { $('pick').value = ''; matches = []; renderPicker(); return; }
    const open = state.openPasses.find((p) => p.code === s.code);
    box.innerHTML = `
      <div class="picked">
        <span class="rg-avatar" aria-hidden="true">${esc((s.name || s.code).slice(0, 2))}</span>
        <div><b>${esc(s.name === s.code ? s.code : s.name)}</b><div class="op-meta">${meta(s)}</div></div>
        <button class="btn-x btn-x--ghost" type="button" id="changeStudent">Change</button>
      </div>
      ${open ? `<div class="alert-x alert-x--note student-note"><i class="bi bi-info-circle" aria-hidden="true"></i><span>Already has open outpass ${esc(open.passNo)} until ${whenText(open.returnBy)}. Extend that one instead.</span></div>` : ''}`;
    box.querySelector('#changeStudent').addEventListener('click', () => { setPicked(null); $('pick').focus(); });
    $('pickErr').textContent = '';
    $('pickBox').classList.remove('is-invalid');
  }
  $('pick').addEventListener('input', () => { matches = search($('pick').value); active = matches.length ? 0 : -1; renderPicker(); });
  $('pick').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!matches.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
      renderPicker();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (matches[active]) { setPicked(matches[active]); issueDlg.querySelector('input[name="type"]:checked').focus(); }
    } else if (e.key === 'Escape' && !$('pickList').hidden) {
      e.preventDefault();
      e.stopPropagation();
      $('pick').value = '';
      renderPicker();
    }
  });
  $('pickList').addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-i]');
    if (!li) return;
    e.preventDefault();
    setPicked(matches[Number(li.dataset.i)]);
  });
  $('pick').addEventListener('blur', () => setTimeout(() => { $('pickList').hidden = true; }, 100));

  issueDlg.addEventListener('change', (e) => { if (e.target.name === 'type') defaultTimes(); });
  [['quick', 'reason'], ['approverQuick', 'approvedBy']].forEach(([list, input]) => $(list).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $(input).value = b.textContent;
    $(input).focus();
  }));

  function validateIssue() {
    let first = null;
    const fail = (errId, boxIds, msg, el) => {
      $(errId).textContent = msg;
      boxIds.forEach((id) => $(id).classList.add('is-invalid'));
      first = first || el;
    };
    ['pickErr', 'timeErr', 'reasonErr', 'approvedByErr'].forEach((id) => { $(id).textContent = ''; });
    ['pickBox', 'outFromBox', 'returnByBox', 'reasonBox', 'approvedByBox'].forEach((id) => $(id).classList.remove('is-invalid'));
    dlgError('issueError', '');
    if (!state.picked) fail('pickErr', ['pickBox'], 'Pick the student who is going out', $('pick'));
    const from = $('outFrom').value;
    const back = $('returnBy').value;
    if (!from || !back) fail('timeErr', ['outFromBox', 'returnByBox'], 'Enter when they leave and when they must be back', $(from ? 'returnBy' : 'outFrom'));
    else if (back <= from) fail('timeErr', ['returnByBox'], 'Return time must be after the leaving time', $('returnBy'));
    else if (back.replace('T', ' ') <= nowStr().slice(0, 16)) fail('timeErr', ['returnByBox'], 'Return time is already past', $('returnBy'));
    else if (typeValue() === 'outing' && from.slice(0, 10) !== back.slice(0, 10)) fail('timeErr', ['returnByBox'], 'An outing ends the same day. Choose Leave for an overnight stay', $('returnBy'));
    if (!$('reason').value.trim()) fail('reasonErr', ['reasonBox'], 'Enter the reason for going out', $('reason'));
    if (!$('approvedBy').value.trim()) fail('approvedByErr', ['approvedByBox'], 'Enter who approved this outpass', $('approvedBy'));
    first?.focus();
    return !first;
  }

  issueDlg.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!$('issueDone').hidden) { issueDlg.close(); return; }
    if (!validateIssue()) return;
    submitWith($('issueSubmit'), 'Issuing…', 'issueError', async () => {
      const { data } = await api('api/outpasses', {
        json: {
          code: state.picked.code, type: typeValue(), reason: $('reason').value.trim(), destination: $('destination').value.trim(),
          approvedBy: $('approvedBy').value.trim(),
          outFrom: $('outFrom').value, returnBy: $('returnBy').value,
        },
      });
      $('issueForm').hidden = true;
      $('issueDone').hidden = false;
      $('issueTitle').textContent = data.name || data.code;
      $('issueSub').textContent = `${data.type === 'leave' ? 'Leave' : 'Outing'} · back by ${whenText(data.returnBy)}`;
      $('doneNo').textContent = data.passNo;
      $('doneText').textContent = data.departedAt
        ? `They had already gone out at ${hhmm(data.departedAt)}. That punch now counts as leaving on this pass.`
        : 'Their next gate punch will be recorded as leaving.';
      $('donePrint').href = `outpass-print.html?id=${data.id}`;
      $('donePrint').hidden = false;
      $('issueCancel').hidden = true;
      setTimeout(() => { $('issueSubmit').textContent = 'Done'; });
      toast(`Issued outpass ${data.passNo}`);
      state.tab = 'open';
      load();
    });
  });

  // ---------- reported back / extend / cancel ----------
  const findPass = (id) => state.passes.find((p) => String(p.id) === String(id));

  function openReturn(p) {
    state.target = p;
    dlgError('returnError', '');
    $('returnTitle').textContent = `${p.name || p.code} reported back`;
    $('returnSub').textContent = `${p.passNo} · ${p.departedAt ? `left ${whenText(p.departedAt)} · ` : ''}due back ${whenText(p.returnBy)}`;
    $('returnAt').value = toInput(nowStr());
    $('returnAt').max = toInput(nowStr());
    $('returnNote').value = '';
    $('returnDialog').showModal();
    $('returnAt').focus();
  }
  $('returnDialog').querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitWith($('returnSubmit'), 'Saving…', 'returnError', async () => {
      const { data } = await api(`api/outpasses/${state.target.id}/return`, { json: { at: $('returnAt').value, note: $('returnNote').value } });
      $('returnDialog').close();
      toast(`${data.name || data.code} marked reported back${data.lateMinutes ? `, ${duration(data.lateMinutes)} late` : ''}`);
      load();
    });
  });

  function openExtend(p) {
    state.target = p;
    dlgError('extendError', '');
    $('extendTitle').textContent = `Extend ${p.passNo}`;
    $('extendSub').textContent = `${p.name || p.code} · now due back ${whenText(p.returnBy)}`;
    const base = Math.max(toMs(p.returnBy), toMs(nowStr()));
    $('extendTo').value = toInput(fromMs(roundUp5(base + 2 * 3_600_000)));
    $('extendDialog').showModal();
    $('extendTo').focus();
  }
  $('extendDialog').querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!$('extendTo').value) { dlgError('extendError', 'Enter the new return time'); return; }
    submitWith($('extendSubmit'), 'Extending…', 'extendError', async () => {
      const { data } = await api(`api/outpasses/${state.target.id}/extend`, { json: { returnBy: $('extendTo').value } });
      $('extendDialog').close();
      toast(`Extended ${data.passNo} to ${whenText(data.returnBy)}`);
      load();
    });
  });

  function openCancel(p) {
    state.target = p;
    dlgError('cancelError', '');
    $('cancelTitle').textContent = `Cancel ${p.passNo}?`;
    $('cancelSub').textContent = `${p.name || p.code} · ${whenText(p.outFrom)} → ${whenText(p.returnBy)}`;
    $('cancelDialog').showModal();
    $('cancelDialog').querySelector('[data-close]').focus();
  }
  $('cancelDialog').querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitWith($('cancelSubmit'), 'Cancelling…', 'cancelError', async () => {
      const { data } = await api(`api/outpasses/${state.target.id}/cancel`, { method: 'POST' });
      $('cancelDialog').close();
      toast(`Cancelled ${data.passNo}`);
      load();
    });
  });

  // ---------- page events ----------
  $('issue').addEventListener('click', openIssue);
  const setTab = (tab) => {
    if (tab === state.tab) return;
    const reload = (tab === 'history') !== (state.tab === 'history');
    state.tab = tab;
    if (reload) { $('main').setAttribute('aria-busy', 'true'); load(); } else render();
  };
  $('tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) setTab(b.dataset.tab); });
  $('kpis').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); });
  ['from', 'to'].forEach((id) => $(id).addEventListener('change', () => {
    if ($('from').value && $('to').value && $('to').value < $('from').value) $(id === 'from' ? 'to' : 'from').value = $(id).value;
    load();
  }));
  let searchTimer;
  $('search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = $('search').value; renderRows(); }, 150);
  });
  $('errorBox').addEventListener('click', (e) => { if (e.target.closest('[data-action="retry"]')) load(); });
  $('rows').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    const p = b && findPass(b.dataset.id);
    if (!p) return;
    ({ return: openReturn, extend: openExtend, cancel: openCancel })[b.dataset.act](p);
  });

  setInterval(() => { if (!document.hidden && !document.querySelector('dialog[open]')) load(); }, REFRESH_MS);

  const todayStr = fromMs(Date.now()).slice(0, 10);
  $('from').value = todayStr;
  $('to').value = todayStr;
  $('rows').innerHTML = `<tr><td colspan="5">${'<div class="sk" style="margin:12px 0"></div>'.repeat(4)}</td></tr>`;
  AppNav.ready.then((me) => { state.me = me; load(); }).catch(() => {});
})();
