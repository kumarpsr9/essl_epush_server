const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const required = ['DB_HOST', 'DB_USER', 'DB_PASS', 'DB_NAME'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  throw new Error(`Missing required env vars: ${missing.join(', ')}`);
}

// PUBLIC_BASE_URL: where outside systems (the ERP webhook) reach this API. Empty = not set.
function publicBaseUrl(raw) {
  const v = String(raw || '').trim().replace(/\/+$/, '');
  if (!v) return '';
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
    return v;
  } catch {
    throw new Error(`PUBLIC_BASE_URL must be an http(s) URL, e.g. https://hostel.example.com (got "${raw}")`);
  }
}

module.exports = {
  publicBaseUrl: publicBaseUrl(process.env.PUBLIC_BASE_URL),
  port: Number(process.env.API_PORT || 3000),
  apiKey: process.env.API_KEY || '',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  // Signs login session cookies. If unset, a random one is used and sessions end on restart.
  sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  sessionSecretIsRandom: !process.env.SESSION_SECRET,
  sessionHours: Number(process.env.SESSION_HOURS || 12),
  db: {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
  },
  // Devices that haven't pinged within this many seconds are reported offline.
  deviceOfflineAfterSec: Number(process.env.DEVICE_OFFLINE_AFTER_SEC || 300),
  maxRangeDays: 93,
};
