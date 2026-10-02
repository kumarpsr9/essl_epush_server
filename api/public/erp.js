(() => {
  'use strict';

  const { api, toast, esc, AuthError, toLogin } = AppNav;
  const $ = (id) => document.getElementById(id);
  let hookUrl = `${location.origin}/hooks/students`; // replaced by PUBLIC_BASE_URL from the server when set
  const state = { keys: [], log: [], target: null };

  const num = (n) => n.toLocaleString('en-IN');
  // MySQL NOW() on the server is UTC.
  const when = (utc) => (utc
    ? new Date(`${utc.replace(' ', 'T')}Z`).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '');

  function handle(err, show) {
    if (err instanceof AuthError) return toLogin();
    show(err.message);
  }

  // Clipboard API needs https; the register is often opened over plain http on the LAN.
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const t = Object.assign(document.createElement('textarea'), { value: text });
      t.style.cssText = 'position:fixed;opacity:0';
      (document.querySelector('dialog[open]') || document.body).append(t);
      t.select();
      document.execCommand('copy');
      t.remove();
    }
    toast('Copied');
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-copy]');
    if (b) copy($(b.dataset.copy).textContent);
  });

  // ---------- static content ----------
  function renderHookUrl(configured) {
    if (configured) hookUrl = configured;
    $('hookUrl').textContent = hookUrl;
    $('hookHint').textContent = configured
      ? 'Give the ERP team this address and a key from below. It comes from PUBLIC_BASE_URL in the server\'s .env.'
      : 'PUBLIC_BASE_URL isn\'t set in the server\'s .env, so this is the address you opened this page on. If the ERP server can\'t reach it (for example localhost or a LAN address), set PUBLIC_BASE_URL and restart the API.';
    $('hookHint').classList.toggle('is-warn', !configured);
    $('exampleReq').textContent = `curl -X POST '${hookUrl}' \\
  -H 'Authorization: Bearer erp_xxxxxxxx' \\
  -H 'Content-Type: application/json' \\
  -d '{ "students": [
    { "code": "314554",
      "suc": "2601000058",
      "name": "Ravi Teja Kommana",
      "gender": "Male",
      "campus": "ACET",
      "block": "A Block",
      "room": "101", "bed": "1",
      "phone": "9876543210" },
    { "suc": "2601000071",
      "room": "102", "bed": "" }
  ] }'`;
  }
  renderHookUrl('');

  // ---------- load ----------
  async function load() {
    try {
      const data = await api('/api/webhooks');
      state.keys = data.keys;
      state.log = data.log;
      $('maxRecords').textContent = num(data.maxRecords);
      renderHookUrl(data.hookUrl);
      $('errorBox').innerHTML = '';
      renderKeys();
      renderLog();
    } catch (err) {
      handle(err, (msg) => {
        $('errorBox').innerHTML = `<div class="alert-x" role="alert" style="margin-bottom:18px"><i class="bi bi-exclamation-circle" aria-hidden="true"></i>
          <span>Couldn't load ERP sync settings: ${esc(msg)}</span>
          <button class="btn-x btn-x--ghost" type="button" data-action="retry" style="margin-left:auto">Try again</button></div>`;
      });
    } finally {
      $('main').setAttribute('aria-busy', 'false');
    }
  }

  function renderKeys() {
    if (!state.keys.length) {
      $('keyRows').innerHTML = `<tr><td colspan="4" style="white-space:normal"><div class="empty" style="padding:28px 12px"><i class="bi bi-key" aria-hidden="true"></i>
        <h4>No keys yet</h4><p>Create a key so the ERP can send student details.</p></div></td></tr>`;
      return;
    }
    $('keyRows').innerHTML = state.keys.map((k) => `
      <tr class="${k.revokedAt ? 'is-revoked' : ''}">
        <td><b>${esc(k.name)}</b><span class="sub">by ${esc(k.createdBy)}, ${when(k.createdAt)}</span></td>
        <td><code>${esc(k.prefix)}…</code></td>
        <td>${k.revokedAt ? `<span class="chip chip--muted">Revoked ${when(k.revokedAt)}</span>`
          : k.lastUsedAt ? when(k.lastUsedAt) : '<span class="zero">Not used yet</span>'}</td>
        <td style="text-align:right">${k.revokedAt ? '' : `<button class="btn-x btn-x--quiet" type="button" data-revoke="${k.id}">Revoke</button>`}</td>
      </tr>`).join('');
  }

  function cell(n, bad) {
    return `<td class="num">${n ? `<span class="${bad ? 'n-bad' : ''}">${num(n)}</span>` : '<span class="zero">0</span>'}</td>`;
  }

  function renderLog() {
    if (!state.log.length) {
      $('logRows').innerHTML = `<tr><td colspan="8" style="white-space:normal"><div class="empty" style="padding:28px 12px"><i class="bi bi-inbox" aria-hidden="true"></i>
        <h4>Nothing received yet</h4><p>Each request from the ERP will be listed here with what changed.</p></div></td></tr>`;
      return;
    }
    $('logRows').innerHTML = state.log.map((l) => {
      const result = l.status !== 200
        ? `<span class="chip chip--bad"><i class="bi bi-x-circle" aria-hidden="true"></i> Refused (${l.status})</span>`
        : l.failed
          ? `<span class="chip chip--warn"><i class="bi bi-exclamation-triangle" aria-hidden="true"></i> ${num(l.failed)} failed</span>`
          : '<span class="chip chip--good"><i class="bi bi-check-circle" aria-hidden="true"></i> Saved</span>';
      const errs = l.errors.length ? `
        <tr class="err-row"><td colspan="8"><details class="errs"><summary>${l.status === 200 ? `Show ${num(l.errors.length)} ${l.errors.length === 1 ? 'error' : 'errors'}${l.failed > l.errors.length ? ` (first ${l.errors.length} of ${num(l.failed)})` : ''}` : 'Why it was refused'}</summary>
          <ul>${l.errors.map((e) => `<li>${e.code != null ? `<code>${esc(e.code)}</code> (record ${e.index + 1}): ` : ''}${esc(e.error)}</li>`).join('')}</ul></details></td></tr>` : '';
      return `
        <tr>
          <td>${when(l.at)}${l.ip ? `<span class="sub">${esc(l.ip)}</span>` : ''}</td>
          <td>${l.keyName ? esc(l.keyName) : '<span class="zero">Unknown key</span>'}</td>
          <td>${result}</td>
          ${cell(l.received)}${cell(l.created)}${cell(l.updated)}${cell(l.unchanged)}${cell(l.failed, true)}
        </tr>${errs}`;
    }).join('');
  }

  // ---------- create key ----------
  const keyDlg = $('keyDialog');
  const keyForm = keyDlg.querySelector('form');
  const keyError = (msg) => { $('keyError').querySelector('span').textContent = msg || ''; $('keyError').hidden = !msg; };

  function openKeyDialog() {
    keyForm.reset();
    keyError('');
    $('keyAsk').hidden = false;
    $('keyShow').hidden = true;
    $('keyDlgTitle').textContent = 'Create key';
    $('keyDlgSub').textContent = 'Name it after the system that will use it.';
    $('keyCancel').hidden = false;
    $('keySubmit').textContent = 'Create key';
    keyDlg.showModal();
    $('keyName').focus();
  }

  keyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!$('keyShow').hidden) { keyDlg.close(); return; }
    const name = $('keyName').value.trim();
    if (!name) { keyError('Enter a name for the key'); $('keyName').focus(); return; }
    const btn = $('keySubmit');
    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
      const { data } = await api('/api/webhooks/keys', { json: { name } });
      $('keyValue').textContent = data.token;
      $('keyAsk').hidden = true;
      $('keyShow').hidden = false;
      $('keyDlgTitle').textContent = `Key for ${data.name}`;
      $('keyDlgSub').textContent = 'Send it to the ERP team over a private channel.';
      $('keyCancel').hidden = true;
      btn.textContent = "I've copied the key";
      load();
    } catch (err) {
      btn.textContent = 'Create key';
      handle(err, keyError);
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- revoke ----------
  const revokeDlg = $('revokeDialog');
  const revokeError = (msg) => { $('revokeError').querySelector('span').textContent = msg || ''; $('revokeError').hidden = !msg; };

  revokeDlg.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('revokeSubmit');
    btn.disabled = true;
    btn.textContent = 'Revoking…';
    try {
      await api(`/api/webhooks/keys/${state.target.id}`, { method: 'DELETE' });
      revokeDlg.close();
      toast(`Revoked ${state.target.name}`);
      load();
    } catch (err) {
      handle(err, revokeError);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Revoke key';
    }
  });

  // ---------- events ----------
  document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $('newKey').addEventListener('click', openKeyDialog);
  $('refresh').addEventListener('click', load);
  $('errorBox').addEventListener('click', (e) => { if (e.target.closest('[data-action="retry"]')) load(); });
  $('keyRows').addEventListener('click', (e) => {
    const b = e.target.closest('[data-revoke]');
    const k = b && state.keys.find((x) => String(x.id) === b.dataset.revoke);
    if (!k) return;
    state.target = k;
    revokeError('');
    $('revokeTitle').textContent = `Revoke ${k.name}?`;
    $('revokeSub').textContent = `Key ${k.prefix}…`;
    revokeDlg.showModal();
    revokeDlg.querySelector('[data-close]').focus();
  });

  AppNav.ready.then((me) => {
    if (!me.isAdmin) {
      $('main').setAttribute('aria-busy', 'false');
      $('main').innerHTML = `<div class="card-x" style="margin:24px 0"><div class="empty"><i class="bi bi-shield-lock" aria-hidden="true"></i>
        <h4>Only admins can manage ERP sync</h4><p>Ask an admin if student details from the ERP look wrong.</p>
        <a class="btn-x btn-x--primary" href="/register.html">Go to the movement register</a></div></div>`;
      return;
    }
    load();
  }).catch(() => {});
})();
