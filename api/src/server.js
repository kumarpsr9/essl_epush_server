const app = require('./app');
const { port, apiKey } = require('./config');
const { pool } = require('./db');

if (!apiKey) console.warn('WARNING: API_KEY is not set — /api endpoints are unauthenticated.');

const server = app.listen(port, () => console.log(`ePush API listening on :${port}`));

function shutdown() {
  server.close(() => pool.end().finally(() => process.exit(0)));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
