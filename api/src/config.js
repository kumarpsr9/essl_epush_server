const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const required = ['DB_HOST', 'DB_USER', 'DB_PASS', 'DB_NAME'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  throw new Error(`Missing required env vars: ${missing.join(', ')}`);
}

module.exports = {
  port: Number(process.env.API_PORT || 3000),
  apiKey: process.env.API_KEY || '',
  corsOrigin: process.env.CORS_ORIGIN || '*',
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
