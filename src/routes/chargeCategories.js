const express = require('express');
const { prisma } = require('../db/prisma');

const router = express.Router();

// GET /charge-categories?forStaff=true|false
router.get('/', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const forStaff = req.query.forStaff === 'true';
    const items = await prisma.chargeCategory.findMany({ where: { schoolId, forStaff }, orderBy: { name: 'asc' } });
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /charge-categories
router.post('/', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { name, limit = 0 } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const created = await prisma.chargeCategory.create({
      data: { name, limit: Number(limit) || 0, isBuiltIn: false, schoolId },
    });
    res.status(201).json(created);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'A category with this name already exists for this school.' });
    res.status(500).json({ error: e.message });
  }
});

// PUT /charge-categories/:id
router.put('/:id', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const id = parseInt(req.params.id) || 0;
    const category = await prisma.chargeCategory.findFirst({ where: { id, schoolId } });
    if (!category) return res.status(404).json({ error: 'Category not found' });

    const { name, limit } = req.body || {};
    if (name !== undefined && category.isBuiltIn && name !== category.name) {
      return res.status(403).json({ error: 'Cannot rename a built-in category' });
    }

    const updated = await prisma.chargeCategory.update({
      where: { id: category.id },
      data: {
        ...(name !== undefined && !category.isBuiltIn ? { name } : {}),
        ...(limit !== undefined ? { limit: Number(limit) || 0 } : {}),
      },
    });
    res.json(updated);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'A category with this name already exists for this school.' });
    res.status(500).json({ error: e.message });
  }
});

// DELETE /charge-categories/:id
router.delete('/:id', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const id = parseInt(req.params.id) || 0;
    const category = await prisma.chargeCategory.findFirst({ where: { id, schoolId } });
    if (!category) return res.status(404).json({ error: 'Category not found' });
    if (category.isBuiltIn) return res.status(403).json({ error: 'Cannot delete a built-in category' });

    const refCount = await prisma.ledgerEntry.count({ where: { categoryId: category.id } });
    if (refCount > 0) {
      return res.status(409).json({ error: `Cannot delete: ${refCount} ledger entr${refCount === 1 ? 'y' : 'ies'} reference this category` });
    }

    await prisma.chargeCategory.delete({ where: { id: category.id } });
    res.json(category);
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'Category not found.' });
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
