const router = require('express').Router();
const { pool } = require('../db');
const { deviceOfflineAfterSec } = require('../config');
const { HttpError, asyncHandler } = require('../util');

// LastPing is written in server time (UTC), so compare against NOW() inside MySQL.
const DEVICE_SELECT = `
  SELECT DeviceId, DeviceFName, DevicesName, SerialNumber, DeviceDirection, DeviceType,
         IpAddress, DeviceLocation, TimeZone, LastPing, LastLogDownloadDate,
         TIMESTAMPDIFF(SECOND, LastPing, NOW()) <= ? AS online
  FROM Devices`;

router.get('/', asyncHandler(async (req, res) => {
  const [rows] = await pool.query(`${DEVICE_SELECT} ORDER BY DeviceFName`, [deviceOfflineAfterSec]);
  res.json({ data: rows.map((r) => ({ ...r, online: !!r.online })) });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const [rows] = await pool.query(`${DEVICE_SELECT} WHERE DeviceId = ?`, [deviceOfflineAfterSec, req.params.id]);
  if (!rows.length) throw new HttpError(404, 'Device not found');
  res.json({ data: { ...rows[0], online: !!rows[0].online } });
}));

module.exports = router;
