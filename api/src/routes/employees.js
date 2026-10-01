const router = require('express').Router();
const { pool } = require('../db');
const { HttpError, asyncHandler, pagination } = require('../util');
const { queryLogs } = require('./logs');

// Never expose LoginPassword / EmployeeDevicePassword.
const EMPLOYEE_COLUMNS = `EmployeeId, EmployeeName, EmployeeCode, EmployeeCodeInDevice, Gender,
  Designation, DepartmentId, CompanyId, CategoryId, EmployeeRFIDNumber, EmployementType, Status,
  ContactNo, Email, Location, DOJ`;

router.get('/', asyncHandler(async (req, res) => {
  const { page, limit, offset } = pagination(req.query);
  const where = [];
  const params = [];
  if (req.query.search) {
    where.push('(EmployeeName LIKE ? OR EmployeeCode LIKE ? OR EmployeeCodeInDevice LIKE ?)');
    const s = `%${req.query.search}%`;
    params.push(s, s, s);
  }
  if (req.query.status) {
    where.push('Status = ?');
    params.push(req.query.status);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM Employees ${whereSql}`, params);
  const [rows] = await pool.query(
    `SELECT ${EMPLOYEE_COLUMNS} FROM Employees ${whereSql} ORDER BY EmployeeName LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  res.json({ data: rows, page, limit, total });
}));

// :code accepts either EmployeeCode or the device user id (EmployeeCodeInDevice).
async function findEmployee(code) {
  const [rows] = await pool.query(
    `SELECT ${EMPLOYEE_COLUMNS} FROM Employees WHERE EmployeeCode = ? OR EmployeeCodeInDevice = ? LIMIT 1`,
    [code, code]
  );
  if (!rows.length) throw new HttpError(404, 'Employee not found');
  return rows[0];
}

router.get('/:code', asyncHandler(async (req, res) => {
  res.json({ data: await findEmployee(req.params.code) });
}));

router.get('/:code/logs', asyncHandler(async (req, res) => {
  const employee = await findEmployee(req.params.code);
  const result = await queryLogs({ ...req.query, userId: employee.EmployeeCodeInDevice });
  res.json({ employee, ...result });
}));

module.exports = router;
