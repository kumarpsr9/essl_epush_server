const { pool, logTablesFor } = require('./db');
const { HttpError, today, nowIST } = require('./util');
const { syncOutpasses, passesForDay } = require('./outpasses');

const DEFAULT_DEDUP_SEC = Number(process.env.HOSTEL_DEDUP_SEC || 60);
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

function parseOptions(query) {
  const time = query.time || '23:59:59';
  if (!TIME_RE.test(time)) throw new HttpError(400, 'time must be HH:MM or HH:MM:SS');
  const dedupSeconds = query.dedupSeconds === undefined ? DEFAULT_DEDUP_SEC : Number(query.dedupSeconds);
  if (!Number.isInteger(dedupSeconds) || dedupSeconds < 0 || dedupSeconds > 600) {
    throw new HttpError(400, 'dedupSeconds must be an integer between 0 and 600');
  }
  return { asOf: `${query.date} ${time.length === 5 ? `${time}:59` : time}`, dedupSeconds };
}

// Devices only record "in", so direction comes from order: for each student, each day,
// the 1st punch is OUT of the hostel, the 2nd is back IN, 3rd OUT, and so on. The exception
// is a student away overnight on an outpass: they start the day OUT, so their 1st punch is IN.
// Repeat scans within `dedupSeconds` of the last counted punch are ignored so a
// double-scan does not flip the student's status.
//
// `scope` (a warden's DeviceIds, null for admins) limits the report to those gates: the
// roster becomes students who punched at one of them that day. Direction still counts
// every punch so a student's status matches what admins see.
async function buildHostelDay(date, query, scope = null) {
  const { asOf, dedupSeconds } = parseOptions({ ...query, date });
  const tables = await logTablesFor(date, date);
  if (date === today()) await syncOutpasses();
  // Outpass cover and lateness are judged at asOf, but never later than now (today's asOf is 23:59:59).
  const now = nowIST();
  const passes = await passesForDay(date, asOf > now ? now : asOf);

  const [students] = await pool.query(
    `SELECT EmployeeCodeInDevice AS UserId, EmployeeCode, EmployeeName, Gender, ContactNo,
            WorkPlace AS Campus, C1 AS Block, C2 AS RoomNo, C3 AS BedNo
     FROM Employees WHERE Status = 'Working' ORDER BY EmployeeName`
  );
  const [devices] = await pool.query('SELECT DeviceId, DeviceFName AS DeviceName FROM Devices ORDER BY DeviceId');
  const deviceName = new Map(devices.map((d) => [d.DeviceId, d.DeviceName]));

  let punches = [];
  if (tables.length) {
    const sql = tables
      .map((t) => `SELECT UserId, DeviceId, LogDate FROM \`${t}\` WHERE LogDate >= ? AND LogDate <= ?`)
      .join(' UNION ALL ');
    [punches] = await pool.query(`${sql} ORDER BY UserId, LogDate`, tables.flatMap(() => [date, asOf]));
  }

  // A warden marking a student "reported back" counts as an IN movement, so the
  // register agrees with the outpass even though there was no gate punch.
  const events = punches.map((p) => ({ ...p }));
  for (const [code, pass] of passes) {
    for (const r of pass.manualReturns) events.push({ UserId: code, LogDate: r.time, manual: r });
  }
  events.sort((a, b) => (a.UserId === b.UserId ? (a.LogDate < b.LogDate ? -1 : a.LogDate > b.LogDate ? 1 : 0) : a.UserId < b.UserId ? -1 : 1));

  const byStudent = new Map();
  for (const p of events) {
    if (!byStudent.has(p.UserId)) byStudent.set(p.UserId, { movements: [], ignored: 0 });
    const s = byStudent.get(p.UserId);
    const last = s.movements[s.movements.length - 1];
    if (p.manual) {
      // Only meaningful if they were out; otherwise the next punch already brought them in.
      if (last ? last.type === 'OUT' : passes.get(p.UserId)?.awayAtStart) {
        s.movements.push({
          seq: s.movements.length + 1, type: 'IN', time: p.LogDate, deviceId: null,
          deviceName: `Reported to ${p.manual.by} (${p.manual.passNo})`, manual: true,
        });
      }
      continue;
    }
    if (last && !last.manual && (Date.parse(p.LogDate) - Date.parse(last.time)) / 1000 <= dedupSeconds) {
      s.ignored += 1;
      continue;
    }
    const startsOut = passes.get(p.UserId)?.awayAtStart;
    const type = last ? (last.type === 'OUT' ? 'IN' : 'OUT') : startsOut ? 'IN' : 'OUT';
    s.movements.push({
      seq: s.movements.length + 1,
      type,
      time: p.LogDate,
      deviceId: p.DeviceId,
      deviceName: deviceName.get(p.DeviceId) || `Device ${p.DeviceId}`,
    });
  }

  const known = new Set(students.map((s) => s.UserId));
  // Punches from device users missing in Employees are still reported, not dropped.
  const unknown = [...byStudent.keys()].filter((id) => !known.has(id))
    .map((UserId) => ({ UserId, EmployeeCode: null, EmployeeName: null, Gender: null, ContactNo: null, Campus: null, Block: null, RoomNo: null, BedNo: null }));

  const rows = [...students, ...unknown].map((st) => {
    const { movements = [], ignored = 0 } = byStudent.get(st.UserId) || {};
    const last = movements[movements.length - 1];
    const outs = movements.filter((m) => m.type === 'OUT');
    const ins = movements.filter((m) => m.type === 'IN');
    const gateMoves = movements.filter((m) => !m.manual);
    const pass = passes.get(st.UserId);
    return {
      ...st,
      // No punches: in the hostel, unless away overnight on an outpass.
      status: last ? last.type : pass?.awayAtStart ? 'OUT' : 'IN',
      awayOvernight: !!pass?.awayAtStart,
      outpass: pass?.cover || null,
      hasPunches: gateMoves.length > 0,
      punchCount: gateMoves.length,
      ignoredDuplicates: ignored,
      firstOut: outs[0]?.time || null,
      lastIn: ins[ins.length - 1]?.time || null,
      lastPunch: last?.time || null,
      lastDeviceId: last?.deviceId || null,
      lastDeviceName: last?.deviceName || null,
      movements,
    };
  });

  if (!scope) return { date, asOf, dedupSeconds, devices, rows };
  const allowed = new Set(scope);
  return {
    date,
    asOf,
    dedupSeconds,
    devices: devices.filter((d) => allowed.has(d.DeviceId)),
    rows: rows.filter((r) => r.movements.some((m) => allowed.has(m.deviceId))
      || (r.outpass?.departDeviceId && allowed.has(r.outpass.departDeviceId))),
  };
}

module.exports = { buildHostelDay };
