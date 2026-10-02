const crypto = require('crypto');
const express = require('express');
const { pool } = require('../db');
const { HttpError, asyncHandler } = require('../util');
const { saveStudent, findBySuc } = require('../students');
const { publicBaseUrl } = require('../config');

const MAX_RECORDS = 2000;
const MAX_LOGGED_ERRORS = 50;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---------- public hook: POST /hooks/students ----------
// Called by the external ERP with `Authorization: Bearer <key>` (or `X-Webhook-Key`).
// Body: { "students": [ {...}, ... ] }, a bare array, or one student object.
// Each record is matched on `code` (roll number = device user id), or on `suc` when `code` is
// left out; it is added or updated, and only fields that are present change.
const hooks = express.Router();

async function keyFor(req) {
  const auth = req.get('authorization') || '';
  const token = (auth.match(/^Bearer\s+(\S+)$/i)?.[1] || req.get('x-webhook-key') || '').trim();
  if (!token) return null;
  const [rows] = await pool.query(
    'SELECT Id, Name FROM WebhookKeys WHERE TokenHash = ? AND RevokedAt IS NULL LIMIT 1', [sha256(token)]
  );
  return rows[0] || null;
}

async function writeLog(entry) {
  await pool.query(
    `INSERT INTO WebhookLog (At, KeyName, Ip, Status, Received, Created, Updated, Unchanged, Failed, Errors)
     VALUES (NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [entry.key, entry.ip, entry.status, entry.received || 0, entry.created || 0, entry.updated || 0,
      entry.unchanged || 0, entry.failed || 0, entry.errors?.length ? JSON.stringify(entry.errors.slice(0, MAX_LOGGED_ERRORS)) : null]
  ).catch((err) => console.error('Could not write the webhook log:', err.message));
}

// Log rejected keys at most once a minute per address, so a misconfigured caller can't flood the log.
const lastRejectLog = new Map();

hooks.post('/students', asyncHandler(async (req, res) => {
  const key = await keyFor(req);
  if (!key) {
    if (Date.now() - (lastRejectLog.get(req.ip) || 0) > 60_000) {
      lastRejectLog.set(req.ip, Date.now());
      if (lastRejectLog.size > 1000) lastRejectLog.clear();
      await writeLog({ key: null, ip: req.ip, status: 401, errors: [{ error: 'Missing, wrong or revoked webhook key' }] });
    }
    throw new HttpError(401, 'Missing, wrong or revoked webhook key');
  }
  pool.query('UPDATE WebhookKeys SET LastUsedAt = NOW() WHERE Id = ?', [key.Id]).catch(() => {});

  const body = req.body;
  const records = Array.isArray(body) ? body : Array.isArray(body?.students) ? body.students : body && typeof body === 'object' && body.code !== undefined ? [body] : null;
  const reject = async (status, message) => {
    await writeLog({ key: key.Name, ip: req.ip, status, errors: [{ error: message }] });
    throw new HttpError(status, message);
  };
  if (!records) await reject(400, 'Send JSON: { "students": [ { "code": "...", ... } ] }');
  if (!records.length) await reject(400, 'The students list is empty');
  if (records.length > MAX_RECORDS) await reject(413, `Send at most ${MAX_RECORDS} students per request`);

  // Records are applied in order, one at a time, so a later record sees earlier changes.
  const result = { received: records.length, created: 0, updated: 0, unchanged: 0, failed: 0, errors: [] };
  const actor = `erp:${key.Name}`.slice(0, 50);
  for (const [index, rec] of records.entries()) {
    try {
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) throw new HttpError(400, 'Each student must be a JSON object');
      let { code } = rec;
      if (code === undefined || code === null || code === '') {
        const suc = String(rec.suc ?? '').trim();
        if (!suc) throw new HttpError(400, 'Send the roll number (code) or SUC');
        const found = await findBySuc(suc);
        if (!found) throw new HttpError(404, `No student has SUC ${suc}. Send code to add a new student`);
        code = found.code;
      }
      const { action } = await saveStudent({ code, input: rec, actor, mode: 'upsert', partial: true });
      result[action] += 1;
    } catch (err) {
      if (!err.status || err.status >= 500) console.error(err);
      result.failed += 1;
      result.errors.push({ index, code: rec?.code ?? rec?.suc ?? null, error: err.status && err.status < 500 ? err.message : 'Internal error' });
    }
  }

  await writeLog({ key: key.Name, ip: req.ip, status: 200, ...result });
  res.json(result);
}));

// ---------- admin: /api/webhooks ----------
const admin = express.Router();

admin.get('/', asyncHandler(async (req, res) => {
  const [keys] = await pool.query(
    `SELECT Id AS id, Name AS name, Prefix AS prefix, CreatedBy AS createdBy, CreatedAt AS createdAt,
            LastUsedAt AS lastUsedAt, RevokedAt AS revokedAt
     FROM WebhookKeys ORDER BY RevokedAt IS NOT NULL, CreatedAt DESC`
  );
  const [log] = await pool.query(
    `SELECT Id AS id, At AS at, KeyName AS keyName, Ip AS ip, Status AS status, Received AS received,
            Created AS created, Updated AS updated, Unchanged AS unchanged, Failed AS failed, Errors AS errors
     FROM WebhookLog ORDER BY Id DESC LIMIT 30`
  );
  res.json({
    keys,
    log: log.map((l) => ({ ...l, errors: l.errors ? JSON.parse(l.errors) : [] })),
    maxRecords: MAX_RECORDS,
    // Empty when PUBLIC_BASE_URL isn't set; the page then falls back to its own address.
    hookUrl: publicBaseUrl ? `${publicBaseUrl}/hooks/students` : '',
  });
}));

// POST /api/webhooks/keys { name } — the key itself is returned only in this response.
admin.post('/keys', asyncHandler(async (req, res) => {
  const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ');
  if (!name) throw new HttpError(400, 'Name the key after the system that will use it');
  if (name.length > 100) throw new HttpError(400, 'Name must be 100 characters or fewer');
  const token = `erp_${crypto.randomBytes(24).toString('base64url')}`;
  const prefix = token.slice(0, 10);
  const [r] = await pool.query(
    'INSERT INTO WebhookKeys (Name, TokenHash, Prefix, CreatedBy, CreatedAt) VALUES (?, ?, ?, ?, NOW())',
    [name, sha256(token), prefix, req.user.name]
  );
  res.status(201).json({ data: { id: r.insertId, name, prefix, token } });
}));

admin.delete('/keys/:id', asyncHandler(async (req, res) => {
  const [r] = await pool.query('UPDATE WebhookKeys SET RevokedAt = NOW() WHERE Id = ? AND RevokedAt IS NULL', [req.params.id]);
  if (!r.affectedRows) throw new HttpError(404, 'Key not found or already revoked');
  res.status(204).end();
}));

module.exports = { hooks, admin };
