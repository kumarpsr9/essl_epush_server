const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const crypto = require('crypto');
const path = require('path');
const { apiKey, corsOrigin } = require('./config');
const { pool } = require('./db');
const { asyncHandler } = require('./util');

const app = express();
// The report page is served over plain http on the LAN, so don't force https subresources.
app.use(helmet({ contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } } }));
app.use(cors({ origin: corsOrigin }));
app.use(express.json());

// Static report page (no data in it; it calls /api with the key the user enters).
app.use(express.static(path.join(__dirname, '../public')));

app.get('/health', asyncHandler(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok', db: 'up' });
}));

function requireApiKey(req, res, next) {
  if (!apiKey) return next();
  const given = Buffer.from(String(req.get('x-api-key') || ''));
  const expected = Buffer.from(apiKey);
  if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
  res.status(401).json({ error: 'Invalid or missing x-api-key header' });
}

app.use('/api', requireApiKey);
app.use('/api/devices', require('./routes/devices'));
app.use('/api/employees', require('./routes/employees'));
app.use('/api/logs', require('./routes/logs'));
app.use('/api/reports', require('./routes/reports'));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
});

module.exports = app;
