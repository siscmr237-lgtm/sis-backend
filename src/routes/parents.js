const express = require('express');
const { prisma } = require('../db/prisma');

const router = express.Router();

// GET /parents/search?query= — case-insensitive partial match on name,
// strictly scoped to the logged-in admin's own school. Used to power the
// parent typeahead on the student forms.
router.get('/search', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const query = String(req.query.query || '').trim();
    if (!query) return res.json([]);

    const rows = await prisma.parent.findMany({
      where: { schoolId, name: { contains: query, mode: 'insensitive' } },
      select: { id: true, name: true, phone: true },
      orderBy: { name: 'asc' },
      take: 10,
    });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
