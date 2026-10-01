const router = require('express').Router();
const { asyncHandler, dateRange } = require('../util');
const { buildHostelDay } = require('../hostel');

function summarize(rows) {
  return {
    students: rows.length,
    in: rows.filter((r) => r.status === 'IN').length,
    out: rows.filter((r) => r.status === 'OUT').length,
    noPunches: rows.filter((r) => !r.hasPunches).length,
  };
}

// GET /api/reports/hostel/devices?date=YYYY-MM-DD[&time=HH:MM][&dedupSeconds=60]
// Students are counted under the device of their latest punch for the day.
// Students with no punches are assumed IN and counted only in totals.
router.get('/hostel/devices', asyncHandler(async (req, res) => {
  const { from: date } = dateRange({ date: req.query.date });
  const day = await buildHostelDay(date, req.query);

  const stats = new Map(day.devices.map((d) => [d.DeviceId, {
    ...d, outPunches: 0, inPunches: 0, studentsIn: 0, studentsOut: 0,
  }]));
  const statFor = (id, name) => {
    if (!stats.has(id)) stats.set(id, { DeviceId: id, DeviceName: name, outPunches: 0, inPunches: 0, studentsIn: 0, studentsOut: 0 });
    return stats.get(id);
  };
  for (const r of day.rows) {
    for (const m of r.movements) statFor(m.deviceId, m.deviceName)[m.type === 'OUT' ? 'outPunches' : 'inPunches'] += 1;
    if (r.hasPunches) statFor(r.lastDeviceId, r.lastDeviceName)[r.status === 'OUT' ? 'studentsOut' : 'studentsIn'] += 1;
  }

  res.json({
    date: day.date,
    asOf: day.asOf,
    dedupSeconds: day.dedupSeconds,
    totals: summarize(day.rows),
    devices: [...stats.values()],
  });
}));

// GET /api/reports/hostel/students?date=YYYY-MM-DD[&time=HH:MM][&status=IN|OUT]
//     [&deviceId=][&hasPunches=true|false][&search=][&movements=false]
router.get('/hostel/students', asyncHandler(async (req, res) => {
  const { from: date } = dateRange({ date: req.query.date });
  const day = await buildHostelDay(date, req.query);
  let rows = day.rows;

  const { status, deviceId, hasPunches, search } = req.query;
  if (status) rows = rows.filter((r) => r.status === String(status).toUpperCase());
  if (deviceId) rows = rows.filter((r) => r.movements.some((m) => String(m.deviceId) === String(deviceId)));
  if (hasPunches !== undefined) rows = rows.filter((r) => r.hasPunches === (hasPunches === 'true'));
  if (search) {
    const s = String(search).toLowerCase();
    rows = rows.filter((r) => [r.EmployeeName, r.EmployeeCode, r.UserId].some((v) => v && v.toLowerCase().includes(s)));
  }
  if (req.query.movements === 'false') rows = rows.map(({ movements, ...r }) => r);

  res.json({
    date: day.date,
    asOf: day.asOf,
    dedupSeconds: day.dedupSeconds,
    totals: summarize(day.rows),
    count: rows.length,
    data: rows,
  });
}));

module.exports = router;
