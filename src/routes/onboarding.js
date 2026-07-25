const express = require('express');
const { prisma } = require('../db/prisma');
const { CLASS_CATALOG } = require('../utils/classCatalog');

const router = express.Router();

const VALID_SCHOOL_TYPES = ['DAYCARE_NURSERY', 'DAYCARE_NURSERY_PRIMARY'];
const VALID_UNIFORM_GARMENTS = ['shirt', 'trouser', 'gown'];
const genCode = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

// GET /onboarding/class-catalog?schoolType=DAYCARE_NURSERY_PRIMARY
// Returns the catalog filtered to the given school type (or all entries if omitted).
router.get('/class-catalog', (req, res) => {
  const { schoolType } = req.query;
  if (schoolType) {
    if (!VALID_SCHOOL_TYPES.includes(schoolType)) {
      return res.status(400).json({ error: `schoolType must be one of: ${VALID_SCHOOL_TYPES.join(', ')}` });
    }
    return res.json(CLASS_CATALOG.filter(c => c.schoolTypes.includes(schoolType)));
  }
  res.json(CLASS_CATALOG);
});

// POST /onboarding
// Body: { schoolType, classNames, motto?, address?, logo?, uniformColors? }
// uniformColors, if present, is { shirt?, trouser?, gown? } with each value a color
// label string or null — one independent color choice per garment.
// Saves fields to the school, auto-creates class records, sets onboardingCompleted = true.
router.post('/', async (req, res) => {
  const schoolId = req.user.schoolId;

  const { schoolType, classNames, motto, address, logo, uniformColors } = req.body || {};

  if (!VALID_SCHOOL_TYPES.includes(schoolType)) {
    return res.status(400).json({ error: `schoolType must be one of: ${VALID_SCHOOL_TYPES.join(', ')}` });
  }
  if (!Array.isArray(classNames) || classNames.length === 0) {
    return res.status(400).json({ error: 'classNames must be a non-empty array' });
  }
  if (uniformColors !== undefined) {
    if (typeof uniformColors !== 'object' || uniformColors === null || Array.isArray(uniformColors)) {
      return res.status(400).json({ error: 'uniformColors must be an object with shirt, trouser, gown keys' });
    }
    const invalidKeys = Object.keys(uniformColors).filter(k => !VALID_UNIFORM_GARMENTS.includes(k));
    if (invalidKeys.length) {
      return res.status(400).json({ error: `Invalid uniformColors keys: ${invalidKeys.join(', ')}` });
    }
  }

  // A submitted name is valid if it matches a catalog entry exactly, or is a
  // catalog entry plus a single section-letter suffix (e.g. "Class 1A" for
  // section A of "Class 1", from the onboarding "how many sections?" input).
  const validNamesForType = CLASS_CATALOG
    .filter(c => c.schoolTypes.includes(schoolType))
    .map(c => c.name);
  const isValidClassName = (n) => {
    if (validNamesForType.includes(n)) return true;
    const lastChar = n.slice(-1);
    return /^[A-Z]$/.test(lastChar) && validNamesForType.includes(n.slice(0, -1));
  };
  const invalid = classNames.filter(n => !isValidClassName(n));
  if (invalid.length) {
    return res.status(400).json({
      error: `Invalid class names for school type ${schoolType}: ${invalid.join(', ')}`,
    });
  }

  try {
    const school = await prisma.school.findUnique({ where: { id: schoolId } });
    if (!school) return res.status(404).json({ error: 'School not found' });

    await prisma.school.update({
      where: { id: schoolId },
      data: {
        schoolType,
        onboardingCompleted: true,
        ...(motto !== undefined && { motto }),
        ...(address !== undefined && { address }),
        ...(logo !== undefined && { logo }),
        ...(uniformColors !== undefined && { uniformColors }),
      },
    });

    // Create each selected class, skipping any that already exist.
    // PgBouncer transaction mode doesn't support interactive transactions,
    // so we run these sequentially. Each createMany skipDuplicates makes it idempotent.
    await prisma.class.createMany({
      data: classNames.map(name => ({ code: genCode('CLS'), name, schoolId })),
      skipDuplicates: true,
    });

    const updated = await prisma.school.findUnique({ where: { id: schoolId } });
    const classes = await prisma.class.findMany({
      where: { schoolId },
      orderBy: { name: 'asc' },
    });
    res.json({ school: updated, classes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
