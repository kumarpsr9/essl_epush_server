const app = require('./app');
const { port, apiKey, sessionSecretIsRandom, publicBaseUrl } = require('./config');
const { pool, ensureSchema } = require('./db');

if (!apiKey) console.log('API_KEY is not set — /api accepts signed-in sessions only.');
if (!publicBaseUrl) console.log('PUBLIC_BASE_URL is not set — the ERP sync page will show the address it was opened on.');
if (sessionSecretIsRandom) console.warn('WARNING: SESSION_SECRET is not set — users will be signed out whenever the API restarts.');

ensureSchema().catch((err) => console.error('Could not create the UserDevices table:', err.message));

const server = app.listen(port, () => console.log(`ePush API listening on :${port}`));

// The ePush server logs every failed device upload (mostly duplicate biometric
// templates, with the full template) into DeviceErrorMessages, which grew to 31 GB.
// Empty it at midnight IST every day, like iclock_server/start.sh does for logfile.txt.
// The container runs with TZ=Asia/Kolkata, so local midnight is IST midnight.
let clearTimer;
function scheduleErrorLogClear() {
  const next = new Date();
  next.setHours(24, 0, 0, 0);
  clearTimer = setTimeout(async () => {
    try {
      await pool.query('TRUNCATE TABLE DeviceErrorMessages');
      console.log('Cleared DeviceErrorMessages');
    } catch (err) {
      console.error('Could not clear DeviceErrorMessages:', err.message);
    }
    scheduleErrorLogClear();
  }, next - Date.now());
}
scheduleErrorLogClear();

function shutdown() {
  clearTimeout(clearTimer);
  server.close(() => pool.end().finally(() => process.exit(0)));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
