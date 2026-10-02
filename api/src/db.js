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

// For tables created by an earlier version of this API.
async function addColumnIfMissing(table, column, definition) {
  const [rows] = await pool.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column]
  );
  if (!rows.length) await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
}

// Which gates each warden may see. Admins are not listed; they see every gate.
async function ensureSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS UserDevices (
    LoginName varchar(50) NOT NULL,
    DeviceId int(11) NOT NULL,
    PRIMARY KEY (LoginName, DeviceId)
  ) DEFAULT CHARSET=utf8`);
  // Keys the external ERP uses to call the student webhook. Only a SHA-256 of each key is kept.
  await pool.query(`CREATE TABLE IF NOT EXISTS WebhookKeys (
    Id int(11) NOT NULL AUTO_INCREMENT,
    Name varchar(100) NOT NULL,
    TokenHash char(64) NOT NULL,
    Prefix varchar(16) NOT NULL,
    CreatedBy varchar(50) NOT NULL,
    CreatedAt datetime NOT NULL,
    LastUsedAt datetime DEFAULT NULL,
    RevokedAt datetime DEFAULT NULL,
    PRIMARY KEY (Id),
    UNIQUE KEY UK_TokenHash (TokenHash)
  ) DEFAULT CHARSET=utf8`);
  // Outpasses. All times are IST wall-clock, like DeviceLogs.LogDate. DepartedAt / ReturnedAt
  // are filled from gate punches (or by a warden for ReturnedAt).
  await pool.query(`CREATE TABLE IF NOT EXISTS Outpasses (
    Id int(11) NOT NULL AUTO_INCREMENT,
    PassNo varchar(20) DEFAULT NULL,
    StudentCode varchar(50) NOT NULL,
    Type varchar(20) NOT NULL,
    Reason varchar(255) NOT NULL,
    Destination varchar(255) DEFAULT NULL,
    ApprovedBy varchar(100) DEFAULT NULL,
    OutFrom datetime NOT NULL,
    ReturnBy datetime NOT NULL,
    IssuedBy varchar(50) NOT NULL,
    IssuedAt datetime NOT NULL,
    DepartedAt datetime DEFAULT NULL,
    DepartDeviceId int(11) DEFAULT NULL,
    ReturnedAt datetime DEFAULT NULL,
    ReturnDeviceId int(11) DEFAULT NULL,
    ReturnSource varchar(10) DEFAULT NULL,
    ReturnedBy varchar(50) DEFAULT NULL,
    ReturnNote varchar(255) DEFAULT NULL,
    Cancelled tinyint(1) NOT NULL DEFAULT 0,
    CancelledBy varchar(50) DEFAULT NULL,
    CancelledAt datetime DEFAULT NULL,
    ExtendedBy varchar(50) DEFAULT NULL,
    PRIMARY KEY (Id),
    UNIQUE KEY UK_PassNo (PassNo),
    KEY IX_Student (StudentCode),
    KEY IX_OutFrom (OutFrom)
  ) DEFAULT CHARSET=utf8`);
  await addColumnIfMissing('Outpasses', 'ApprovedBy', 'varchar(100) DEFAULT NULL AFTER Destination');
  await pool.query(`CREATE TABLE IF NOT EXISTS WebhookLog (
    Id int(11) NOT NULL AUTO_INCREMENT,
    At datetime NOT NULL,
    KeyName varchar(100) DEFAULT NULL,
    Ip varchar(64) DEFAULT NULL,
    Status int(11) NOT NULL,
    Received int(11) NOT NULL DEFAULT 0,
    Created int(11) NOT NULL DEFAULT 0,
    Updated int(11) NOT NULL DEFAULT 0,
    Unchanged int(11) NOT NULL DEFAULT 0,
    Failed int(11) NOT NULL DEFAULT 0,
    Errors text,
    PRIMARY KEY (Id),
    KEY IX_At (At)
  ) DEFAULT CHARSET=utf8`);
}

module.exports = { pool, logTablesFor, ensureSchema };
