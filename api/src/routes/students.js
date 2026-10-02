const router = require('express').Router();
const { asyncHandler } = require('../util');
const { saveStudent, listStudents } = require('../students');

// Admins and wardens can both add and edit students. Field rules live in ../students.js,
// shared with the ERP webhook.

router.get('/', asyncHandler(async (req, res) => {
  res.json({ data: await listStudents() });
}));

// POST /api/students { code, suc, name, gender, phone, campus, block, room, bed }
router.post('/', asyncHandler(async (req, res) => {
  const { student } = await saveStudent({ code: req.body?.code, input: req.body, actor: req.user.name, mode: 'create' });
  res.status(201).json({ data: student });
}));

// PATCH /api/students/:code { suc, name, gender, phone, campus, block, room, bed }
router.patch('/:code', asyncHandler(async (req, res) => {
  const { student } = await saveStudent({ code: req.params.code, input: req.body, actor: req.user.name, mode: 'update' });
  res.json({ data: student });
}));

module.exports = router;
