const app = require('./app');
const { port, apiKey, sessionSecretIsRandom, publicBaseUrl } = require('./config');
const { pool, ensureSchema } = require('./db');

if (!apiKey) console.log('API_KEY is not set — /api accepts signed-in sessions only.');
if (!publicBaseUrl) console.log('PUBLIC_BASE_URL is not set — the ERP sync page will show the address it was opened on.');
if (sessionSecretIsRandom) console.warn('WARNING: SESSION_SECRET is not set — users will be signed out whenever the API restarts.');

ensureSchema().catch((err) => console.error('Could not create the UserDevices table:', err.message));

const server = app.listen(port, () => console.log(`ePush API listening on :${port}`));

function shutdown() {
  server.close(() => pool.end().finally(() => process.exit(0)));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
