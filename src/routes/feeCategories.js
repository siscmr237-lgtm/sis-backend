const express = require('express');
const { prisma } = require('../db/prisma');

const router = express.Router();

// Get all fee categories
router.get('/', async (_req, res) => {
  try {
    const items = await prisma.feeCategory.findMany({ orderBy: { name: 'asc' } });
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create a new category
router.post('/', async (req, res) => {
  try {
    const { name, limit = 0 } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const created = await prisma.feeCategory.create({ data: { name, limit: Number(limit) || 0 } });
    res.json(created);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Upsert by name (Set Limit)
router.put('/upsert', async (req, res) => {
  try {
    const { name, limit = 0 } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const up = await prisma.feeCategory.upsert({
      where: { name },
      update: { limit: Number(limit) || 0 },
      create: { name, limit: Number(limit) || 0 },
    });
    res.json(up);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Delete by id
router.delete('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'id required' });
    const del = await prisma.feeCategory.delete({ where: { id } });
    res.json(del);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Delete by name
router.delete('/by-name/:name', async (req, res) => {
  try {
    const name = String(req.params.name);
    const del = await prisma.feeCategory.delete({ where: { name } });
    res.json(del);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
