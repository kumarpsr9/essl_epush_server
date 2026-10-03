const crypto = require('crypto');
const QRCode = require('qrcode');
const router = require('express').Router();
const { pool } = require('../db');
const { HttpError, asyncHandler, nowIST, today } = require('../util');
const {
  PASS_SELECT, decorate, syncOutpasses, lastPunchToday, scanVerdict, addMin, LEAVE_EARLY_MIN,
} = require('../outpasses');

// Admins and wardens can issue and manage outpasses.

const TYPES = ['outing', 'leave'];
const DT_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LEAVE_DAYS = 30;

function parseDateTime(v, label) {
  const s = String(v || '').trim();
  if (!DT_RE.test(s) || Number.isNaN(Date.parse(s.replace(' ', 'T')))) throw new HttpError(400, `Enter a valid ${label}`);
  const t = s.replace('T', ' ');
  return t.length === 16 ? `${t}:00` : t;
}

async function findPass(id) {
  const [rows] = await pool.query(`${PASS_SELECT} WHERE o.Id = ?`, [id]);
  if (!rows.length) throw new HttpError(404, 'Outpass not found');
  return decorate(rows[0]);
}

// GET /api/outpasses?view=open|history[&from=YYYY-MM-DD&to=YYYY-MM-DD]
//   open    — every pass not yet closed (issued, out or overdue), any date
//   history — passes starting between from and to (default today), any state
router.get('/', asyncHandler(async (req, res) => {
  await syncOutpasses();
  const now = nowIST();
  const view = req.query.view === 'history' ? 'history' : 'open';
  let rows;
  if (view === 'open') {
    [rows] = await pool.query(
      `${PASS_SELECT} WHERE o.Cancelled = 0 AND o.ReturnedAt IS NULL AND (o.DepartedAt IS NOT NULL OR o.ReturnBy >= ?)
       ORDER BY o.ReturnBy`,
      [now]
    );
  } else {
    const from = DATE_RE.test(req.query.from || '') ? req.query.from : today();
    const to = DATE_RE.test(req.query.to || '') ? req.query.to : from;
    if (to < from) throw new HttpError(400, 'from must be on or before to');
    [rows] = await pool.query(
      `${PASS_SELECT} WHERE o.OutFrom >= ? AND o.OutFrom < DATE_ADD(?, INTERVAL 1 DAY) ORDER BY o.OutFrom DESC LIMIT 2000`,
      [from, to]
    );
  }

  // Today's numbers for the summary tiles.
  const day = today();
  const [[t]] = await pool.query(
    `SELECT
       SUM(Cancelled = 0 AND IssuedAt >= ?) AS issuedToday,
       SUM(Cancelled = 0 AND ReturnedAt >= ?) AS returnedToday,
       SUM(Cancelled = 0 AND ReturnedAt >= ? AND ReturnedAt > ReturnBy) AS lateToday
     FROM Outpasses WHERE IssuedAt >= DATE_SUB(?, INTERVAL ${MAX_LEAVE_DAYS} DAY)`,
    [day, day, day, day]
  );
  res.json({
    now,
    view,
    data: rows.map((r) => decorate(r, now)),
    today: { issued: Number(t.issuedToday || 0), returned: Number(t.returnedToday || 0), late: Number(t.lateToday || 0) },
  });
}));

// The slip's QR code holds md5("<passNo>,<suc>") so the gate can check a printed pass.
const qrCode = (p) => crypto.createHash('md5').update(`${p.passNo},${p.suc || ''}`).digest('hex');

// ---------- gate scanning ----------
// Security scans the slip's QR (or types the pass number) when a student goes out and
// again when they come back. The server decides the one thing that may happen next, so
// two guards, or a guard and the student's own device punch, can't record it twice.

const QR_RE = /^[0-9a-f]{32}$/i;
const QR_LOOKBACK_DAYS = 60; // the QR is matched by hash, so only recent passes are searched

async function findByCode(raw) {
  const code = String(raw || '').trim();
  if (!code) throw new HttpError(400, 'Scan a QR code or type a pass number');
  const [rows] = QR_RE.test(code)
    ? await pool.query(
      `${PASS_SELECT} WHERE o.IssuedAt >= DATE_SUB(?, INTERVAL ${QR_LOOKBACK_DAYS} DAY)
         AND MD5(CONCAT(o.PassNo, ',', COALESCE(e.EmployeeRFIDNumber, ''))) = ? ORDER BY o.Id DESC LIMIT 1`,
      [nowIST(), code.toLowerCase()]
    )
    : await pool.query(`${PASS_SELECT} WHERE o.PassNo = ? LIMIT 1`, [code.toUpperCase().replace(/\s+/g, '')]);
  if (!rows.length) {
    throw new HttpError(404, QR_RE.test(code)
      ? "This QR code doesn't match any outpass. If the student's SUC changed after printing, type the pass number instead"
      : `No outpass numbered ${code}`);
  }
  return decorate(rows[0]);
}

const scanResult = (p, now = nowIST()) => ({ data: p, scan: scanVerdict(p, now), now });

// The gate the guard is standing at, if any; wardens may only use their own gates.
async function scanGate(req) {
  const raw = req.body?.deviceId;
  if (raw === undefined || raw === null || raw === '') return null;
  const id = Number(raw);
  const scope = req.user.deviceIds;
  if (!Number.isInteger(id) || (scope && !scope.includes(id))) throw new HttpError(403, "You can't record scans at that gate");
  const [[d]] = await pool.query('SELECT DeviceId FROM Devices WHERE DeviceId = ?', [id]);
  if (!d) throw new HttpError(400, 'Unknown gate');
  return id;
}

// GET /api/outpasses/scan?code=<QR code or pass number>
router.get('/scan', asyncHandler(async (req, res) => {
  await syncOutpasses(); // a punch the student already made decides what the scan may do
  res.json(scanResult(await findByCode(req.query.code)));
}));

// POST /api/outpasses/:id/scan { action: 'depart'|'return', deviceId? }
router.post('/:id/scan', asyncHandler(async (req, res) => {
  const action = req.body?.action;
  if (action !== 'depart' && action !== 'return') throw new HttpError(400, 'action must be depart or return');
  const gate = await scanGate(req);
  await syncOutpasses();
  const p = await findPass(req.params.id);
  const now = nowIST();
  const verdict = scanVerdict(p, now);
  if (verdict.next !== action) throw new HttpError(409, `${verdict.title}. ${verdict.detail}`);

  const [r] = action === 'depart'
    ? await pool.query(
      `UPDATE Outpasses SET DepartedAt = ?, DepartDeviceId = ?, DepartSource = 'scan', DepartedBy = ?
       WHERE Id = ? AND Cancelled = 0 AND DepartedAt IS NULL AND ReturnedAt IS NULL`,
      [now, gate, req.user.name, p.id]
    )
    : await pool.query(
      `UPDATE Outpasses SET ReturnedAt = ?, ReturnDeviceId = ?, ReturnSource = 'scan', ReturnedBy = ?
       WHERE Id = ? AND Cancelled = 0 AND DepartedAt IS NOT NULL AND ReturnedAt IS NULL`,
      [now, gate, req.user.name, p.id]
    );
  if (!r.affectedRows) throw new HttpError(409, 'Someone else recorded this pass a moment ago. Scan it again to see where it stands');
  res.json({ ...scanResult(await findPass(p.id), now), recorded: action });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  await syncOutpasses();
  const p = await findPass(req.params.id);
  res.json({ data: { ...p, qrCode: qrCode(p) } });
}));

router.get('/:id/qr.svg', asyncHandler(async (req, res) => {
  const p = await findPass(req.params.id);
  const svg = await QRCode.toString(qrCode(p), { type: 'svg', errorCorrectionLevel: 'M', margin: 2, color: { dark: '#012970', light: '#ffffff' } });
  res.type('image/svg+xml').set('Cache-Control', 'private, no-store').send(svg);
}));

// POST /api/outpasses { code (roll number or SUC), type, reason, destination, approvedBy, outFrom, returnBy }
// approvedBy: who allowed the student to go (parent, HOD, chief warden…), separate from the issuing user.
router.post('/', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const code = String(b.code || '').trim();
  const [[student]] = await pool.query(
    "SELECT EmployeeCodeInDevice AS code, EmployeeName AS name FROM Employees WHERE (EmployeeCode = ? OR EmployeeCodeInDevice = ? OR EmployeeRFIDNumber = ?) AND Status = 'Working' LIMIT 1",
    [code, code, code]
  );
  if (!student) throw new HttpError(404, 'Pick a student from the list');
  const type = String(b.type || '');
  if (!TYPES.includes(type)) throw new HttpError(400, 'Type must be outing or leave');
  const reason = String(b.reason || '').trim().replace(/\s+/g, ' ');
  if (!reason) throw new HttpError(400, 'Enter the reason for going out');
  if (reason.length > 255) throw new HttpError(400, 'Reason must be 255 characters or fewer');
  const destination = String(b.destination || '').trim().replace(/\s+/g, ' ');
  if (destination.length > 255) throw new HttpError(400, 'Destination must be 255 characters or fewer');
  const approvedBy = String(b.approvedBy || '').trim().replace(/\s+/g, ' ');
  if (!approvedBy) throw new HttpError(400, 'Enter who approved this outpass');
  if (approvedBy.length > 100) throw new HttpError(400, 'Approved by must be 100 characters or fewer');

  const now = nowIST();
  const outFrom = parseDateTime(b.outFrom, 'leaving time');
  const returnBy = parseDateTime(b.returnBy, 'return time');
  if (returnBy <= outFrom) throw new HttpError(400, 'Return time must be after the leaving time');
  if (returnBy <= now) throw new HttpError(400, 'Return time is already past');
  if (outFrom < addMin(now, -12 * 60)) throw new HttpError(400, 'Leaving time can be at most 12 hours ago');
  if (type === 'outing' && outFrom.slice(0, 10) !== returnBy.slice(0, 10)) {
    throw new HttpError(400, 'An outing must end the same day. Choose leave for overnight stays');
  }
  if (Date.parse(returnBy.replace(' ', 'T')) - Date.parse(outFrom.replace(' ', 'T')) > MAX_LEAVE_DAYS * 86_400_000) {
    throw new HttpError(400, `An outpass can be at most ${MAX_LEAVE_DAYS} days`);
  }

  await syncOutpasses();
  const [[open]] = await pool.query(
    `SELECT PassNo FROM Outpasses WHERE StudentCode = ? AND Cancelled = 0 AND ReturnedAt IS NULL
       AND (DepartedAt IS NOT NULL OR ReturnBy >= ?) LIMIT 1`,
    [student.code, now]
  );
  if (open) throw new HttpError(409, `${student.name} already has an open outpass (${open.PassNo}). Close or extend it instead`);

  // Issued after the student already went out today: count that punch as leaving.
  const last = await lastPunchToday(student.code);
  const retro = last?.isOut && last.LogDate < addMin(outFrom, -LEAVE_EARLY_MIN) ? last : null;

  const [r] = await pool.query(
    `INSERT INTO Outpasses (StudentCode, Type, Reason, Destination, ApprovedBy, OutFrom, ReturnBy, IssuedBy, IssuedAt, DepartedAt, DepartDeviceId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [student.code, type, reason, destination || null, approvedBy, outFrom, returnBy, req.user.name, now, retro?.LogDate || null, retro?.DeviceId || null]
  );
  const passNo = `OP${now.slice(2, 4)}${now.slice(5, 7)}${now.slice(8, 10)}-${String(r.insertId).padStart(4, '0')}`;
  await pool.query('UPDATE Outpasses SET PassNo = ? WHERE Id = ?', [passNo, r.insertId]);
  await syncOutpasses();
  res.status(201).json({ data: await findPass(r.insertId) });
}));

// POST /api/outpasses/:id/return { at?, note? } — the student reported back without a gate punch.
router.post('/:id/return', asyncHandler(async (req, res) => {
  const p = await findPass(req.params.id);
  if (p.state === 'cancelled') throw new HttpError(400, 'This outpass was cancelled');
  if (p.state === 'returned') throw new HttpError(400, `Already reported back at ${p.returnedAt.slice(11, 16)}`);
  const now = nowIST();
  const at = req.body?.at ? parseDateTime(req.body.at, 'reporting time') : now;
  if (at > addMin(now, 1)) throw new HttpError(400, "Reporting time can't be in the future");
  if (p.departedAt && at <= p.departedAt) throw new HttpError(400, `Reporting time must be after they left at ${p.departedAt.slice(11, 16)}`);
  const note = String(req.body?.note || '').trim().slice(0, 255);
  await pool.query(
    `UPDATE Outpasses SET ReturnedAt = ?, ReturnSource = 'manual', ReturnedBy = ?, ReturnNote = ?,
       DepartSource = IF(DepartedAt IS NULL, 'manual', DepartSource), DepartedAt = COALESCE(DepartedAt, ?)
     WHERE Id = ? AND ReturnedAt IS NULL`,
    [at, req.user.name, note || null, p.outFrom < at ? p.outFrom : at, p.id]
  );
  res.json({ data: await findPass(p.id) });
}));

// POST /api/outpasses/:id/extend { returnBy }
router.post('/:id/extend', asyncHandler(async (req, res) => {
  const p = await findPass(req.params.id);
  if (!['issued', 'out', 'overdue'].includes(p.state)) throw new HttpError(400, 'Only open outpasses can be extended');
  const returnBy = parseDateTime(req.body?.returnBy, 'new return time');
  if (returnBy <= p.returnBy) throw new HttpError(400, 'The new return time must be later than the current one');
  if (returnBy <= nowIST()) throw new HttpError(400, 'The new return time is already past');
  const type = p.type === 'outing' && returnBy.slice(0, 10) !== p.outFrom.slice(0, 10) ? 'leave' : p.type;
  await pool.query('UPDATE Outpasses SET ReturnBy = ?, Type = ?, ExtendedBy = ? WHERE Id = ?', [returnBy, type, req.user.name, p.id]);
  res.json({ data: await findPass(p.id) });
}));

// POST /api/outpasses/:id/cancel — only before the student leaves.
router.post('/:id/cancel', asyncHandler(async (req, res) => {
  await syncOutpasses();
  const p = await findPass(req.params.id);
  if (p.state !== 'issued' && p.state !== 'unused') {
    throw new HttpError(400, p.departedAt ? `Can't cancel: they left at ${p.departedAt.slice(11, 16)}. Mark them reported back instead` : 'This outpass is already closed');
  }
  await pool.query('UPDATE Outpasses SET Cancelled = 1, CancelledBy = ?, CancelledAt = ? WHERE Id = ?', [req.user.name, nowIST(), p.id]);
  res.json({ data: await findPass(p.id) });
}));

module.exports = router;
