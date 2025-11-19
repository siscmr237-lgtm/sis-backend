const express = require('express');
const { prisma } = require('../db/prisma');

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

module.exports = router;
