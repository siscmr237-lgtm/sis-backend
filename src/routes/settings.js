const express = require('express');
const bcrypt = require('bcryptjs');
const { prisma } = require('../db/prisma');
const { validatePassword } = require('../utils/validatePassword');
const { resolveSchoolTerm } = require('../utils/academicTerm');

const router = express.Router();

router.get('/', async (_req, res) => {
  const schoolId = _req.user.schoolId;
  const school = await prisma.school.findUnique({ where: { id: schoolId } });
  if (!school) {
    return res.status(404).json({ error: 'School settings not found.' });
  }
  res.json(school);
});

// PUT / — updates school settings. Raw academicYear/currentTerm are always
// stored/returned as given (or unchanged) — resolving what to *display* is
// the frontend's job (via the shared academicTerm resolver), computed live
// on every render rather than baked into a response that could get cached.
// If the request touches academicYear or currentTerm without explicitly
// setting autoTermEnabled, that's a manual edit: auto-detect gets switched
// off so the edit sticks instead of being silently overwritten on the next
// read. An explicit autoTermEnabled in the body (the Settings page toggle)
// always wins.
router.put('/', async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    const current = await prisma.school.findUnique({ where: { id: schoolId } });
    if (!current) {
      return res.status(404).json({ error: 'School settings not found.' });
    }

    const data = { ...req.body };
    const togglesAuto = Object.prototype.hasOwnProperty.call(data, 'autoTermEnabled');
    if (!togglesAuto) {
      // Compare against what the school is CURRENTLY reporting (live-computed
      // when auto is on), not the raw stored row — otherwise re-submitting an
      // untouched, auto-resolved form value would look like a manual edit
      // just because it differs from a stale placeholder in the database.
      const currentDisplay = resolveSchoolTerm(current);
      const editsAcademicYear = Object.prototype.hasOwnProperty.call(data, 'academicYear') && data.academicYear !== currentDisplay.academicYear;
      const editsCurrentTerm = Object.prototype.hasOwnProperty.call(data, 'currentTerm') && data.currentTerm !== currentDisplay.term;
      if (current.autoTermEnabled && (editsAcademicYear || editsCurrentTerm)) {
        data.autoTermEnabled = false;
      }
    }

    const updated = await prisma.school.update({
      where: { id: schoolId },
      data,
    });
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/password', async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body || {};
  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({ code: 'MISSING_FIELDS', error: 'All fields are required.' });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ code: 'PASSWORD_MISMATCH', error: 'Passwords do not match.' });
  }

  const currentOk = await bcrypt.compare(String(currentPassword), req.user.passwordHash);
  if (!currentOk) {
    return res.status(400).json({ code: 'WRONG_PASSWORD', error: 'Current password is incorrect.' });
  }

  const pwCheck = validatePassword(String(newPassword));
  if (!pwCheck.valid) {
    return res.status(400).json({ code: 'WEAK_PASSWORD', error: pwCheck.message });
  }

  try {
    const passwordHash = await bcrypt.hash(String(newPassword), 10);
    await prisma.adminUser.update({ where: { id: req.user.id }, data: { passwordHash } });
    res.json({ message: 'Password updated successfully.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
