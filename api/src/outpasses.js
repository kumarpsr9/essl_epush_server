const { pool, logTablesFor } = require('./db');
const { today, nowIST } = require('./util');

// Outpass lifecycle (times are IST wall-clock strings, like DeviceLogs.LogDate):
//   issued   → a warden created it; the student hasn't punched out yet
//   out      → the first gate punch after (OutFrom − LEAVE_EARLY_MIN), or a QR scan at the gate, recorded DepartedAt
//   returned → the next gate punch after leaving, a QR scan, or a warden recorded ReturnedAt
//   cancelled, or unused (ReturnBy passed and the student never left)
// A student is "covered" while their pass is out (or issued and within its window).
//
// Punches and scans of the same movement: a student scanned out by security usually also
// punches the device on the way through, before or after the scan. A punch within
// SCAN_MATCH_MIN of a scan is treated as the same movement, never as the next one, so it
// can't close the pass the student has just left on. Scans state the direction outright,
// so they also correct the register's odd/even guess for a punch they are matched to.

const DEDUP_SEC = Number(process.env.HOSTEL_DEDUP_SEC || 60);
const LEAVE_EARLY_MIN = 30; // a punch this long before OutFrom still counts as leaving on the pass
const SYNC_DAYS = 45;       // only passes starting this recently are matched to punches
const SCAN_MATCH_MIN = Number(process.env.HOSTEL_SCAN_MATCH_MIN || 10);

const toMs = (s) => Date.parse(`${s.replace(' ', 'T')}+05:30`);
const fmt = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' });
const addMin = (s, m) => fmt(toMs(s) + m * 60_000);

const PASS_SELECT = `
  SELECT o.Id AS id, o.PassNo AS passNo, o.StudentCode AS code, o.Type AS type, o.Reason AS reason,
         o.Destination AS destination, o.ApprovedBy AS approvedBy, o.OutFrom AS outFrom, o.ReturnBy AS returnBy,
         o.IssuedBy AS issuedBy, o.IssuedAt AS issuedAt, o.DepartedAt AS departedAt, o.DepartDeviceId AS departDeviceId,
         o.DepartSource AS departSource, o.DepartedBy AS departedBy,
         o.ReturnedAt AS returnedAt, o.ReturnDeviceId AS returnDeviceId, o.ReturnSource AS returnSource,
         o.ReturnedBy AS returnedBy, o.ReturnNote AS returnNote, o.Cancelled AS cancelled,
         o.CancelledBy AS cancelledBy, o.CancelledAt AS cancelledAt, o.ExtendedBy AS extendedBy,
         e.EmployeeName AS name, e.EmployeeRFIDNumber AS suc, e.ContactNo AS phone, e.WorkPlace AS campus, e.C1 AS block, e.C2 AS room, e.C3 AS bed
  FROM Outpasses o LEFT JOIN Employees e ON e.EmployeeCodeInDevice = o.StudentCode`;

// Derived state at `now`.
function stateOf(p, now = nowIST()) {
  if (p.cancelled) return 'cancelled';
  if (p.returnedAt) return 'returned';
  if (p.departedAt) return now > p.returnBy ? 'overdue' : 'out';
  return now > p.returnBy ? 'unused' : 'issued';
}

function decorate(p, now = nowIST()) {
  const state = stateOf(p, now);
  const lateMin = (t) => Math.max(0, Math.round((toMs(t) - toMs(p.returnBy)) / 60_000));
  return {
    ...p,
    cancelled: !!p.cancelled,
    state,
    lateMinutes: state === 'returned' ? lateMin(p.returnedAt) : state === 'overdue' ? lateMin(now) : 0,
  };
}

// Gate punches for these students since `from`, counted punches only (repeat scans dropped).
async function punchesSince(codes, from) {
  if (!codes.length) return new Map();
  const tables = await logTablesFor(from.slice(0, 10), today());
  if (!tables.length) return new Map();
  const sql = tables
    .map((t) => `SELECT UserId, DeviceId, LogDate FROM \`${t}\` WHERE UserId IN (?) AND LogDate >= ?`)
    .join(' UNION ALL ');
  const [rows] = await pool.query(`${sql} ORDER BY UserId, LogDate`, tables.flatMap(() => [codes, from]));
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.UserId)) by.set(r.UserId, []);
    const list = by.get(r.UserId);
    const last = list[list.length - 1];
    if (last && (toMs(r.LogDate) - toMs(last.LogDate)) / 1000 <= DEDUP_SEC) continue;
    list.push(r);
  }
  return by;
}

let syncing = null;

// Matches open passes to gate punches and saves DepartedAt / ReturnedAt.
// Concurrent callers share one run.
function syncOutpasses() {
  if (!syncing) syncing = runSync().finally(() => { syncing = null; });
  return syncing;
}

async function runSync() {
  const [open] = await pool.query(
    `SELECT Id, StudentCode, OutFrom, ReturnBy, DepartedAt, DepartSource FROM Outpasses
     WHERE Cancelled = 0 AND ReturnedAt IS NULL AND OutFrom >= DATE_SUB(?, INTERVAL ${SYNC_DAYS} DAY)
       AND (DepartedAt IS NOT NULL OR ReturnBy >= DATE_SUB(?, INTERVAL 1 DAY))`,
    [nowIST(), nowIST()]
  );
  if (!open.length) return;
  const from = open.map((p) => p.DepartedAt || addMin(p.OutFrom, -LEAVE_EARLY_MIN)).sort()[0];
  const punches = await punchesSince([...new Set(open.map((p) => p.StudentCode))], from);

  for (const p of open) {
    const list = punches.get(p.StudentCode) || [];
    let departedAt = p.DepartedAt;
    const sets = {};
    if (!departedAt) {
      const start = addMin(p.OutFrom, -LEAVE_EARLY_MIN);
      const dep = list.find((x) => x.LogDate >= start && x.LogDate <= p.ReturnBy);
      if (dep) {
        departedAt = dep.LogDate;
        Object.assign(sets, { DepartedAt: dep.LogDate, DepartDeviceId: dep.DeviceId, DepartSource: 'gate' });
      }
    }
    if (departedAt) {
      // After a scan, the student's own punch on the way out (or a late upload from an
      // offline device) lands within the match window and must not count as coming back.
      const gapMs = p.DepartSource === 'scan' ? SCAN_MATCH_MIN * 60_000 : DEDUP_SEC * 1000;
      const ret = list.find((x) => toMs(x.LogDate) - toMs(departedAt) > gapMs);
      if (ret) Object.assign(sets, { ReturnedAt: ret.LogDate, ReturnDeviceId: ret.DeviceId, ReturnSource: 'gate' });
    }
    const keys = Object.keys(sets);
    if (keys.length) {
      await pool.query(
        `UPDATE Outpasses SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE Id = ? AND ReturnedAt IS NULL`,
        [...keys.map((k) => sets[k]), p.Id]
      );
    }
  }
}

// Student's current direction today from gate punches: the last counted punch and whether it was OUT.
// Used when a pass is issued after the student already left.
async function lastPunchToday(code) {
  const day = today();
  const list = (await punchesSince([code], day)).get(code) || [];
  const last = list[list.length - 1];
  return last ? { ...last, isOut: list.length % 2 === 1 } : null;
}

/**
 * Passes that matter for the register on `date` up to `asOf`, by student code:
 *   awayAtStart — left on an earlier day and not back by midnight, so today's first punch is IN
 *   cover       — the pass covering the student at `asOf` (if any), with `overdue`
 */
async function passesForDay(date, asOf) {
  const dayStart = `${date} 00:00:00`;
  const [rows] = await pool.query(
    `${PASS_SELECT}
     WHERE o.Cancelled = 0 AND o.IssuedAt <= ? AND (o.ReturnedAt IS NULL OR o.ReturnedAt > ?)
       AND (o.DepartedAt IS NOT NULL OR o.ReturnBy >= ?) AND o.OutFrom <= ?
     ORDER BY o.IssuedAt`,
    [asOf, dayStart, dayStart, addMin(asOf, LEAVE_EARLY_MIN)]
  );
  const byCode = new Map();
  for (const p of rows) {
    const awayAtStart = !!p.departedAt && p.departedAt < dayStart;
    const coversNow = (!p.returnedAt || p.returnedAt > asOf)
      && (p.departedAt ? p.departedAt <= asOf : asOf <= p.returnBy);
    const entry = byCode.get(p.code) || { awayAtStart: false, cover: null, explicit: [] };
    entry.awayAtStart = entry.awayAtStart || awayAtStart;
    // Movements with a known direction: QR scans at the gate, and wardens marking a student back.
    const inDay = (t) => t && t > dayStart && t <= asOf;
    if (p.departSource === 'scan' && inDay(p.departedAt)) {
      entry.explicit.push({ time: p.departedAt, type: 'OUT', source: 'scan', by: p.departedBy, passNo: p.passNo, deviceId: p.departDeviceId });
    }
    if ((p.returnSource === 'manual' || p.returnSource === 'scan') && inDay(p.returnedAt)) {
      entry.explicit.push({ time: p.returnedAt, type: 'IN', source: p.returnSource, by: p.returnedBy, passNo: p.passNo, deviceId: p.returnDeviceId });
    }
    if (coversNow) {
      entry.cover = {
        id: p.id, passNo: p.passNo, type: p.type, returnBy: p.returnBy, departedAt: p.departedAt,
        departDeviceId: p.departDeviceId, overdue: asOf > p.returnBy,
      };
    }
    byCode.set(p.code, entry);
  }
  return byCode;
}

// "14:30" today, "04 Oct 14:30" on any other day.
function clock(s, now = nowIST()) {
  if (s.slice(0, 10) === now.slice(0, 10)) return s.slice(11, 16);
  const d = new Date(`${s.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
  return `${d} ${s.slice(11, 16)}`;
}

/**
 * What security may do when they scan this pass at `now`.
 *   next — 'depart' | 'return' | null (nothing to record)
 *   tone — 'go' (let out), 'back' (mark returned), 'wait' (already recorded, nothing to do), 'stop' (don't let out)
 */
function scanVerdict(p, now = nowIST()) {
  const by = (src, who) => (src === 'scan' ? `scanned by ${who}` : src === 'manual' ? `marked by ${who}` : 'gate punch');
  switch (p.state) {
    case 'cancelled':
      return { next: null, tone: 'stop', title: 'Outpass cancelled', detail: `${p.cancelledBy ? `Cancelled by ${p.cancelledBy}. ` : ''}Don't let the student out on this pass.` };
    case 'returned':
      return { next: null, tone: 'stop', title: 'Pass already used', detail: `Reported back at ${clock(p.returnedAt, now)} (${by(p.returnSource, p.returnedBy)}). A pass works for one trip out only.` };
    case 'unused':
      return { next: null, tone: 'stop', title: 'Outpass expired', detail: `It was valid until ${clock(p.returnBy, now)} and was never used. The student needs a new outpass from the warden.` };
    case 'issued': {
      const opens = addMin(p.outFrom, -LEAVE_EARLY_MIN);
      if (now < opens) {
        return { next: null, tone: 'stop', title: 'Too early to leave', detail: `This pass starts at ${clock(p.outFrom, now)}. They can go out from ${clock(opens, now)}.` };
      }
      return { next: 'depart', tone: 'go', title: 'Allow out', detail: `${p.type === 'leave' ? 'Leave' : 'Outing'} until ${clock(p.returnBy, now)}.` };
    }
    default: { // out, overdue
      const sinceMin = (toMs(now) - toMs(p.departedAt)) / 60_000;
      if (sinceMin < SCAN_MATCH_MIN) {
        return { next: null, tone: 'wait', title: 'Already recorded going out', detail: `Left at ${clock(p.departedAt, now)} (${by(p.departSource || 'gate', p.departedBy)}). Scan again when they come back.` };
      }
      const late = p.state === 'overdue' ? Math.round((toMs(now) - toMs(p.returnBy)) / 60_000) : 0;
      const lateText = late >= 60 ? `${Math.floor(late / 60)} h ${late % 60} min late` : `${late} min late`;
      return {
        next: 'return',
        tone: 'back',
        title: 'Mark reported back',
        detail: `Left at ${clock(p.departedAt, now)}. ${late ? `Due back at ${clock(p.returnBy, now)}: ${lateText}.` : `Due back by ${clock(p.returnBy, now)}.`}`,
        late,
      };
    }
  }
}

module.exports = {
  PASS_SELECT, decorate, stateOf, syncOutpasses, lastPunchToday, passesForDay, scanVerdict, addMin, LEAVE_EARLY_MIN, SCAN_MATCH_MIN,
};
