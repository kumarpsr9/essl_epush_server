const mysql = require('mysql2/promise');
const { db } = require('./config');

// dateStrings: LogDate is written in device-local time (IST) while the MySQL server
// runs in UTC, so returning raw strings avoids a misleading timezone conversion.
const pool = mysql.createPool({
  ...db,
  waitForConnections: true,
  dateStrings: true,
  enableKeepAlive: true,
});

// The ePush server writes punches into one table per month: DeviceLogs_<M>_<YYYY>.
let logTablesCache = { at: 0, tables: new Set() };

async function existingLogTables() {
  if (Date.now() - logTablesCache.at < 60_000) return logTablesCache.tables;
  const [rows] = await pool.query(
    "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME REGEXP '^DeviceLogs_[0-9]{1,2}_[0-9]{4}$'"
  );
  logTablesCache = { at: Date.now(), tables: new Set(rows.map((r) => r.name)) };
  return logTablesCache.tables;
}

// Returns the monthly log tables that exist and overlap [from, to] (YYYY-MM-DD strings).
async function logTablesFor(from, to) {
  const existing = await existingLogTables();
  const tables = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    const name = `DeviceLogs_${m}_${y}`;
    if (existing.has(name)) tables.push(name);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return tables;
}

module.exports = { pool, logTablesFor };
