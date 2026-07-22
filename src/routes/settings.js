const express = require('express');
const bcrypt = require('bcryptjs');
const { prisma } = require('../db/prisma');
const { validatePassword } = require('../utils/validatePassword');

const router = express.Router();

router.get('/', async (_req, res) => {
  const schoolId = _req.user.schoolId;
  const school = await prisma.school.findUnique({ where: { id: schoolId } });
  if (!school) {
    return res.status(404).json({ error: 'School settings not found.' });
  }
  res.json(school);
});

router.put('/', async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    const updated = await prisma.school.update({
      where: { id: schoolId },
      data: req.body,
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
