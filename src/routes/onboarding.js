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
  // catalog entry plus a space and a single section letter (e.g. "Class 1 A"
  // for section A of "Class 1", from the onboarding "how many sections?"
  // input). The space is required: it is the canonical separator the frontend
  // generates and the one existing rows were migrated to, so accepting the
  // older unspaced "Class 1A" here would let a second format back in.
  const validNamesForType = CLASS_CATALOG
    .filter(c => c.schoolTypes.includes(schoolType))
    .map(c => c.name);
  const SECTION_SUFFIX = /^(.+) ([A-Z])$/;
  const isValidClassName = (n) => {
    if (validNamesForType.includes(n)) return true;
    const m = SECTION_SUFFIX.exec(n);
    return Boolean(m) && validNamesForType.includes(m[1]);
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

    // Fee categories are NOT seeded here any more: they belong to a class
    // LEVEL, and each level gets its defaults the first time its fee structure
    // is opened (see ensureLevelFeeDefaults). Seeding every level up front
    // would create rows for levels the school may never configure.

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
