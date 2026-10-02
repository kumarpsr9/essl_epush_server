const router = require('express').Router();
const { pool } = require('../db');
const { HttpError, asyncHandler, nowIST, today } = require('../util');
const {
  PASS_SELECT, decorate, syncOutpasses, lastPunchToday, addMin, LEAVE_EARLY_MIN,
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

router.get('/:id', asyncHandler(async (req, res) => {
  await syncOutpasses();
  res.json({ data: await findPass(req.params.id) });
}));

// POST /api/outpasses { code, type, reason, destination, approvedBy, outFrom, returnBy }
// approvedBy: who allowed the student to go (parent, HOD, chief warden…), separate from the issuing user.
router.post('/', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const code = String(b.code || '').trim();
  const [[student]] = await pool.query(
    "SELECT EmployeeCodeInDevice AS code, EmployeeName AS name FROM Employees WHERE (EmployeeCode = ? OR EmployeeCodeInDevice = ?) AND Status = 'Working' LIMIT 1",
    [code, code]
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
       DepartedAt = COALESCE(DepartedAt, ?) WHERE Id = ? AND ReturnedAt IS NULL`,
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
