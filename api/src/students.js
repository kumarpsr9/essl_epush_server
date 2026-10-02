const { pool } = require('./db');
const { HttpError } = require('./util');

// Hostel students live in the ePush Employees table. Hostel details use spare columns:
// WorkPlace = campus the student studies at, C1 = block, C2 = room number, C3 = bed number.
// EmployeeCode always equals EmployeeCodeInDevice: it is the user id enrolled on the gate
// device, so it can't change after the student is added.

const STUDENT_SELECT = `
  SELECT EmployeeId AS id, EmployeeCode AS code, EmployeeName AS name, Gender AS gender,
         ContactNo AS phone, WorkPlace AS campus, C1 AS block, C2 AS room, C3 AS bed,
         Status AS status, LastModifiedBy AS updatedBy
  FROM Employees`;

// field -> [column, label, max length]
const FIELDS = {
  name: ['EmployeeName', 'student name', 50],
  gender: ['Gender', 'gender', 10],
  phone: ['ContactNo', 'phone number', 15],
  campus: ['WorkPlace', 'campus', 100],
  block: ['C1', 'block', 50],
  room: ['C2', 'room number', 20],
  bed: ['C3', 'bed number', 10],
};
const REQUIRED = ['name', 'gender'];

const CODE_RE = /^\d{1,9}$/;
const PHONE_RE = /^\+?[0-9 -]{10,15}$/;

const cap = (s) => s[0].toUpperCase() + s.slice(1);

function parseCode(value) {
  const code = String(value ?? '').trim();
  if (!CODE_RE.test(code)) throw new HttpError(400, 'Roll number must be the device user id: 1–9 digits');
  return code;
}

function parseGender(value) {
  const g = String(value ?? '').trim().toLowerCase();
  if (g === 'm' || g === 'male') return 'Male';
  if (g === 'f' || g === 'female') return 'Female';
  throw new HttpError(400, 'Gender must be Male or Female');
}

// Returns only the fields present in `input` (all of them unless `partial`), cleaned.
// '' or null clears an optional field.
function parseFields(input, { partial }) {
  const out = {};
  for (const [key, [, label, max]] of Object.entries(FIELDS)) {
    if (partial && input?.[key] === undefined) continue;
    let v = String(input?.[key] ?? '').trim().replace(/\s+/g, ' ');
    if (!v && REQUIRED.includes(key)) throw new HttpError(400, `Enter the ${label}`);
    if (v.length > max) throw new HttpError(400, `${cap(label)} must be ${max} characters or fewer`);
    if (key === 'gender') v = parseGender(v);
    if (key === 'phone' && v && !PHONE_RE.test(v)) throw new HttpError(400, 'Phone number must be 10–15 digits');
    out[key] = v;
  }
  return out;
}

async function findStudent(code) {
  const [rows] = await pool.query(`${STUDENT_SELECT} WHERE EmployeeCode = ? OR EmployeeCodeInDevice = ? LIMIT 1`, [code, code]);
  return rows[0] || null;
}

// A bed can hold one current student. Blank beds are not checked.
async function assertBedFree(s, code) {
  if (!s.bed) return;
  const [rows] = await pool.query(
    `SELECT EmployeeCode, EmployeeName FROM Employees
     WHERE C1 = ? AND C2 = ? AND C3 = ? AND EmployeeCode <> ? AND Status = 'Working' LIMIT 1`,
    [s.block, s.room, s.bed, code]
  );
  if (rows.length) {
    const r = rows[0];
    throw new HttpError(409, `Bed ${s.bed} in ${s.block}, room ${s.room} is already given to ${r.EmployeeName} (${r.EmployeeCode})`);
  }
}

const nullable = (v) => (v === '' || v == null ? null : v);

/**
 * Adds or updates one student.
 * mode: 'create' (fails if the roll number exists), 'update' (fails if it doesn't), or 'upsert'.
 * partial: only change the fields present in `input` (used by the ERP webhook).
 * Returns { action: 'created' | 'updated' | 'unchanged', student }.
 */
async function saveStudent({ code: rawCode, input, actor, mode, partial = false }) {
  const code = parseCode(rawCode);
  const fields = parseFields(input, { partial });
  const existing = await findStudent(code);

  if (existing && mode === 'create') {
    const who = existing.name === code ? '' : ` by ${existing.name}`;
    throw new HttpError(409, `Roll number ${code} is already added${who}`);
  }
  if (!existing && mode === 'update') throw new HttpError(404, 'Student not found');

  if (!existing) {
    for (const key of REQUIRED) if (!fields[key]) throw new HttpError(400, `Enter the ${FIELDS[key][1]} to add a new student`);
  }

  const before = existing || {};
  const merged = { ...before };
  for (const [k, v] of Object.entries(fields)) merged[k] = v;
  if (merged.bed && !(merged.block && merged.room)) throw new HttpError(400, 'Enter the block and room before the bed number');

  const changed = Object.keys(fields).filter((k) => (before[k] ?? '') !== (fields[k] ?? ''));
  if (existing && !changed.length) return { action: 'unchanged', student: existing };
  if (['block', 'room', 'bed'].some((k) => changed.includes(k)) || !existing) await assertBedFree(merged, code);

  if (existing) {
    const sets = changed.map((k) => `${FIELDS[k][0]} = ?`);
    await pool.query(
      `UPDATE Employees SET ${sets.join(', ')}, LastModifiedBy = ? WHERE EmployeeCode = ?`,
      [...changed.map((k) => (REQUIRED.includes(k) ? merged[k] : nullable(merged[k]))), actor, existing.code]
    );
  } else {
    // Defaults match the rows the ePush server creates when a gate device reports a new user.
    await pool.query(
      `INSERT INTO Employees (EmployeeName, EmployeeCode, StringCode, NumericCode, Gender, CompanyId, DepartmentId,
         Designation, CategoryId, DOJ, EmployeeCodeInDevice, EmployementType, Status, ContactNo, Location,
         RecordStatus, WorkPlace, C1, C2, C3, LastModifiedBy)
       VALUES (?, ?, '', ?, ?, 1, 1, '', 1, '1900-01-01 00:00:00', ?, 'Permanent', 'Working', ?, '', 1, ?, ?, ?, ?, ?)`,
      [merged.name, code, Number(code), merged.gender, code, nullable(merged.phone), nullable(merged.campus),
        nullable(merged.block), nullable(merged.room), nullable(merged.bed), actor]
    );
  }
  return { action: existing ? 'updated' : 'created', student: await findStudent(code) };
}

async function listStudents() {
  const [rows] = await pool.query(`${STUDENT_SELECT} WHERE Status = 'Working' ORDER BY EmployeeName`);
  return rows;
}

module.exports = { saveStudent, listStudents, parseCode };
