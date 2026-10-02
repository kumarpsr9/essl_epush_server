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

// Wardens only see the gates mapped to them (req.user.deviceIds); admins see all.
router.get('/', asyncHandler(async (req, res) => {
  const scope = req.user.deviceIds;
  if (scope && !scope.length) return res.json({ data: [] });
  const [rows] = scope
    ? await pool.query(`${DEVICE_SELECT} WHERE DeviceId IN (?) ORDER BY DeviceFName`, [deviceOfflineAfterSec, scope])
    : await pool.query(`${DEVICE_SELECT} ORDER BY DeviceFName`, [deviceOfflineAfterSec]);
  res.json({ data: rows.map((r) => ({ ...r, online: !!r.online })) });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const scope = req.user.deviceIds;
  if (scope && !scope.includes(Number(req.params.id))) throw new HttpError(404, 'Device not found');
  const [rows] = await pool.query(`${DEVICE_SELECT} WHERE DeviceId = ?`, [deviceOfflineAfterSec, req.params.id]);
  if (!rows.length) throw new HttpError(404, 'Device not found');
  res.json({ data: { ...rows[0], online: !!rows[0].online } });
}));

module.exports = router;
