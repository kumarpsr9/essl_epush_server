const { pool, logTablesFor } = require('./db');
const { HttpError } = require('./util');

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
// the 1st punch is OUT of the hostel, the 2nd is back IN, 3rd OUT, and so on.
// Repeat scans within `dedupSeconds` of the last counted punch are ignored so a
// double-scan does not flip the student's status.
async function buildHostelDay(date, query) {
  const { asOf, dedupSeconds } = parseOptions({ ...query, date });
  const tables = await logTablesFor(date, date);

  const [students] = await pool.query(
    `SELECT EmployeeCodeInDevice AS UserId, EmployeeCode, EmployeeName, Gender, ContactNo
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

  const byStudent = new Map();
  for (const p of punches) {
    if (!byStudent.has(p.UserId)) byStudent.set(p.UserId, { movements: [], ignored: 0 });
    const s = byStudent.get(p.UserId);
    const last = s.movements[s.movements.length - 1];
    if (last && (Date.parse(p.LogDate) - Date.parse(last.time)) / 1000 <= dedupSeconds) {
      s.ignored += 1;
      continue;
    }
    const seq = s.movements.length + 1;
    s.movements.push({
      seq,
      type: seq % 2 === 1 ? 'OUT' : 'IN',
      time: p.LogDate,
      deviceId: p.DeviceId,
      deviceName: deviceName.get(p.DeviceId) || `Device ${p.DeviceId}`,
    });
  }

  const known = new Set(students.map((s) => s.UserId));
  // Punches from device users missing in Employees are still reported, not dropped.
  const unknown = [...byStudent.keys()].filter((id) => !known.has(id))
    .map((UserId) => ({ UserId, EmployeeCode: null, EmployeeName: null, Gender: null, ContactNo: null }));

  const rows = [...students, ...unknown].map((st) => {
    const { movements = [], ignored = 0 } = byStudent.get(st.UserId) || {};
    const last = movements[movements.length - 1];
    const outs = movements.filter((m) => m.type === 'OUT');
    const ins = movements.filter((m) => m.type === 'IN');
    return {
      ...st,
      status: !last ? 'IN' : last.type,
      hasPunches: movements.length > 0,
      punchCount: movements.length,
      ignoredDuplicates: ignored,
      firstOut: outs[0]?.time || null,
      lastIn: ins[ins.length - 1]?.time || null,
      lastPunch: last?.time || null,
      lastDeviceId: last?.deviceId || null,
      lastDeviceName: last?.deviceName || null,
      movements,
    };
  });

  return { date, asOf, dedupSeconds, devices, rows };
}

module.exports = { buildHostelDay };
