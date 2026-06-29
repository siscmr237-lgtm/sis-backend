const express = require('express');
const { prisma } = require('../db/prisma');

const router = express.Router();

const CLASS_SUBJECT_MAP = {
  'Day Care':    ['Sensory and Perceptive Activities', 'Basic Language & Communication', 'Motor Skills', 'Practical Life Skills', 'Rhymes and Songs'],
  'Pre-Nursery': ['Sensory and Perceptive Activities', 'Basic Language & Communication', 'Motor Skills', 'Practical Life Skills', 'Rhymes and Songs'],
  'Nursery 1':   ['Storytelling', 'Poetry and Rhymes', 'Reading', 'Writing', 'French Oral', 'Sign Language / Gestures', 'Mathematics', 'Sensory Education', 'Basic Science and Technology', 'Agriculture', 'ICT', 'Citizenship and Character Education', 'Environmental Education', 'Safety and Health Education', 'Drawing and Coloring', 'Painting and Graphic Art', 'Handwork / Crafts', 'Music and Dance', 'Motor Skills'],
  'Nursery 2':   ['Storytelling', 'Poetry and Rhymes', 'Reading', 'Writing', 'French Oral', 'Sign Language / Gestures', 'Mathematics', 'Sensory Education', 'Basic Science and Technology', 'Agriculture', 'ICT', 'Citizenship and Character Education', 'Environmental Education', 'Safety and Health Education', 'Drawing and Coloring', 'Painting and Graphic Art', 'Handwork / Crafts', 'Music and Dance', 'Motor Skills'],
  'Class 1':     ['English Language', 'French Language', 'Mathematics', 'Science and Technology', 'General Knowledge', 'Citizenship', 'National Culture', 'Physical Education', 'ICT'],
  'Class 2':     ['English Language', 'French Language', 'Mathematics', 'Science and Technology', 'General Knowledge', 'Citizenship', 'National Culture', 'Physical Education', 'ICT'],
  'Class 3':     ['English Language', 'French Language', 'Mathematics', 'Science and Technology', 'Home Economics', 'History', 'Geography', 'Citizenship', 'National Culture', 'Physical Education'],
  'Class 4':     ['English Language', 'French Language', 'Mathematics', 'Science and Technology', 'Home Economics', 'History', 'Geography', 'Citizenship', 'National Culture', 'Physical Education'],
  'Class 5':     ['English Language', 'French Language', 'Mathematics', 'Science and Technology', 'Home Economics', 'History', 'Geography', 'Citizenship', 'National Culture', 'Physical Education', 'ICT'],
  'Class 6':     ['English Language', 'French Language', 'Mathematics', 'Science and Technology', 'Home Economics', 'History', 'Geography', 'Citizenship', 'National Culture', 'Physical Education', 'ICT'],
};

const ALL_SUBJECT_NAMES = [...new Set(Object.values(CLASS_SUBJECT_MAP).flat())];

// GET /subjects
router.get('/', async (req, res) => {
  const schoolId = req.user.schoolId;
  const subjects = await prisma.subject.findMany({
    where: { schoolId },
    orderBy: { name: 'asc' },
  });
  res.json(subjects);
});

// POST /subjects
router.post('/', async (req, res) => {
  const schoolId = req.user.schoolId;
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const created = await prisma.subject.create({ data: { name, schoolId } });
    res.status(201).json(created);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'A subject with this name already exists in this school.' });
    res.status(500).json({ error: e.message });
  }
});

// DELETE /subjects/:id
router.delete('/:id', async (req, res) => {
  const schoolId = req.user.schoolId;
  const found = await prisma.subject.findFirst({
    where: { schoolId, id: parseInt(req.params.id) || 0 },
  });
  if (!found) return res.status(404).json({ error: 'Not found' });
  await prisma.subject.delete({ where: { id: found.id } });
  res.json(found);
});

// POST /subjects/seed-standard
// Safe to run multiple times — skips subjects and links that already exist.
router.post('/seed-standard', async (req, res) => {
  const schoolId = req.user.schoolId;

  // 1. Create all subjects in the catalog; skip any that already exist.
  await prisma.subject.createMany({
    data: ALL_SUBJECT_NAMES.map((name) => ({ name, schoolId })),
    skipDuplicates: true,
  });

  // 2. Fetch the now-complete subject map for this school.
  const subjects = await prisma.subject.findMany({ where: { schoolId } });
  const subjectByName = Object.fromEntries(subjects.map((s) => [s.name, s.id]));

  // 3. For each class name in the mapping, find the matching Class rows for this school.
  const classNames = Object.keys(CLASS_SUBJECT_MAP);
  const classes = await prisma.class.findMany({
    where: { schoolId, name: { in: classNames } },
  });
  const classByName = Object.fromEntries(classes.map((c) => [c.name, c.id]));

  // 4. Build the full set of ClassSubject links to create.
  const links = [];
  for (const [className, subjectNames] of Object.entries(CLASS_SUBJECT_MAP)) {
    const classId = classByName[className];
    if (classId == null) continue; // class doesn't exist in this school — skip
    for (const subjectName of subjectNames) {
      const subjectId = subjectByName[subjectName];
      if (subjectId == null) continue;
      links.push({ classId, subjectId });
    }
  }

  // 5. Create links, skipping any that already exist.
  const { count } = await prisma.classSubject.createMany({ data: links, skipDuplicates: true });

  res.json({
    subjectsInCatalog: ALL_SUBJECT_NAMES.length,
    classLinksCreated: count,
    classesMatched: Object.keys(classByName).length,
    classesInMapping: classNames.length,
  });
});

module.exports = router;
