const router = require('express').Router();
const { pool } = require('../db');
const { hashPassword, validatePassword } = require('../auth');
const { HttpError, asyncHandler } = require('../util');

// Mounted behind requireAdmin: only admins reach these routes.

const ROLES = ['admin', 'warden'];
const NAME_RE = /^[A-Za-z0-9._-]{3,50}$/;

async function listUsers() {
  const [users] = await pool.query('SELECT UserId, LoginName, IsAdmin FROM Users ORDER BY IsAdmin DESC, LoginName');
  const [maps] = await pool.query('SELECT LoginName, DeviceId FROM UserDevices ORDER BY DeviceId');
  const byName = new Map();
  for (const m of maps) {
    if (!byName.has(m.LoginName)) byName.set(m.LoginName, []);
    byName.get(m.LoginName).push(m.DeviceId);
  }
  return users.map((u) => ({
    id: u.UserId,
    name: u.LoginName,
    role: u.IsAdmin ? 'admin' : 'warden',
    deviceIds: u.IsAdmin ? [] : byName.get(u.LoginName) || [],
  }));
}

async function findById(id) {
  const [rows] = await pool.query('SELECT UserId, LoginName, IsAdmin FROM Users WHERE UserId = ? LIMIT 1', [id]);
  if (!rows.length) throw new HttpError(404, 'User not found');
  return rows[0];
}

async function adminCount() {
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM Users WHERE IsAdmin = 1');
  return n;
}

function parseRole(role) {
  if (!ROLES.includes(role)) throw new HttpError(400, 'Role must be admin or warden');
  return role;
}

// Wardens must be mapped to at least one existing gate.
async function parseDeviceIds(role, ids) {
  if (role === 'admin') return [];
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number))];
  if (!list.length || list.some((n) => !Number.isInteger(n))) {
    throw new HttpError(400, 'Pick at least one gate for a warden');
  }
  const [rows] = await pool.query('SELECT DeviceId FROM Devices WHERE DeviceId IN (?)', [list]);
  if (rows.length !== list.length) throw new HttpError(400, 'One or more selected gates no longer exist');
  return list;
}

async function saveDevices(conn, loginName, deviceIds) {
  await conn.query('DELETE FROM UserDevices WHERE LoginName = ?', [loginName]);
  if (deviceIds.length) {
    await conn.query('INSERT INTO UserDevices (LoginName, DeviceId) VALUES ?', [deviceIds.map((d) => [loginName, d])]);
  }
}

router.get('/', asyncHandler(async (req, res) => {
  res.json({ data: await listUsers() });
}));

// POST /api/users { username, password, role, deviceIds }
router.post('/', asyncHandler(async (req, res) => {
  const name = String(req.body?.username || '').trim();
  if (!NAME_RE.test(name)) {
    throw new HttpError(400, 'Username must be 3–50 characters: letters, numbers, dot, dash or underscore');
  }
  const password = validatePassword(req.body?.password);
  const role = parseRole(req.body?.role);
  const deviceIds = await parseDeviceIds(role, req.body?.deviceIds);

  const [exists] = await pool.query('SELECT 1 FROM Users WHERE LoginName = ? LIMIT 1', [name]);
  if (exists.length) throw new HttpError(409, `A user named "${name}" already exists`);

  const isAdmin = role === 'admin' ? 1 : 0;
  const [result] = await pool.query(
    'INSERT INTO Users (LoginName, LoginPassword, RoleName, IsAdmin, AccessI) VALUES (?, ?, ?, ?, ?)',
    [name, hashPassword(password), role === 'admin' ? 'Admin' : 'Warden', isAdmin, isAdmin]
  );
  await saveDevices(pool, name, deviceIds);
  res.status(201).json({ data: { id: result.insertId, name, role, deviceIds } });
}));

// PATCH /api/users/:id { role, deviceIds }
router.patch('/:id', asyncHandler(async (req, res) => {
  const user = await findById(req.params.id);
  const role = parseRole(req.body?.role);
  const deviceIds = await parseDeviceIds(role, req.body?.deviceIds);

  if (user.IsAdmin && role !== 'admin') {
    if (user.LoginName === req.user.name) throw new HttpError(400, "You can't remove your own admin role");
    if (await adminCount() <= 1) throw new HttpError(400, 'There must be at least one admin');
  }

  const isAdmin = role === 'admin' ? 1 : 0;
  await pool.query('UPDATE Users SET RoleName = ?, IsAdmin = ?, AccessI = ? WHERE UserId = ?',
    [role === 'admin' ? 'Admin' : 'Warden', isAdmin, isAdmin, user.UserId]);
  await saveDevices(pool, user.LoginName, deviceIds);
  res.json({ data: { id: user.UserId, name: user.LoginName, role, deviceIds } });
}));

// PUT /api/users/:id/password { password } — signs that user out everywhere.
router.put('/:id/password', asyncHandler(async (req, res) => {
  const user = await findById(req.params.id);
  if (user.LoginName === req.user.name) throw new HttpError(400, 'Change your own password from your account menu');
  const password = validatePassword(req.body?.password);
  await pool.query('UPDATE Users SET LoginPassword = ? WHERE UserId = ?', [hashPassword(password), user.UserId]);
  res.status(204).end();
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const user = await findById(req.params.id);
  if (user.LoginName === req.user.name) throw new HttpError(400, "You can't delete your own account");
  if (user.IsAdmin && await adminCount() <= 1) throw new HttpError(400, 'There must be at least one admin');
  await pool.query('DELETE FROM Users WHERE UserId = ?', [user.UserId]);
  await pool.query('DELETE FROM UserDevices WHERE LoginName = ?', [user.LoginName]);
  res.status(204).end();
}));

module.exports = router;
