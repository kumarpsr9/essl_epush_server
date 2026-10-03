(() => {
  'use strict';

  const { api, esc, AuthError, toLogin } = AppNav;
  const $ = (id) => document.getElementById(id);
  const RESUME_MS = 4000;       // after recording, go back to scanning on its own
  const SAME_CODE_MS = 3000;    // ignore the slip still in front of the camera after resuming
  const FRAME_MS = 120;         // ~8 decodes a second
  const GATE_KEY = 'scanGate';
  const RECENT_KEY = 'scanRecent';

  const state = {
    stream: null, detector: null, jsQR: null, busy: false, paused: false,
    lastCode: '', lastCodeAt: 0, result: null, resumeTimer: null,
  };

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const buzz = (p) => { try { navigator.vibrate?.(p); } catch { /* unsupported */ } };

  function showError(msg) {
    $('errorBox').innerHTML = msg
      ? `<div class="alert-x" role="alert" style="margin-bottom:14px"><i class="bi bi-exclamation-circle" aria-hidden="true"></i><span>${esc(msg)}</span></div>`
      : '';
  }

  // ---------- gates ----------
  async function loadGates() {
    try {
      const { data } = await api('api/devices');
      const saved = store.get(GATE_KEY);
      $('gate').innerHTML = data.length
        ? data.map((d) => `<option value="${d.DeviceId}"${String(d.DeviceId) === saved ? ' selected' : ''}>${esc(d.DeviceFName || `Gate ${d.DeviceId}`)}</option>`).join('')
        : '<option value="">No gate assigned</option>';
    } catch (err) {
      if (err instanceof AuthError) return toLogin();
      $('gate').innerHTML = '<option value="">Gate not set</option>';
    }
  }
  $('gate').addEventListener('change', () => store.set(GATE_KEY, $('gate').value));

  // ---------- decoding ----------
  async function decoderReady() {
    if (state.detector || state.jsQR) return;
    if ('BarcodeDetector' in window) {
      try {
        if ((await BarcodeDetector.getSupportedFormats()).includes('qr_code')) {
          state.detector = new BarcodeDetector({ formats: ['qr_code'] });
          return;
        }
      } catch { /* fall back to jsQR */ }
    }
    await new Promise((resolve, reject) => {
      const s = Object.assign(document.createElement('script'), { src: 'vendor/jsQR.js', onload: resolve, onerror: () => reject(new Error("Couldn't load the QR reader")) });
      document.head.append(s);
    });
    state.jsQR = window.jsQR;
  }

  const canvas = document.createElement('canvas');
  const ctx2d = canvas.getContext('2d', { willReadFrequently: true });
  async function decode(source, w, h) {
    if (state.detector) {
      const found = await state.detector.detect(source);
      return found[0]?.rawValue || null;
    }
    const scale = Math.min(1, 720 / Math.max(w, h));
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    ctx2d.drawImage(source, 0, 0, canvas.width, canvas.height);
    const img = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
    return state.jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' })?.data || null;
  }

  // ---------- camera ----------
  const cameraUsable = () => window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;

  function setIdle(text, showButton = true) {
    $('camIdle').hidden = false;
    $('camIdleText').textContent = text;
    $('startCam').hidden = !showButton;
    ['video', 'frame', 'camHint'].forEach((id) => { $(id).hidden = true; });
  }

  async function startCamera() {
    showError('');
    $('startCam').disabled = true;
    try {
      await decoderReady();
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false,
      });
      const v = $('video');
      v.srcObject = state.stream;
      await v.play();
      $('camIdle').hidden = true;
      ['video', 'frame', 'camHint'].forEach((id) => { $(id).hidden = false; });
      loop();
    } catch (err) {
      const denied = err.name === 'NotAllowedError';
      setIdle(denied
        ? 'Camera permission was refused. Allow the camera for this site in the browser settings, or type the pass number below.'
        : `Couldn't start the camera (${err.message || err.name}). Type the pass number below or take a photo.`);
    } finally {
      $('startCam').disabled = false;
    }
  }

  function stopCamera() {
    state.stream?.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }

  async function loop() {
    if (!state.stream) return;
    const v = $('video');
    if (!state.paused && !state.busy && v.readyState >= 2) {
      state.busy = true;
      try {
        const code = await decode(v, v.videoWidth, v.videoHeight);
        if (code) onCode(code);
      } catch { /* a bad frame; try the next one */ }
      state.busy = false;
    }
    setTimeout(() => requestAnimationFrame(loop), FRAME_MS);
  }

  // Phones on plain http can't open the camera, but a photo still works.
  $('photo').addEventListener('change', async () => {
    const file = $('photo').files[0];
    $('photo').value = '';
    if (!file) return;
    showError('');
    try {
      await decoderReady();
      const bmp = await createImageBitmap(file);
      const code = await decode(bmp, bmp.width, bmp.height);
      if (!code) { showError('No QR code found in that photo. Hold the phone closer so the code fills most of the picture.'); return; }
      onCode(code, true);
    } catch (err) {
      showError(`Couldn't read the photo: ${err.message}`);
    }
  });

  // Typed pass numbers, and USB / Bluetooth barcode scanners (they type the code and press Enter).
  $('manualForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('manual').value.trim();
    if (!v) { $('manual').focus(); return; }
    $('manual').value = '';
    onCode(v, true);
  });

  // ---------- lookup and record ----------
  function onCode(code, force = false) {
    const now = Date.now();
    if (!force && code === state.lastCode && now - state.lastCodeAt < SAME_CODE_MS) return;
    state.lastCode = code;
    state.lastCodeAt = now;
    state.paused = true;
    buzz(40);
    lookup(code);
  }

  async function lookup(code) {
    showError('');
    try {
      show(await api(`api/outpasses/scan?code=${encodeURIComponent(code)}`));
    } catch (err) {
      if (err instanceof AuthError) return toLogin();
      if (err.status !== 404) {
        // Not an answer about the pass: the server or network failed. Don't call it invalid.
        showError(`Couldn't check the pass: ${err.message}. Try again.`);
        resume();
        return;
      }
      buzz([80, 60, 80]);
      showStop(err.message.replace(/\.?$/, '.'));
    }
  }

  const ICON = { go: 'bi-box-arrow-right', back: 'bi-box-arrow-in-left', wait: 'bi-hourglass-split', stop: 'bi-x-octagon', done: 'bi-check-lg' };
  const fmtWhen = (s, now) => {
    const d = s.slice(0, 10) === now.slice(0, 10) ? 'Today'
      : new Date(`${s.slice(0, 10)}T12:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    return `${d} ${s.slice(11, 16)}`;
  };

  function band(tone, title, detail) {
    const cls = tone === 'done' ? 'go' : tone;
    return `<div class="res-band ${cls}"><i class="bi ${ICON[tone]}" aria-hidden="true"></i><div><h2>${esc(title)}</h2><p>${esc(detail)}</p></div></div>`;
  }

  function show(res, recorded = null) {
    state.result = res;
    const p = res.data;
    const v = res.scan;
    if (!recorded && v.tone === 'stop') buzz([80, 60, 80]);
    const name = p.name || p.code;
    const room = [p.block, p.room && `Room ${p.room}`, p.bed && `Bed ${p.bed}`].filter(Boolean).join(', ');
    const head = recorded
      ? band('done', recorded === 'depart' ? `Gone out at ${p.departedAt.slice(11, 16)}` : `Reported back at ${p.returnedAt.slice(11, 16)}`,
        recorded === 'depart' ? `Due back by ${fmtWhen(p.returnBy, res.now)}.` : p.lateMinutes ? `${p.lateMinutes} min late. The warden will see this.` : 'On time.')
      : band(v.tone, v.title, v.detail);
    const action = !recorded && v.next
      ? `<button class="btn-x ${v.next === 'depart' ? 'btn-x--go' : 'btn-x--primary'}" type="button" id="confirm">
          <i class="bi ${v.next === 'depart' ? 'bi-box-arrow-right' : 'bi-box-arrow-in-left'}" aria-hidden="true"></i>
          ${v.next === 'depart' ? 'Confirm going out' : 'Confirm reported back'}</button>`
      : '';
    $('result').innerHTML = `
      <div class="res">
        ${head}
        <div class="res-body">
          <div class="who">
            <span class="rg-avatar" aria-hidden="true">${esc(name.slice(0, 2))}</span>
            <div><b>${esc(name)}</b><span>${esc(p.code)}${p.suc ? ` · SUC ${esc(p.suc)}` : ''}${room ? ` · ${esc(room)}` : ''}</span></div>
          </div>
          <dl class="res-facts">
            <div><dt>Pass</dt><dd class="res-no">${esc(p.passNo)}</dd></div>
            <div><dt>Type</dt><dd>${p.type === 'leave' ? 'Leave' : 'Outing'}</dd></div>
            <div><dt>Out from</dt><dd>${fmtWhen(p.outFrom, res.now)}</dd></div>
            <div><dt>Back by</dt><dd>${fmtWhen(p.returnBy, res.now)}</dd></div>
            <div class="wide"><dt>Reason</dt><dd>${esc(p.reason)}${p.destination ? ` · ${esc(p.destination)}` : ''}</dd></div>
            ${p.approvedBy ? `<div class="wide"><dt>Approved by</dt><dd>${esc(p.approvedBy)}</dd></div>` : ''}
          </dl>
        </div>
        <div class="res-foot">
          ${action}
          <button class="btn-x btn-x--ghost" type="button" id="next"><i class="bi bi-qr-code-scan" aria-hidden="true"></i> ${recorded ? 'Scan next now' : action ? 'Cancel, scan another' : 'Scan next'}</button>
          ${recorded ? '<div class="res-next" id="countdown"></div>' : ''}
        </div>
      </div>`;
    $('scanner').hidden = true;
    $('result').hidden = false;
    $('result').scrollIntoView({ block: 'start', behavior: 'smooth' });
    $('next').addEventListener('click', resume);
    if (action) {
      $('confirm').addEventListener('click', () => record(v.next));
      $('confirm').focus();
    } else {
      $('next').focus();
    }
    if (recorded) countdown();
  }

  function showStop(msg) {
    $('result').innerHTML = `
      <div class="res">${band('stop', 'Not a valid outpass', msg)}
        <div class="res-foot" style="padding-top:16px"><button class="btn-x btn-x--ghost" type="button" id="next"><i class="bi bi-qr-code-scan" aria-hidden="true"></i> Scan again</button></div>
      </div>`;
    $('scanner').hidden = true;
    $('result').hidden = false;
    $('next').addEventListener('click', resume);
    $('next').focus();
  }

  async function record(action) {
    const btn = $('confirm');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const res = await api(`api/outpasses/${state.result.data.id}/scan`, { json: { action, deviceId: $('gate').value || null } });
      buzz(120);
      addRecent(res.data, action);
      show(res, action);
    } catch (err) {
      if (err instanceof AuthError) return toLogin();
      // Usually someone (or the student's own punch) got there first: show where the pass stands now.
      showError(err.message);
      lookup(state.result.data.passNo);
    }
  }

  function countdown() {
    clearTimeout(state.resumeTimer);
    const end = Date.now() + RESUME_MS;
    const tick = () => {
      const left = Math.ceil((end - Date.now()) / 1000);
      if (!$('countdown')) return;
      if (left <= 0) { resume(); return; }
      $('countdown').textContent = `Scanning the next pass in ${left} s`;
      state.resumeTimer = setTimeout(tick, 250);
    };
    tick();
  }

  function resume() {
    clearTimeout(state.resumeTimer);
    state.result = null;
    state.lastCodeAt = Date.now(); // the same slip may still be in view
    $('result').hidden = true;
    $('result').innerHTML = '';
    $('scanner').hidden = false;
    state.paused = false;
    if (!state.stream) $('manual').focus();
  }

  // ---------- recent (this phone, today) ----------
  function readRecent() {
    try {
      const r = JSON.parse(store.get(RECENT_KEY) || '{}');
      return r.day === todayIST() ? r.items : [];
    } catch { return []; }
  }
  function addRecent(p, action) {
    const items = [{ at: action === 'depart' ? p.departedAt : p.returnedAt, name: p.name || p.code, passNo: p.passNo, action, late: p.lateMinutes }, ...readRecent()].slice(0, 30);
    store.set(RECENT_KEY, JSON.stringify({ day: todayIST(), items }));
    renderRecent();
  }
  function renderRecent() {
    const items = readRecent();
    $('recent').innerHTML = items.length
      ? items.map((r) => `
        <li><span class="t">${esc(r.at.slice(11, 16))}</span>
          <span class="n"><b>${esc(r.name)}</b><span>${esc(r.passNo)}</span></span>
          ${r.action === 'depart'
            ? '<span class="chip chip--warn"><i class="bi bi-box-arrow-right" aria-hidden="true"></i> Out</span>'
            : `<span class="chip ${r.late ? 'chip--bad' : 'chip--good'}"><i class="bi bi-box-arrow-in-left" aria-hidden="true"></i> Back${r.late ? `, ${r.late} min late` : ''}</span>`}
        </li>`).join('')
      : '<li class="empty"><p>Students you record going out or coming back show here.</p></li>';
  }

  // ---------- start ----------
  $('startCam').addEventListener('click', startCamera);
  document.addEventListener('visibilitychange', () => {
    // Release the camera in the background; offer to restart when the guard comes back.
    if (document.hidden && state.stream) { stopCamera(); setIdle('Camera paused. Tap to start scanning again.'); }
  });
  if (!cameraUsable()) {
    setIdle(window.isSecureContext
      ? "This browser can't open the camera. Type the pass number below, or take a photo of the QR code."
      : 'The camera only works on the https address of this site. Type the pass number below, or take a photo of the QR code.', false);
  }
  renderRecent();
  AppNav.ready.then(loadGates).catch(() => {});
})();
