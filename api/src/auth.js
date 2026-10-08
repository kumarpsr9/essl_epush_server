const crypto = require('crypto');
const express = require('express');
const { pool } = require('./db');
const { apiKey, sessionSecret, sessionHours } = require('./config');
const { HttpError, asyncHandler } = require('./util');

const COOKIE = 'epush_session';
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60_000;

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex').toUpperCase();
const hmac = (s) => crypto.createHmac('sha256', sessionSecret).update(s).digest('base64url');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ePush stores LoginPassword as an uppercase MD5 hex digest; older installs may hold plain text.
function passwordMatches(stored, given) {
  if (/^[0-9a-f]{32}$/i.test(stored)) return safeEqual(stored.toUpperCase(), md5(given));
  return safeEqual(stored, given);
}

// Ties a session to the current password, so changing it in ePush signs out existing sessions.
const fingerprint = (user) => hmac(`pw:${user.LoginPassword}`).slice(0, 16);

async function findUser(loginName) {
  const [rows] = await pool.query(
    'SELECT UserId, LoginName, LoginPassword, RoleName, IsAdmin FROM Users WHERE LoginName = ? LIMIT 1',
    [loginName]
  );
  return rows[0] || null;
}

// Two roles: admins see every gate and manage users; wardens see only the gates mapped to them.
// Accounts created in ePush itself (IsAdmin = 1) count as admins.
const roleOf = (u) => (u.IsAdmin ? 'admin' : 'warden');

const publicUser = (u) => ({
  id: u.UserId,
  name: u.LoginName,
  role: roleOf(u),
  isAdmin: roleOf(u) === 'admin',
});

async function deviceIdsFor(loginName) {
  const [rows] = await pool.query('SELECT DeviceId FROM UserDevices WHERE LoginName = ? ORDER BY DeviceId', [loginName]);
  return rows.map((r) => r.DeviceId);
}

// deviceIds is null for admins (every gate) and a list of DeviceIds for wardens.
async function sessionProfile(user) {
  const profile = publicUser(user);
  profile.deviceIds = profile.isAdmin ? null : await deviceIdsFor(user.LoginName);
  return profile;
}

const validatePassword = (pw) => {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (pw.length > 200) throw new HttpError(400, 'Password must be 200 characters or fewer');
  return pw;
};

// ---------- signed session token: base64url(payload).hmac ----------
function issueToken(user) {
  const payload = Buffer.from(JSON.stringify({
    u: user.LoginName,
    f: fingerprint(user),
    exp: Date.now() + sessionHours * 3_600_000,
  })).toString('base64url');
  return `${payload}.${hmac(payload)}`;
}

function readToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig || !safeEqual(sig, hmac(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

function setSessionCookie(req, res, value, maxAgeSec) {
  const attrs = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
  if (req.secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

async function sessionUser(req) {
  const data = readToken(readCookie(req, COOKIE));
  if (!data) return null;
  const user = await findUser(data.u);
  return user && safeEqual(data.f, fingerprint(user)) ? user : null;
}

// ---------- brute-force guard (per client + login name) ----------
const failures = new Map();

function failureKey(req, name) {
  return `${req.ip}|${String(name).toLowerCase()}`;
}

function checkThrottle(key) {
  const f = failures.get(key);
  if (f && f.resetAt > Date.now() && f.count >= MAX_FAILURES) {
    const mins = Math.ceil((f.resetAt - Date.now()) / 60_000);
    throw new HttpError(429, `Too many failed attempts. Try again in ${mins} min.`);
  }
}

function recordFailure(key) {
  const now = Date.now();
  const f = failures.get(key);
  if (!f || f.resetAt <= now) failures.set(key, { count: 1, resetAt: now + FAILURE_WINDOW_MS });
  else f.count += 1;
  if (failures.size > 5000) {
    for (const [k, v] of failures) if (v.resetAt <= now) failures.delete(k);
  }
}

// ---------- routes ----------
const router = express.Router();

router.post('/login', asyncHandler(async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!username || !password) throw new HttpError(400, 'Enter your username and password');
  if (username.length > 50 || password.length > 200) throw new HttpError(401, 'Incorrect username or password');

  const key = failureKey(req, username);
  checkThrottle(key);

  const user = await findUser(username);
  if (!user || !passwordMatches(user.LoginPassword, password)) {
    recordFailure(key);
    throw new HttpError(401, 'Incorrect username or password');
  }

  failures.delete(key);
  setSessionCookie(req, res, issueToken(user), sessionHours * 3600);
  res.json({ user: publicUser(user) });
}));

router.post('/logout', (req, res) => {
  setSessionCookie(req, res, '', 0);
  res.status(204).end();
});

router.get('/me', asyncHandler(async (req, res) => {
  const user = await sessionUser(req);
  if (!user) throw new HttpError(401, 'Not signed in');
  res.json({ user: await sessionProfile(user) });
}));

// Any signed-in user can change their own password; the session is re-issued so they stay signed in.
router.post('/password', asyncHandler(async (req, res) => {
  const user = await sessionUser(req);
  if (!user) throw new HttpError(401, 'Not signed in');
  const current = String(req.body?.currentPassword || '');
  const next = validatePassword(req.body?.newPassword);

  const key = failureKey(req, user.LoginName);
  checkThrottle(key);
  if (!passwordMatches(user.LoginPassword, current)) {
    recordFailure(key);
    throw new HttpError(400, 'Current password is incorrect');
  }
  await pool.query('UPDATE Users SET LoginPassword = ? WHERE LoginName = ?', [md5(next), user.LoginName]);
  setSessionCookie(req, res, issueToken({ ...user, LoginPassword: md5(next) }), sessionHours * 3600);
  res.status(204).end();
}));

// Accepts a signed-in session, or the x-api-key header for scripts and integrations.
// API-key callers get admin scope.
const requireAuth = asyncHandler(async (req, res, next) => {
  const key = req.get('x-api-key');
  if (key && apiKey && safeEqual(key, apiKey)) {
    req.user = { id: null, name: 'api-key', role: 'admin', isAdmin: true, deviceIds: null };
    return next();
  }
  const user = await sessionUser(req);
  if (!user) throw new HttpError(401, 'Sign in required');
  req.user = await sessionProfile(user);
  next();
});

const requireAdmin = (req, res, next) => {
  if (!req.user?.isAdmin) return next(new HttpError(403, 'Only admins can do this'));
  next();
};

module.exports = { router, requireAuth, requireAdmin, hashPassword: md5, validatePassword };
