// Builds one student's movements for a day from gate punches and explicit events.
//
// Devices only record that someone punched, so a punch's direction is guessed from order:
// the 1st is OUT, the 2nd IN, and so on (the 1st is IN for a student away overnight).
// Explicit events say the direction outright:
//   scan   — security scanned the outpass QR at the gate (OUT or IN)
//   manual — a warden marked the student reported back (IN), away from the gate
// A punch and a scan within `matchSeconds` of each other are one movement: the scan's
// direction wins, and the pair is counted once. Repeat punches within `dedupSeconds`
// are ignored as double-scans.
//
// Every movement: { seq, type, time, deviceId, deviceName, source: 'gate'|'scan'|'manual',
//                   manual (true when there was no gate punch), scannedBy? }

const secs = (t) => Date.parse(t.replace(' ', 'T')) / 1000;

function newDay() {
  return { movements: [], ignored: 0 };
}

function push(day, m) {
  day.movements.push({ seq: day.movements.length + 1, ...m, manual: m.source !== 'gate' });
}

// ctx: { startsOut, dedupSeconds, matchSeconds, deviceName(id) }
function addPunch(day, p, ctx) {
  const last = day.movements[day.movements.length - 1];
  if (last) {
    const gap = secs(p.LogDate) - secs(last.time);
    // Right after a scan: the student punching through the same gate.
    if (last.scannedBy !== undefined && gap <= ctx.matchSeconds) { day.ignored += 1; return; }
    if (last.source === 'gate' && gap <= ctx.dedupSeconds) { day.ignored += 1; return; }
  }
  const type = last ? (last.type === 'OUT' ? 'IN' : 'OUT') : ctx.startsOut ? 'IN' : 'OUT';
  push(day, { type, time: p.LogDate, deviceId: p.DeviceId, deviceName: ctx.deviceName(p.DeviceId), source: 'gate' });
}

function addExplicit(day, e, ctx) {
  const last = day.movements[day.movements.length - 1];
  if (e.source === 'manual') {
    // Only meaningful if they were out; otherwise a punch already brought them in.
    if (last ? last.type === 'OUT' : ctx.startsOut) {
      push(day, { type: 'IN', time: e.time, deviceId: null, deviceName: `Reported to ${e.by} (${e.passNo})`, source: 'manual' });
    }
    return;
  }
  // A punch just before the scan is the same movement: keep the punch, take the scan's direction.
  if (last && last.source === 'gate' && last.scannedBy === undefined && secs(e.time) - secs(last.time) <= ctx.matchSeconds) {
    last.type = e.type;
    last.scannedBy = e.by;
    last.deviceName = `${last.deviceName}, scanned by ${e.by}`;
    return;
  }
  const gate = e.deviceId ? ctx.deviceName(e.deviceId) : null;
  push(day, {
    type: e.type, time: e.time, deviceId: e.deviceId || null, source: 'scan', scannedBy: e.by,
    deviceName: `Scanned by ${e.by}${gate ? ` at ${gate}` : ''} (${e.passNo})`,
  });
}

// events: punches ({ LogDate, DeviceId }) and explicit events ({ explicit: { time, type, source, by, passNo, deviceId } }), sorted by time.
function buildDay(events, ctx) {
  const day = newDay();
  for (const ev of events) {
    if (ev.explicit) addExplicit(day, ev.explicit, ctx);
    else addPunch(day, ev, ctx);
  }
  return day;
}

module.exports = { buildDay };
