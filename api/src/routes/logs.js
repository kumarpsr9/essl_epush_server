const router = require('express').Router();
const { pool, logTablesFor } = require('../db');
const { asyncHandler, dateRange, pagination } = require('../util');

// Builds a UNION ALL over the monthly DeviceLogs_<M>_<YYYY> tables covering the range.
// `scope` is the caller's allowed DeviceIds (null = every gate).
async function logsUnion(query, columns, scope = null) {
  const { from, to } = dateRange(query);
  const tables = scope && !scope.length ? [] : await logTablesFor(from, to);
  const where = ['LogDate >= ?', 'LogDate < DATE_ADD(?, INTERVAL 1 DAY)'];
  const params = [from, to];
  if (query.userId) { where.push('UserId = ?'); params.push(query.userId); }
  if (query.deviceId) { where.push('DeviceId = ?'); params.push(query.deviceId); }
  if (scope) { where.push('DeviceId IN (?)'); params.push(scope); }
  const sql = tables
    .map((t) => `SELECT ${columns} FROM \`${t}\` WHERE ${where.join(' AND ')}`)
    .join(' UNION ALL ');
  return { from, to, tables, sql, params: tables.flatMap(() => params) };
}

async function queryLogs(query, scope = null) {
  const { page, limit, offset } = pagination(query, { defaultLimit: 100, maxLimit: 1000 });
  const u = await logsUnion(query, 'DeviceLogId, DeviceId, UserId, LogDate, Direction, AttDirection, WorkCode', scope);
  if (!u.tables.length) return { from: u.from, to: u.to, data: [], page, limit, total: 0 };

  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM (${u.sql}) l`, u.params);
  const [rows] = await pool.query(
    `SELECT l.*, e.EmployeeName, e.EmployeeCode, d.DeviceFName AS DeviceName
     FROM (${u.sql}) l
     LEFT JOIN Employees e ON e.EmployeeCodeInDevice = l.UserId
     LEFT JOIN Devices d ON d.DeviceId = l.DeviceId
     ORDER BY l.LogDate DESC, l.DeviceLogId DESC
     LIMIT ? OFFSET ?`,
    [...u.params, limit, offset]
  );
  return { from: u.from, to: u.to, data: rows, page, limit, total };
}

// GET /api/logs?from=YYYY-MM-DD&to=YYYY-MM-DD&userId=&deviceId=&page=&limit=
router.get('/', asyncHandler(async (req, res) => {
  res.json(await queryLogs(req.query, req.user.deviceIds));
}));

// GET /api/logs/summary?date=YYYY-MM-DD  — first/last punch per person per day.
router.get('/summary', asyncHandler(async (req, res) => {
  const u = await logsUnion(req.query, 'DeviceId, UserId, LogDate, Direction', req.user.deviceIds);
  if (!u.tables.length) return res.json({ from: u.from, to: u.to, data: [] });
  const [rows] = await pool.query(
    `SELECT DATE(l.LogDate) AS Date, l.UserId, e.EmployeeName, e.EmployeeCode,
            MIN(l.LogDate) AS FirstPunch, MAX(l.LogDate) AS LastPunch,
            SUBSTRING_INDEX(GROUP_CONCAT(l.Direction ORDER BY l.LogDate DESC), ',', 1) AS LastDirection,
            COUNT(*) AS Punches
     FROM (${u.sql}) l
     LEFT JOIN Employees e ON e.EmployeeCodeInDevice = l.UserId
     GROUP BY DATE(l.LogDate), l.UserId, e.EmployeeName, e.EmployeeCode
     ORDER BY Date DESC, e.EmployeeName`,
    u.params
  );
  res.json({ from: u.from, to: u.to, data: rows });
}));

module.exports = router;
module.exports.queryLogs = queryLogs;
