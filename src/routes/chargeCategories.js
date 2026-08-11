const express = require('express');
const { prisma } = require('../db/prisma');
const { ensureStaffCategories } = require('../utils/staffPayroll');

const router = express.Router();

// GET /charge-categories?forStaff=true|false
//
// Staff-only in practice now. STUDENT fees are no longer ChargeCategory rows:
// they belong to a class LEVEL (see ClassLevelFee and GET
// /classes/levels/:level/fees), so nothing seeds student categories here any
// more and forStaff=false returns whatever a school created by hand.
router.get('/', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const forStaff = req.query.forStaff === 'true';
    // Seeded here as well as in the staff ledger route, because the staff
    // Finance tab requests both AT THE SAME TIME. Seeding from only one side
    // would hand the charge form a list missing the five fine categories
    // whenever this request won the race.
    if (forStaff) await ensureStaffCategories(prisma, schoolId);
    const items = await prisma.chargeCategory.findMany({
      where: { schoolId, forStaff },
      // Fines last, so the direction of the list is not something you have to
      // read the names to work out.
      orderBy: [{ staffOwes: 'asc' }, { name: 'asc' }],
    });
    res.json(items);
  } catch (e) {
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
