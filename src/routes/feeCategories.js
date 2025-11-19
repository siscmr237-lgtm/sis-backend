const express = require('express');
const { prisma } = require('../db/prisma');

const router = express.Router();

// Get all fee categories
router.get('/', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const items = await prisma.feeCategory.findMany({ where: { schoolId }, orderBy: { name: 'asc' } });
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create a new category for the school
router.post('/', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { name, limit = 0 } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const created = await prisma.feeCategory.create({ data: { name, limit: Number(limit) || 0, schoolId } });
    res.json(created);
  } catch (e) {
    if (e.code === 'P2002') {
      return res.status(409).json({ error: 'A fee category with this name already exists for this school.' });
    }
    res.status(500).json({ error: e.message });
  }
});

// Upsert by name for the school (Set Limit)
router.put('/upsert', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { name, limit = 0 } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const up = await prisma.feeCategory.upsert({
      where: { name_schoolId: { name, schoolId } },
      update: { limit: Number(limit) || 0 },
      create: { name, limit: Number(limit) || 0, schoolId },
    });
    res.json(up);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete by id, ensuring it belongs to the school
router.delete('/:id', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'id required' });

    // First verify the category belongs to the user's school
    const category = await prisma.feeCategory.findFirst({ where: { id, schoolId } });
    if (!category) {
      return res.status(404).json({ error: 'Fee category not found or does not belong to this school.' });
    }

    const deleted = await prisma.feeCategory.delete({ where: { id } });
    res.json(deleted);
  } catch (e) {
    // P2025 is Prisma's code for "record to delete does not exist"
    if (e.code === 'P2025') {
      return res.status(404).json({ error: 'Fee category not found.' });
    }
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
