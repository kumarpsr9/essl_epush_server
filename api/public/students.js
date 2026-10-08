(() => {
  'use strict';

  const { api, toast, esc, AuthError, toLogin } = AppNav;
  const $ = (id) => document.getElementById(id);
  const PAGE = 100;
  const NONE = '__none__';

  const state = {
    students: [],
    tab: 'all',
    block: '',
    campus: '',
    query: '',
    shown: PAGE,
    editing: null, // student being edited, null when adding
  };

  const TABS = [
    { id: 'all', label: 'All' },
    { id: 'needs', label: 'Needs details' },
    { id: 'unallotted', label: 'No room' },
  ];

  // Students the device created carry their roll number as their name.
  const nameMissing = (s) => !s.name || s.name === s.code;
  const needsDetails = (s) => nameMissing(s) || !s.room;
  const roomKey = (s) => `${s.block || ''} ${s.room || ''} ${s.bed || ''}`;
  const dash = '<span class="dash" aria-label="not set">–</span>';
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

  function handle(err, show) {
    if (err instanceof AuthError) return toLogin();
    show(err.message);
  }

  // ---------- load ----------
  async function load() {
    try {
      const { data } = await api('api/students');
      state.students = data;
      $('errorBox').innerHTML = '';
      render();
    } catch (err) {
      handle(err, (msg) => {
        $('errorBox').innerHTML = `<div class="alert-x" role="alert" style="margin-bottom:18px"><i class="bi bi-exclamation-circle" aria-hidden="true"></i>
          <span>Couldn't load students: ${esc(msg)}</span>
          <button class="btn-x btn-x--ghost" type="button" data-action="retry" style="margin-left:auto">Try again</button></div>`;
        $('rows').innerHTML = '';
      });
    } finally {
      $('main').setAttribute('aria-busy', 'false');
    }
  }

  // ---------- derived ----------
  const distinct = (key) => [...new Set(state.students.map((s) => s[key]).filter(Boolean))].sort(collator.compare);

  // Filter <select>: "All …", each value, then "No …" for blanks. Resets a choice that no longer exists.
  function fillFilter(id, key, all, none) {
    const list = distinct(key);
    if (state[key] && state[key] !== NONE && !list.includes(state[key])) state[key] = '';
    $(id).innerHTML = `<option value="">${all}</option>${list.map((v) => `<option${v === state[key] ? ' selected' : ''}>${esc(v)}</option>`).join('')}
      <option value="${NONE}"${state[key] === NONE ? ' selected' : ''}>${none}</option>`;
    $(`${key}List`).innerHTML = list.map((v) => `<option value="${esc(v)}">`).join('');
  }

  function visible() {
    const q = state.query.trim().toLowerCase();
    return state.students
      .filter((s) => state.tab === 'all' || (state.tab === 'needs' ? needsDetails(s) : !s.room))
      .filter((s) => !state.block || (state.block === NONE ? !s.block : s.block === state.block))
      .filter((s) => !state.campus || (state.campus === NONE ? !s.campus : s.campus === state.campus))
      .filter((s) => !q || [s.name, s.code, s.suc, s.phone, s.campus, roomKey(s)].some((v) => v && String(v).toLowerCase().includes(q)))
      .sort((a, b) => {
        // Allotted students by block → room → bed, unallotted after them by name.
        if (!!a.room !== !!b.room) return a.room ? -1 : 1;
        return collator.compare(a.block || '', b.block || '')
          || collator.compare(a.room || '', b.room || '')
          || collator.compare(a.bed || '', b.bed || '')
          || collator.compare(a.name || '', b.name || '');
      });
  }

  // ---------- render ----------
  function render() {
    const needs = state.students.filter(needsDetails).length;
    $('needsBox').hidden = !needs;
    $('needsTitle').textContent = `${needs.toLocaleString('en-IN')} ${needs === 1 ? 'student needs' : 'students need'} a name or room`;
    $('total').textContent = `${state.students.length.toLocaleString('en-IN')} students`;

    const count = (id) => (id === 'all' ? state.students.length
      : state.students.filter(id === 'needs' ? needsDetails : (s) => !s.room).length);
    $('tabs').innerHTML = TABS.map((t) => `
      <button type="button" role="tab" data-tab="${t.id}" aria-selected="${state.tab === t.id}">${t.label} <span class="n">${count(t.id).toLocaleString('en-IN')}</span></button>`).join('');

    fillFilter('campusFilter', 'campus', 'All campuses', 'No campus');
    fillFilter('blockFilter', 'block', 'All blocks', 'No block');

    renderRows();
  }

  function renderRows() {
    const list = visible();
    if (!list.length) {
      const [icon, title, msg] = state.query
        ? ['bi-search', 'No matches', `No students match "${esc(state.query)}". Check the spelling, roll number or room.`]
        : state.tab === 'needs' ? ['bi-check2-all', 'Every student has details', 'All names and rooms are filled in.']
          : ['bi-people', 'No students here', 'Add a student, or pick another block.'];
      $('rows').innerHTML = `<tr class="empty-row"><td colspan="8" class="empty-cell"><div class="empty"><i class="bi ${icon}" aria-hidden="true"></i><h4>${title}</h4><p>${msg}</p></div></td></tr>`;
      $('rowCount').textContent = '';
      $('more').hidden = true;
      return;
    }

    const page = list.slice(0, state.shown);
    $('rows').innerHTML = page.map((s) => `
      <tr>
        <td class="c-student">
          ${nameMissing(s) ? '<div class="st-name is-missing">Name not added</div>' : `<div class="st-name">${esc(s.name)}</div>`}
          <div class="st-code">${esc(s.code)}${s.suc ? ` · SUC ${esc(s.suc)}` : ''}</div>
        </td>
        <td class="c-campus" data-label="Campus">${s.campus ? `<span class="st-campus">${esc(s.campus)}</span>` : dash}</td>
        <td class="c-gender" data-label="Gender">${esc(s.gender) || dash}</td>
        <td data-label="Block">${s.block ? `<span class="st-room">${esc(s.block)}</span>` : dash}</td>
        <td data-label="Room">${s.room ? `<span class="st-room">${esc(s.room)}</span>` : dash}</td>
        <td data-label="Bed">${s.bed ? `<span class="st-room">${esc(s.bed)}</span>` : dash}</td>
        <td class="c-phone" data-label="Phone">${s.phone ? esc(s.phone) : dash}</td>
        <td class="c-edit"><button class="btn-x btn-x--ghost" type="button" data-code="${esc(s.code)}" aria-label="Edit ${esc(nameMissing(s) ? s.code : s.name)}"><i class="bi bi-pencil" aria-hidden="true"></i> Edit</button></td>
      </tr>`).join('');

    $('rowCount').textContent = `Showing ${page.length.toLocaleString('en-IN')} of ${list.length.toLocaleString('en-IN')}`;
    $('more').hidden = page.length >= list.length;
    $('more').textContent = `Show ${Math.min(PAGE, list.length - page.length)} more`;
  }

  // ---------- dialog ----------
  const dlg = $('studentDialog');
  const form = dlg.querySelector('form');
  const fields = {
    code: ['fCode', 'fCodeBox', 'fCodeErr'],
    suc: ['fSuc', 'fSucBox', 'fSucErr'],
    name: ['fName', 'fNameBox', 'fNameErr'],
    phone: ['fPhone', 'fPhoneBox', 'fPhoneErr'],
  };

  function setErr(key, msg) {
    const [, box, err] = fields[key];
    $(err).textContent = msg;
    $(box).classList.toggle('is-invalid', !!msg);
  }

  function setRoomErr(msg) {
    $('fRoomErr').textContent = msg;
    ['fBlockBox', 'fRoomBox', 'fBedBox'].forEach((id) => $(id).classList.toggle('is-invalid', !!msg));
  }

  function showError(msg) {
    $('stError').querySelector('span').textContent = msg || '';
    $('stError').hidden = !msg;
  }

  function clearErrors() {
    Object.keys(fields).forEach((k) => setErr(k, ''));
    setRoomErr('');
    showError('');
  }

  // The "Save and next" queue: the filtered list as it was when the dialog opened.
  let queue = [];

  function nextInQueue() {
    const i = queue.indexOf(state.editing?.code);
    return i >= 0 ? state.students.find((s) => s.code === queue[i + 1]) : null;
  }

  function openDialog(student, { fromQueue = false } = {}) {
    if (!fromQueue) queue = student ? visible().map((s) => s.code) : [];
    state.editing = student;
    form.reset();
    clearErrors();

    $('codeFld').hidden = !!student;
    $('codeRo').hidden = !student;
    $('stDlgTitle').textContent = student
      ? (nameMissing(student) ? `Add details for ${student.code}` : `Edit ${student.name}`)
      : 'Add student';
    $('stDlgSub').textContent = student
      ? (student.updatedBy
        ? `Last changed by ${student.updatedBy.startsWith('erp:') ? `the ERP (${student.updatedBy.slice(4)})` : student.updatedBy}.`
        : 'Added by the gate device.')
      : 'Enrol their fingerprint or face on the gate device with the same roll number.';

    if (student) {
      $('roCode').textContent = student.code;
      $('fSuc').value = student.suc || '';
      $('fName').value = nameMissing(student) ? '' : student.name;
      $('fPhone').value = student.phone || '';
      $('fCampus').value = student.campus || '';
      $('fBlock').value = student.block || '';
      $('fRoom').value = student.room || '';
      $('fBed').value = student.bed || '';
      const g = form.querySelector(`input[name="gender"][value="${student.gender}"]`);
      if (g) g.checked = true;
    } else {
      form.querySelector('input[name="gender"][value="Male"]').checked = true;
      if (state.block && state.block !== NONE) $('fBlock').value = state.block;
      if (state.campus && state.campus !== NONE) $('fCampus').value = state.campus;
    }

    const next = student && nextInQueue();
    const pos = student ? queue.indexOf(student.code) : -1;
    $('stSaveNext').hidden = !next;
    $('stProgress').textContent = student && queue.length > 1 && pos >= 0 ? `${pos + 1} of ${queue.length}` : '';
    $('stSave').textContent = student ? 'Save' : 'Add student';

    if (!dlg.open) dlg.showModal();
    (student ? $('fName') : $('fCode')).focus();
  }

  function readForm() {
    return {
      code: $('fCode').value.trim(),
      suc: $('fSuc').value.trim(),
      name: $('fName').value.trim().replace(/\s+/g, ' '),
      gender: form.querySelector('input[name="gender"]:checked')?.value || '',
      phone: $('fPhone').value.trim(),
      campus: $('fCampus').value.trim(),
      block: $('fBlock').value.trim(),
      room: $('fRoom').value.trim(),
      bed: $('fBed').value.trim(),
    };
  }

  function validate(v) {
    clearErrors();
    let first = null;
    const fail = (key, msg) => { setErr(key, msg); first = first || $(fields[key][0]); };
    if (!state.editing) {
      if (!/^\d{1,9}$/.test(v.code)) fail('code', 'Enter the roll number: digits only, up to 9');
      else if (state.students.some((s) => s.code === v.code)) fail('code', `Roll number ${v.code} is already added`);
    }
    if (v.suc && !/^\d{8,10}$/.test(v.suc)) fail('suc', 'SUC must be 8–10 digits');
    else if (v.suc) {
      const other = state.students.find((s) => s.suc === v.suc && s.code !== (state.editing?.code ?? v.code));
      if (other) fail('suc', `SUC ${v.suc} already belongs to ${nameMissing(other) ? other.code : other.name}`);
    }
    if (!v.name) fail('name', "Enter the student's name");
    if (v.phone && !/^\+?[0-9 -]{10,15}$/.test(v.phone)) fail('phone', 'Phone number must be 10–15 digits');
    if (v.bed && !(v.block && v.room)) {
      setRoomErr('Enter the block and room before the bed number');
      first = first || $(v.block ? 'fRoom' : 'fBlock');
    } else if (v.bed) {
      const taken = state.students.find((s) => s.code !== (state.editing?.code ?? v.code)
        && s.block === v.block && s.room === v.room && s.bed === v.bed);
      if (taken) {
        setRoomErr(`Bed ${v.bed} is already given to ${nameMissing(taken) ? taken.code : taken.name}`);
        first = first || $('fBed');
      }
    }
    first?.focus();
    return !first;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const goNext = e.submitter?.value === 'next';
    const v = readForm();
    if (!validate(v)) return;

    const editing = state.editing;
    const buttons = [$('stSave'), $('stSaveNext')];
    buttons.forEach((b) => { b.disabled = true; });
    const label = e.submitter?.textContent;
    if (e.submitter) e.submitter.textContent = editing ? 'Saving…' : 'Adding…';
    try {
      const { data } = editing
        ? await api(`api/students/${encodeURIComponent(editing.code)}`, { method: 'PATCH', json: v })
        : await api('api/students', { json: v });
      const i = state.students.findIndex((s) => s.code === data.code);
      if (i >= 0) state.students[i] = data; else state.students.push(data);
      toast(editing ? `Saved ${data.name}` : `Added ${data.name}`);
      if (goNext) {
        const next = nextInQueue();
        render();
        if (next) return openDialog(next, { fromQueue: true });
      }
      dlg.close();
      render();
    } catch (err) {
      handle(err, (msg) => (/bed/i.test(msg) ? setRoomErr(msg) : /^SUC/.test(msg) ? setErr('suc', msg) : showError(msg)));
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
      if (e.submitter && label) e.submitter.textContent = label;
    }
  });

  dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dlg.close()));

  // ---------- page events ----------
  $('addStudent').addEventListener('click', () => openDialog(null));
  $('startFill').addEventListener('click', () => {
    state.tab = 'needs';
    state.shown = PAGE;
    render();
    const first = visible()[0];
    if (first) openDialog(first);
  });
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    state.tab = b.dataset.tab;
    state.shown = PAGE;
    render();
  });
  ['block', 'campus'].forEach((key) => $(`${key}Filter`).addEventListener('change', (e) => {
    state[key] = e.target.value;
    state.shown = PAGE;
    renderRows();
  }));
  let searchTimer;
  $('search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = $('search').value; state.shown = PAGE; renderRows(); }, 150);
  });
  $('more').addEventListener('click', () => { state.shown += PAGE; renderRows(); });
  $('errorBox').addEventListener('click', (e) => { if (e.target.closest('[data-action="retry"]')) load(); });
  $('rows').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-code]');
    const s = b && state.students.find((x) => x.code === b.dataset.code);
    if (s) openDialog(s);
  });

  $('rows').innerHTML = `<tr><td colspan="8">${'<div class="sk" style="margin:12px 0"></div>'.repeat(6)}</td></tr>`;
  AppNav.ready.then(load).catch(() => {});
})();
