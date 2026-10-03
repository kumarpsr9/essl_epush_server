(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = (s) => {
    if (!s) return '';
    const d = new Date(`${s.slice(0, 10)}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
    return `${s.slice(11, 16)}, ${d}`;
  };
  const STATE = {
    issued: '', out: 'Out', overdue: 'Overdue', returned: 'Reported back', cancelled: 'Cancelled', unused: 'Not used',
  };

  $('print').addEventListener('click', () => window.print());

  const id = new URLSearchParams(location.search).get('id');
  fetch(`api/outpasses/${encodeURIComponent(id || '')}`, { credentials: 'same-origin' })
    .then(async (res) => {
      if (res.status === 401) {
        location.replace(`./?next=${encodeURIComponent(location.pathname + location.search)}`);
        return;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      render(body.data);
    })
    .catch((err) => {
      $('slip').innerHTML = `<div class="empty"><i class="bi bi-ticket-perforated" aria-hidden="true"></i><h4>Outpass not found</h4><p>${esc(err.message)}. Open it again from the outpasses list.</p></div>`;
    })
    .finally(() => $('slip').setAttribute('aria-busy', 'false'));

  function render(p) {
    document.title = `${p.passNo} · ${p.name || p.code}`;
    const room = [p.campus, p.block, p.room && `Room ${p.room}`, p.bed && `Bed ${p.bed}`].filter(Boolean).map(esc).join(' · ');
    const status = STATE[p.state]
      ? `<div class="alert-x ${p.state === 'returned' ? 'alert-x--ok' : 'alert-x--note'} state"><i class="bi bi-info-circle" aria-hidden="true"></i><span>${STATE[p.state]}${
        p.state === 'returned' ? ` at ${esc(when(p.returnedAt))}` : p.departedAt ? `, left at ${esc(when(p.departedAt))}` : ''}</span></div>`
      : '';
    $('slip').innerHTML = `
      <div class="slip-head">
        <i class="bi bi-building" aria-hidden="true"></i>
        <div><b>Aditya Hostels</b><small>Student movement register</small></div>
        <div class="slip-kind"><span class="t">${p.type === 'leave' ? 'Leave pass' : 'Outpass'}</span><span class="no">${esc(p.passNo)}</span></div>
      </div>
      <div class="slip-body">
        <div class="who">
          <span class="rg-avatar" aria-hidden="true">${esc((p.name || p.code).slice(0, 2))}</span>
          <div><h1>${esc(p.name || p.code)}</h1><div class="meta">Roll no. ${esc(p.code)}${p.suc ? ` · SUC ${esc(p.suc)}` : ''}${room ? ` · ${room}` : ''}</div></div>
        </div>
        <dl class="window">
          <div><dt>Leaves from</dt><dd>${esc(when(p.outFrom))}</dd></div>
          <i class="bi bi-arrow-right arrow" aria-hidden="true"></i>
          <div class="back"><dt>Back by</dt><dd>${esc(when(p.returnBy))}</dd></div>
        </dl>
        ${status}
        <dl class="facts">
          <div class="wide"><dt>Reason</dt><dd>${esc(p.reason)}</dd></div>
          ${p.destination ? `<div class="wide"><dt>Going to</dt><dd>${esc(p.destination)}</dd></div>` : ''}
          <div><dt>Approved by</dt><dd>${esc(p.approvedBy || '—')}</dd></div>
          <div><dt>Mobile</dt><dd>${esc(p.phone || '—')}</dd></div>
          <div class="wide"><dt>Issued by</dt><dd>${esc(p.issuedBy)}, ${esc(when(p.issuedAt))}</dd></div>
        </dl>
        <div class="qr">
          <img src="api/outpasses/${encodeURIComponent(p.id)}/qr.svg" width="116" height="116" alt="QR code for outpass ${esc(p.passNo)}">
          <div><b>Show at the gate</b><span>Security scans this when you go out and when you come back.</span><code>${esc(p.qrCode)}</code></div>
        </div>
      </div>
      <div class="signs"><div>Student</div><div>Warden</div><div>Security, going out</div><div>Security, coming back</div></div>
      <div class="foot">Punch at the gate when leaving and when coming back. Report to the warden if you'll be late.</div>`;
  }
})();
