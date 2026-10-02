const { maxRangeDays } = require('./config');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function today() {
  // Device-local calendar date (IST), matching how LogDate is stored.
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// Current IST wall-clock time as 'YYYY-MM-DD HH:MM:SS', the format LogDate uses.
function nowIST() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' });
}

function parseDate(value, name) {
  if (!DATE_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new HttpError(400, `${name} must be a date in YYYY-MM-DD format`);
  }
  return value;
}

function dateRange(query) {
  const from = parseDate(query.from || query.date || today(), 'from');
  const to = parseDate(query.to || query.date || from, 'to');
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (days < 0) throw new HttpError(400, 'from must be on or before to');
  if (days > maxRangeDays) throw new HttpError(400, `date range cannot exceed ${maxRangeDays} days`);
  return { from, to };
}

function pagination(query, { defaultLimit = 50, maxLimit = 500 } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
}

module.exports = { HttpError, asyncHandler, dateRange, pagination, today, nowIST };
