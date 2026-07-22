const express = require('express');
const { prisma } = require('../db/prisma');

const router = express.Router({ mergeParams: true });

// Resolve student by code or numeric id, scoped to the school.
async function findStudent(schoolId, studentIdParam) {
  return prisma.student.findFirst({
    where: {
      schoolId,
      OR: [
        { code: studentIdParam },
        { id: parseInt(studentIdParam) || 0 },
      ],
    },
  });
}

// GET /students/:studentId/pickup-contacts
router.get('/', async (req, res) => {
  const schoolId = req.user.schoolId;
  const student = await findStudent(schoolId, req.params.studentId);
  if (!student) return res.status(404).json({ error: 'Student not found' });

  const contacts = await prisma.pickupContact.findMany({
    where: { studentId: student.id },
    orderBy: { createdAt: 'asc' },
  });
  res.json(contacts);
});

// POST /students/:studentId/pickup-contacts
router.post('/', async (req, res) => {
  const schoolId = req.user.schoolId;
  const student = await findStudent(schoolId, req.params.studentId);
  if (!student) return res.status(404).json({ error: 'Student not found' });

  const { name, phone, relationship } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  if (!phone || !phone.trim()) return res.status(400).json({ error: 'phone is required' });

  try {
    const contact = await prisma.pickupContact.create({
      data: {
        studentId: student.id,
        name: name.trim(),
        phone: phone.trim(),
        relationship: relationship?.trim() || null,
      },
    });
    res.status(201).json(contact);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// PUT /students/:studentId/pickup-contacts/:contactId
router.put('/:contactId', async (req, res) => {
  const schoolId = req.user.schoolId;
  const student = await findStudent(schoolId, req.params.studentId);
  if (!student) return res.status(404).json({ error: 'Student not found' });

  const contactId = parseInt(req.params.contactId);
  const existing = await prisma.pickupContact.findFirst({
    where: { id: contactId, studentId: student.id },
  });
  if (!existing) return res.status(404).json({ error: 'Contact not found' });

  const { name, phone, relationship } = req.body || {};
  try {
    const updated = await prisma.pickupContact.update({
      where: { id: contactId },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(phone !== undefined && { phone: phone.trim() }),
        ...(relationship !== undefined && { relationship: relationship?.trim() || null }),
        updatedAt: new Date(),
      },
    });
    res.json(updated);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /students/:studentId/pickup-contacts/:contactId
router.delete('/:contactId', async (req, res) => {
  const schoolId = req.user.schoolId;
  const student = await findStudent(schoolId, req.params.studentId);
  if (!student) return res.status(404).json({ error: 'Student not found' });

  const contactId = parseInt(req.params.contactId);
  const existing = await prisma.pickupContact.findFirst({
    where: { id: contactId, studentId: student.id },
  });
  if (!existing) return res.status(404).json({ error: 'Contact not found' });

  await prisma.pickupContact.delete({ where: { id: contactId } });
  res.json(existing);
});

module.exports = router;
