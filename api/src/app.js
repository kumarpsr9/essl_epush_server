const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { corsOrigin } = require('./config');
const { pool } = require('./db');
const { asyncHandler } = require('./util');
const auth = require('./auth');

const app = express();
// The report page is served over plain http on the LAN, so don't force https subresources.
app.use(helmet({ contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } } }));
app.use(cors({ origin: corsOrigin }));

// ERP webhook: authenticated by its own key, and allowed a larger body for bulk syncs.
const webhooks = require('./routes/webhooks');
app.use('/hooks', express.json({ limit: '5mb' }), webhooks.hooks);

app.use(express.json());

// The sign-in page is the site root (index.html); the register lives at /register.html.
// Old bookmarks to /login.html still work.
app.get('/login.html', (req, res) => {
  const i = req.originalUrl.indexOf('?');
  res.redirect(301, `/${i >= 0 ? req.originalUrl.slice(i) : ''}`);
});

// Static pages hold no data; each page calls /api with the signed-in session.
app.use(express.static(path.join(__dirname, '../public')));

app.get('/health', asyncHandler(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok', db: 'up' });
}));

app.use('/auth', auth.router);
app.use('/api', auth.requireAuth);
app.use('/api/devices', require('./routes/devices'));
app.use('/api/employees', require('./routes/employees'));
app.use('/api/logs', require('./routes/logs'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/students', require('./routes/students'));
app.use('/api/outpasses', require('./routes/outpasses'));
app.use('/api/users', auth.requireAdmin, require('./routes/users'));
app.use('/api/webhooks', auth.requireAdmin, webhooks.admin);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
});

module.exports = app;
