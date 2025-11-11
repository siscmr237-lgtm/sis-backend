const express = require('express');
const { prisma } = require('../db/prisma');

const router = express.Router();

router.get('/', async (_req, res) => {
  const row = await prisma.schoolSettings.findUnique({ where: { id: 1 } });
  res.json(row);
});

router.put('/', async (req, res) => {
  try {
    const updated = await prisma.schoolSettings.upsert({
      where: { id: 1 },
      update: { ...req.body },
      create: { id: 1, name: '', logo: '', academicYear: '', currentTerm: '', subjectsPerClass: [] },
    });
    res.json(updated);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
