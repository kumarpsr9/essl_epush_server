(() => {
  'use strict';

  const { api, toast, esc, AuthError, toLogin } = AppNav;
  const $ = (id) => document.getElementById(id);
  const NAME_RE = /^[A-Za-z0-9._-]{3,50}$/;

  const state = {
    me: null,
    users: [],
    devices: [],     // [{ DeviceId, DeviceFName, online }]
    tab: 'all',
    editing: null,   // user being edited, null when adding
    target: null,    // user for reset/delete
  };

  const TABS = [
    { id: 'all', label: 'Everyone' },
    { id: 'admin', label: 'Admins' },
    { id: 'warden', label: 'Wardens' },
  ];

  const gateName = (id) => state.devices.find((d) => d.DeviceId === id)?.DeviceFName || `Gate ${id}`;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  function handle(err, show) {
    if (err instanceof AuthError) return toLogin();
    show(err.message);
  }

  // ---------- load ----------
  async function load() {
    try {
      const [users, devices] = await Promise.all([api('api/users'), api('api/devices')]);
      state.users = users.data;
      state.devices = devices.data;
      $('errorBox').innerHTML = '';
      render();
    } catch (err) {
      handle(err, (msg) => {
        $('errorBox').innerHTML = `<div class="alert-x" role="alert" style="margin-bottom:18px"><i class="bi bi-exclamation-circle" aria-hidden="true"></i>
          <span>Couldn't load users: ${esc(msg)}</span>
          <button class="btn-x btn-x--ghost" type="button" data-action="retry" style="margin-left:auto">Try again</button></div>`;
        $('rows').innerHTML = '';
      });
    } finally {
      $('main').setAttribute('aria-busy', 'false');
    }
  }

  // ---------- render ----------
  function render() {
    const count = (id) => (id === 'all' ? state.users.length : state.users.filter((u) => u.role === id).length);
    $('roleTabs').innerHTML = TABS.map((t) => `
      <button type="button" role="tab" data-tab="${t.id}" aria-selected="${state.tab === t.id}">${t.label} <span class="n">${count(t.id)}</span></button>`).join('');
    $('userCount').textContent = plural(state.users.length, 'user', 'users');

    const list = state.users.filter((u) => state.tab === 'all' || u.role === state.tab);
    if (!list.length) {
      const [title, msg] = state.tab === 'warden'
        ? ['No wardens yet', 'Add a warden and pick the gates of their hostel.']
        : ['No users here', 'Add a user to give someone access to the register.'];
      $('rows').innerHTML = `<tr><td colspan="4"><div class="empty"><i class="bi bi-person-plus" aria-hidden="true"></i><h4>${title}</h4><p>${msg}</p>
        <button class="btn-x btn-x--primary" type="button" data-action="add">Add user</button></div></td></tr>`;
      return;
    }

    $('rows').innerHTML = list.map((u) => {
      const self = u.name === state.me.name;
      const isAdmin = u.role === 'admin';
      const role = isAdmin
        ? '<span class="chip"><i class="bi bi-shield-check" aria-hidden="true"></i> Admin</span>'
        : '<span class="chip" style="background:var(--teal-bg);color:var(--teal)"><i class="bi bi-person-badge" aria-hidden="true"></i> Warden</span>';
      const gates = isAdmin
        ? '<span class="chip chip--muted">Every gate</span>'
        : u.deviceIds.length
          ? u.deviceIds.map((id) => `<span class="chip chip--muted"><i class="bi bi-door-open" aria-hidden="true"></i> ${esc(gateName(id))}</span>`).join('')
          : '<span class="chip chip--bad"><i class="bi bi-exclamation-circle" aria-hidden="true"></i> No gates, sees nothing</span>';
      const actions = self
        ? '<span class="fld-hint" style="margin:0">Use your account menu to change your password.</span>'
        : `<button class="btn-x btn-x--ghost" type="button" data-action="edit" data-id="${u.id}"><i class="bi bi-pencil" aria-hidden="true"></i> Edit role &amp; gates</button>
           <button class="btn-x btn-x--ghost" type="button" data-action="reset" data-id="${u.id}"><i class="bi bi-key" aria-hidden="true"></i> Reset password</button>
           <button class="btn-x btn-x--quiet" type="button" data-action="delete" data-id="${u.id}"><i class="bi bi-trash" aria-hidden="true"></i> Delete</button>`;
      return `
        <tr>
          <td><div class="us-who"><span class="rg-avatar${isAdmin ? '' : ' rg-avatar--warden'}" aria-hidden="true">${esc(u.name.slice(0, 2))}</span>
            <b>${esc(u.name)}</b>${self ? '<span class="chip chip--solid">You</span>' : ''}</div></td>
          <td data-label="Role">${role}</td>
          <td data-label="Gates"><div class="us-gates">${gates}</div></td>
          <td><div class="us-actions">${actions}</div></td>
        </tr>`;
    }).join('');
  }

  // ---------- shared dialog helpers ----------
  const dialogError = (id, msg) => {
    const box = $(id);
    box.querySelector('span').textContent = msg || '';
    box.hidden = !msg;
  };

  function setBusy(btn, busy, idle, working) {
    btn.disabled = busy;
    btn.textContent = busy ? working : idle;
  }

  document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  document.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => {
    const input = $(b.dataset.toggle);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    b.textContent = show ? 'Hide' : 'Show';
  }));

  // ---------- add / edit ----------
  const userForm = $('userDialog').querySelector('form');
  const roleValue = () => userForm.querySelector('input[name="role"]:checked').value;

  function renderGateOptions(selected) {
    $('gateList').innerHTML = state.devices.length
      ? state.devices.map((d) => `
        <label class="gate-opt"><input type="checkbox" name="gate" value="${d.DeviceId}"${selected.includes(d.DeviceId) ? ' checked' : ''}>
          <b>${esc(d.DeviceFName)}</b><span class="st ${d.online ? 'on' : 'off'}">${d.online ? '● Online' : '○ Offline'}</span></label>`).join('')
      : '<p class="fld-hint">No gate devices are registered on the ePush server yet.</p>';
    syncGateToggle();
  }

  const checkedGates = () => [...$('gateList').querySelectorAll('input:checked')].map((i) => Number(i.value));

  function syncGateToggle() {
    const all = $('gateList').querySelectorAll('input');
    $('toggleAllGates').hidden = !all.length;
    $('toggleAllGates').textContent = all.length && checkedGates().length === all.length ? 'Clear all' : 'Select all';
  }

  function syncRole() {
    $('gatePick').hidden = roleValue() !== 'warden';
  }

  function setFieldError(boxId, errId, msg) {
    $(errId).textContent = msg;
    $(boxId)?.classList.toggle('is-invalid', !!msg);
  }

  function clearUserErrors() {
    dialogError('userDlgError', '');
    setFieldError('uNameBox', 'uNameErr', '');
    setFieldError('uPassBox', 'uPassErr', '');
    setFieldError(null, 'gateErr', '');
    $('gatePick').classList.remove('is-invalid');
  }

  function openUserDialog(user) {
    state.editing = user;
    userForm.reset();
    clearUserErrors();
    $('uPass').type = 'password';
    userForm.querySelector('[data-toggle="uPass"]').textContent = 'Show';
    $('credFields').hidden = !!user;
    $('userDlgTitle').textContent = user ? `Edit ${user.name}` : 'Add user';
    $('userDlgSub').textContent = user
      ? 'Change what this person can see. Their password stays the same.'
      : 'They sign in to the register with this username and password.';
    $('userDlgSubmit').textContent = user ? 'Save changes' : 'Add user';
    userForm.querySelector(`input[name="role"][value="${user ? user.role : 'warden'}"]`).checked = true;
    renderGateOptions(user ? user.deviceIds : []);
    syncRole();
    $('userDialog').showModal();
    (user ? userForm.querySelector('input[name="role"]:checked') : $('uName')).focus();
  }

  function validateUser() {
    clearUserErrors();
    let first = null;
    if (!state.editing) {
      const name = $('uName').value.trim();
      const nameErr = !name ? 'Enter a username'
        : !NAME_RE.test(name) ? 'Use 3–50 letters, numbers, dot, dash or underscore'
          : state.users.some((u) => u.name.toLowerCase() === name.toLowerCase()) ? 'That username is already taken' : '';
      setFieldError('uNameBox', 'uNameErr', nameErr);
      if (nameErr) first = first || $('uName');
      const passErr = $('uPass').value.length < 8 ? 'Password must be at least 8 characters' : '';
      setFieldError('uPassBox', 'uPassErr', passErr);
      if (passErr) first = first || $('uPass');
    }
    if (roleValue() === 'warden' && !checkedGates().length) {
      setFieldError(null, 'gateErr', 'Pick at least one gate. A warden with no gates sees nothing.');
      $('gatePick').classList.add('is-invalid');
      first = first || $('gateList').querySelector('input');
    }
    first?.focus();
    return !first;
  }

  userForm.addEventListener('change', (e) => {
    if (e.target.name === 'role') syncRole();
    if (e.target.name === 'gate') {
      syncGateToggle();
      if (checkedGates().length) { setFieldError(null, 'gateErr', ''); $('gatePick').classList.remove('is-invalid'); }
    }
  });

  $('toggleAllGates').addEventListener('click', () => {
    const boxes = [...$('gateList').querySelectorAll('input')];
    const select = boxes.some((b) => !b.checked);
    boxes.forEach((b) => { b.checked = select; });
    syncGateToggle();
  });

  userForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validateUser()) return;
    const btn = $('userDlgSubmit');
    const editing = state.editing;
    const role = roleValue();
    const body = { role, deviceIds: role === 'warden' ? checkedGates() : [] };
    setBusy(btn, true, '', editing ? 'Saving…' : 'Adding…');
    try {
      if (editing) {
        await api(`api/users/${editing.id}`, { method: 'PATCH', json: body });
      } else {
        await api('api/users', { json: { ...body, username: $('uName').value.trim(), password: $('uPass').value } });
      }
      $('userDialog').close();
      toast(editing ? `Saved changes to ${editing.name}` : `Added ${$('uName').value.trim()}`);
      await load();
    } catch (err) {
      handle(err, (msg) => dialogError('userDlgError', msg));
    } finally {
      setBusy(btn, false, editing ? 'Save changes' : 'Add user');
    }
  });

  // ---------- reset password ----------
  const resetForm = $('pwResetDialog').querySelector('form');

  function openReset(user) {
    state.target = user;
    resetForm.reset();
    $('rPass').type = 'password';
    resetForm.querySelector('[data-toggle="rPass"]').textContent = 'Show';
    dialogError('pwResetError', '');
    $('pwResetTitle').textContent = `Reset password for ${user.name}`;
    $('pwResetSub').textContent = "They'll be signed out everywhere and need the new password to sign in.";
    $('pwResetDialog').showModal();
    $('rPass').focus();
  }

  resetForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if ($('rPass').value.length < 8) {
      dialogError('pwResetError', 'Password must be at least 8 characters');
      $('rPass').focus();
      return;
    }
    const btn = $('pwResetSubmit');
    setBusy(btn, true, '', 'Resetting…');
    try {
      await api(`api/users/${state.target.id}/password`, { method: 'PUT', json: { password: $('rPass').value } });
      $('pwResetDialog').close();
      toast(`Password reset for ${state.target.name}`);
    } catch (err) {
      handle(err, (msg) => dialogError('pwResetError', msg));
    } finally {
      setBusy(btn, false, 'Reset password');
    }
  });

  // ---------- delete ----------
  const deleteForm = $('deleteDialog').querySelector('form');

  function openDelete(user) {
    state.target = user;
    dialogError('deleteError', '');
    $('deleteTitle').textContent = `Delete ${user.name}?`;
    $('deleteSub').textContent = user.role === 'admin' ? 'Admin account' : `Warden for ${plural(user.deviceIds.length, 'gate', 'gates')}`;
    $('deleteDialog').showModal();
    deleteForm.querySelector('[data-close]').focus();
  }

  deleteForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('deleteSubmit');
    setBusy(btn, true, '', 'Deleting…');
    try {
      await api(`api/users/${state.target.id}`, { method: 'DELETE' });
      $('deleteDialog').close();
      toast(`Deleted ${state.target.name}`);
      await load();
    } catch (err) {
      handle(err, (msg) => dialogError('deleteError', msg));
    } finally {
      setBusy(btn, false, 'Delete user');
    }
  });

  // ---------- page events ----------
  $('addUser').addEventListener('click', () => openUserDialog(null));
  $('roleTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) { state.tab = b.dataset.tab; render(); }
  });
  $('errorBox').addEventListener('click', (e) => { if (e.target.closest('[data-action="retry"]')) load(); });
  $('rows').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-action]');
    if (!b) return;
    if (b.dataset.action === 'add') return openUserDialog(null);
    const user = state.users.find((u) => String(u.id) === b.dataset.id);
    if (!user) return;
    if (b.dataset.action === 'edit') openUserDialog(user);
    if (b.dataset.action === 'reset') openReset(user);
    if (b.dataset.action === 'delete') openDelete(user);
  });

  AppNav.ready.then((me) => {
    state.me = me;
    if (!me.isAdmin) {
      $('main').setAttribute('aria-busy', 'false');
      $('main').innerHTML = `<div class="card-x" style="margin:24px 0"><div class="empty"><i class="bi bi-shield-lock" aria-hidden="true"></i>
        <h4>Only admins can manage users</h4><p>Ask an admin if you need someone added or a password reset.</p>
        <a class="btn-x btn-x--primary" href="register.html">Go to the movement register</a></div></div>`;
      return;
    }
    $('addUser').hidden = false;
    $('rows').innerHTML = `<tr><td colspan="4">${'<div class="sk" style="margin:12px 0"></div>'.repeat(4)}</td></tr>`;
    load();
  }).catch(() => {});
})();
