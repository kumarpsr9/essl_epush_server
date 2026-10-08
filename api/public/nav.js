// Shared top bar for signed-in pages: brand, page links, account menu and the change-password dialog.
// Pages mount it with <header class="rg-top" id="appNav" data-page="..."> and wait on AppNav.ready.
window.AppNav = (() => {
  'use strict';

  const header = document.getElementById('appNav');
  const page = header.dataset.page;

  const PAGES = [
    // `short` is the label in the phone bottom bar.
    { id: 'register', href: 'register.html', icon: 'bi-door-open', label: 'Movement register', short: 'Register' },
    { id: 'scan', href: 'scan.html', icon: 'bi-qr-code-scan', label: 'Scan pass', short: 'Scan' },
    { id: 'outpasses', href: 'outpasses.html', icon: 'bi-ticket-perforated', label: 'Outpasses', short: 'Passes' },
    { id: 'students', href: 'students.html', icon: 'bi-person-vcard', label: 'Students', short: 'Students' },
    { id: 'users', href: 'users.html', icon: 'bi-people', label: 'Users', short: 'Users', adminOnly: true },
    { id: 'erp', href: 'erp.html', icon: 'bi-plug', label: 'ERP sync', short: 'ERP', adminOnly: true },
  ];

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  class AuthError extends Error {}

  async function api(path, opts = {}) {
    const init = { credentials: 'same-origin', ...opts };
    if (opts.json !== undefined) {
      init.method = opts.method || 'POST';
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(opts.json);
    }
    const res = await fetch(path, init);
    if (res.status === 401) throw new AuthError('Session expired');
    if (res.status === 204) return null;
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || `Request failed (${res.status})`), { status: res.status });
    return body;
  }

  function toLogin() {
    location.replace(`./?next=${encodeURIComponent(location.pathname + location.search)}`);
  }

  let toastTimer;
  function toast(text) {
    let el = document.getElementById('toast');
    if (!el) {
      el = Object.assign(document.createElement('div'), { id: 'toast', className: 'toast' });
      el.setAttribute('role', 'status');
      document.body.append(el);
    }
    el.innerHTML = `<i class="bi bi-check-circle-fill" aria-hidden="true"></i><span>${esc(text)}</span>`;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }

  const roleLabel = (role) => (role === 'admin' ? 'Admin' : 'Warden');

  function render(user) {
    const links = PAGES.filter((p) => !p.adminOnly || user.isAdmin).map((p) => `
      <a href="${p.href}"${p.id === page ? ' aria-current="page"' : ''}><i class="bi ${p.icon}" aria-hidden="true"></i><span class="full">${p.label}</span><span class="short">${p.short}</span></a>`).join('');
    const scope = user.isAdmin
      ? 'Sees every gate'
      : `Sees ${user.deviceIds.length} ${user.deviceIds.length === 1 ? 'gate' : 'gates'}`;

    header.innerHTML = `
      <div class="rg-wrap">
        <a class="rg-brand" href="register.html">
          <i class="bi bi-building" aria-hidden="true"></i>
          <span><b>Aditya Hostels</b><small>Student movement register</small></span>
        </a>
        <nav class="rg-nav" aria-label="Main">${links}</nav>
        <div class="rg-account">
          <button class="rg-account-btn" type="button" id="accountBtn" aria-haspopup="menu" aria-expanded="false" aria-controls="accountMenu">
            <span class="rg-avatar${user.isAdmin ? '' : ' rg-avatar--warden'}" aria-hidden="true">${esc(user.name.slice(0, 2))}</span>
            <span class="rg-user-text"><span class="ov">${roleLabel(user.role)}</span><b>${esc(user.name)}</b></span>
            <i class="bi bi-chevron-down" aria-hidden="true"></i>
          </button>
          <div class="rg-menu" id="accountMenu" role="menu" hidden>
            <div class="rg-menu-head"><b>${esc(user.name)}</b><span>${roleLabel(user.role)} · ${scope}</span></div>
            <button type="button" role="menuitem" data-action="password"><i class="bi bi-key" aria-hidden="true"></i>Change password</button>
            <button type="button" role="menuitem" data-action="logout"><i class="bi bi-box-arrow-right" aria-hidden="true"></i>Sign out</button>
          </div>
        </div>
      </div>`;

    const btn = header.querySelector('#accountBtn');
    const menu = header.querySelector('#accountMenu');
    const setOpen = (open) => {
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      if (open) menu.querySelector('button').focus();
    };
    btn.addEventListener('click', () => setOpen(menu.hidden));
    document.addEventListener('click', (e) => { if (!menu.hidden && !e.target.closest('.rg-account')) setOpen(false); });
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !menu.hidden) { setOpen(false); btn.focus(); }
    });
    menu.addEventListener('click', async (e) => {
      const item = e.target.closest('button[data-action]');
      if (!item) return;
      setOpen(false);
      if (item.dataset.action === 'password') openPasswordDialog();
      if (item.dataset.action === 'logout') {
        item.disabled = true;
        await api('auth/logout', { method: 'POST' }).catch(() => {});
        location.replace('./');
      }
    });
  }

  // ---------- change own password ----------
  function openPasswordDialog() {
    let dlg = document.getElementById('pwDialog');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'pwDialog';
      dlg.className = 'dlg';
      dlg.setAttribute('aria-labelledby', 'pwTitle');
      dlg.innerHTML = `
        <form method="dialog" novalidate>
          <div class="dlg-head">
            <div><h2 id="pwTitle">Change your password</h2><p>You'll stay signed in here. Other devices will be signed out.</p></div>
            <button class="btn-x btn-x--ghost btn-x--icon dlg-x" type="button" data-close aria-label="Close" title="Close"><i class="bi bi-x-lg"></i></button>
          </div>
          <div class="dlg-body">
            <div class="alert-x" role="alert" hidden><i class="bi bi-exclamation-circle" aria-hidden="true"></i><span></span></div>
            <div class="fld">
              <label for="pwCurrent">Current password</label>
              <div class="inp"><i class="bi bi-lock" aria-hidden="true"></i><input type="password" id="pwCurrent" autocomplete="current-password" required></div>
            </div>
            <div class="fld">
              <label for="pwNew">New password</label>
              <div class="inp"><i class="bi bi-key" aria-hidden="true"></i><input type="password" id="pwNew" autocomplete="new-password" minlength="8" required></div>
              <small class="fld-hint">At least 8 characters.</small>
            </div>
            <div class="fld">
              <label for="pwConfirm">Confirm new password</label>
              <div class="inp"><i class="bi bi-key" aria-hidden="true"></i><input type="password" id="pwConfirm" autocomplete="new-password" required></div>
            </div>
          </div>
          <div class="dlg-foot">
            <button class="btn-x btn-x--ghost" type="button" data-close>Cancel</button>
            <button class="btn-x btn-x--primary" type="submit">Change password</button>
          </div>
        </form>`;
      document.body.append(dlg);
      dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dlg.close()));
      dlg.querySelector('form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const alertBox = dlg.querySelector('.alert-x');
        const fail = (msg) => { alertBox.querySelector('span').textContent = msg; alertBox.hidden = false; };
        const current = dlg.querySelector('#pwCurrent').value;
        const next = dlg.querySelector('#pwNew').value;
        if (!current) return fail('Enter your current password');
        if (next.length < 8) return fail('New password must be at least 8 characters');
        if (next !== dlg.querySelector('#pwConfirm').value) return fail("New passwords don't match");
        const submit = dlg.querySelector('[type="submit"]');
        submit.disabled = true;
        submit.textContent = 'Changing…';
        try {
          await api('auth/password', { json: { currentPassword: current, newPassword: next } });
          dlg.close();
          toast('Password changed');
        } catch (err) {
          if (err instanceof AuthError) return toLogin();
          fail(err.message);
        } finally {
          submit.disabled = false;
          submit.textContent = 'Change password';
        }
      });
    }
    dlg.querySelector('form').reset();
    dlg.querySelector('.alert-x').hidden = true;
    dlg.showModal();
    dlg.querySelector('#pwCurrent').focus();
  }

  const ready = api('auth/me').then(({ user }) => { render(user); return user; });
  ready.catch((err) => { if (err instanceof AuthError) toLogin(); });

  return { ready, api, toast, esc, AuthError, toLogin };
})();
