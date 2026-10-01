(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const form = $('loginForm');
  const user = $('username');
  const pass = $('password');
  const submit = $('submitBtn');
  const formError = $('formError');

  // Only follow same-origin paths after sign-in.
  function nextUrl() {
    const n = new URLSearchParams(location.search).get('next') || '';
    return n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : '/';
  }

  function showError(msg) {
    formError.querySelector('span').textContent = msg;
    formError.hidden = !msg;
  }

  function setFieldError(input, box, errEl, msg) {
    errEl.textContent = msg;
    box.classList.toggle('is-invalid', !!msg);
    input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    if (msg) input.setAttribute('aria-describedby', errEl.id);
    else input.removeAttribute('aria-describedby');
  }

  function validate() {
    const u = user.value.trim() ? '' : 'Enter your username';
    const p = pass.value ? '' : 'Enter your password';
    setFieldError(user, $('userBox'), $('userErr'), u);
    setFieldError(pass, $('passBox'), $('passErr'), p);
    if (u) user.focus(); else if (p) pass.focus();
    return !u && !p;
  }

  function setBusy(busy) {
    submit.disabled = busy;
    submit.innerHTML = busy ? '<span class="spin" aria-hidden="true"></span> Signing in…' : 'Sign in';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    if (!validate()) return;
    setBusy(true);
    try {
      const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username: user.value.trim(), password: pass.value }),
      });
      if (res.ok) { location.replace(nextUrl()); return; }
      const body = await res.json().catch(() => ({}));
      showError(body.error || `Sign-in failed (${res.status}). Try again.`);
      if (res.status === 401) { pass.value = ''; pass.focus(); }
    } catch {
      showError("Can't reach the server. Check your connection and try again.");
    }
    setBusy(false);
  });

  // Clear a field's error as soon as the user fixes it.
  user.addEventListener('input', () => { if (user.value.trim()) setFieldError(user, $('userBox'), $('userErr'), ''); });
  pass.addEventListener('input', () => { if (pass.value) setFieldError(pass, $('passBox'), $('passErr'), ''); });

  $('togglePass').addEventListener('click', (e) => {
    const show = pass.type === 'password';
    pass.type = show ? 'text' : 'password';
    e.currentTarget.textContent = show ? 'Hide' : 'Show';
    e.currentTarget.setAttribute('aria-pressed', String(show));
    pass.focus();
  });

  // Already signed in? Skip the form.
  fetch('/auth/me', { credentials: 'same-origin' })
    .then((r) => { if (r.ok) location.replace(nextUrl()); })
    .catch(() => {});
  user.focus();
})();
