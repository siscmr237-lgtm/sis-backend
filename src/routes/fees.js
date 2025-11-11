const express = require('express');
const { prisma } = require('../db/prisma');
const { mapWithIdAsCode, withIdAsCode } = require('../utils/response');

const router = express.Router();
const genCode = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

router.get('/', async (req, res) => {
  const { studentId } = req.query;
  let where = {};
  if (studentId) {
    const student = await prisma.student.findFirst({ where: { OR: [{ code: String(studentId) }, { id: String(studentId) }] } });
    where = student ? { studentId: student.id } : { studentId: '__none__' };
  }
  const rows = await prisma.fee.findMany({ where, orderBy: { code: 'asc' } });
  res.json(mapWithIdAsCode(rows));
});

router.get('/:id', async (req, res) => {
  const row = await prisma.fee.findFirst({ where: { OR: [{ code: req.params.id }, { id: req.params.id }] } });
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(withIdAsCode(row));
});

router.post('/', async (req, res) => {
  const b = req.body || {};
  try {
    const student = await prisma.student.findFirst({ where: { OR: [{ code: b.studentId }, { id: b.studentId }] } });
    if (!student) return res.status(400).json({ error: 'Invalid studentId' });
    const created = await prisma.fee.create({
      data: {
        code: b.id || genCode('FEE'),
        studentId: student.id,
        studentName: b.studentName,
        class: b.class,
        term: b.term,
        academicYear: b.academicYear,
        tuitionFee: Number(b.tuitionFee ?? 0),
        registrationFee: Number(b.registrationFee ?? 0),
        uniformFee: Number(b.uniformFee ?? 0),
        booksFee: Number(b.booksFee ?? 0),
        otherFees: Number(b.otherFees ?? 0),
        totalAmount: Number(b.totalAmount ?? 0),
        amountPaid: Number(b.amountPaid ?? 0),
        balance: Number(b.balance ?? 0),
        paymentDate: b.paymentDate ? new Date(b.paymentDate) : new Date(),
        paymentMethod: b.paymentMethod,
      },
    });
    res.status(201).json(withIdAsCode(created));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const found = await prisma.fee.findFirst({ where: { OR: [{ code: req.params.id }, { id: req.params.id }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  try {
    const updated = await prisma.fee.update({
      where: { id: found.id },
      data: {
        ...req.body,
        tuitionFee: req.body?.tuitionFee != null ? Number(req.body.tuitionFee) : undefined,
        registrationFee: req.body?.registrationFee != null ? Number(req.body.registrationFee) : undefined,
        uniformFee: req.body?.uniformFee != null ? Number(req.body.uniformFee) : undefined,
        booksFee: req.body?.booksFee != null ? Number(req.body.booksFee) : undefined,
        otherFees: req.body?.otherFees != null ? Number(req.body.otherFees) : undefined,
        totalAmount: req.body?.totalAmount != null ? Number(req.body.totalAmount) : undefined,
        amountPaid: req.body?.amountPaid != null ? Number(req.body.amountPaid) : undefined,
        balance: req.body?.balance != null ? Number(req.body.balance) : undefined,
        paymentDate: req.body?.paymentDate ? new Date(req.body.paymentDate) : undefined,
      },
    });
    res.json(withIdAsCode(updated));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const found = await prisma.fee.findFirst({ where: { OR: [{ code: req.params.id }, { id: req.params.id }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  await prisma.fee.delete({ where: { id: found.id } });
  res.json(withIdAsCode(found));
});

module.exports = router;
