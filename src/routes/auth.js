const express = require('express');
const { prisma } = require('../db/prisma');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_TTL = '7d';

function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role, phoneNumber: user.phoneNumber }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

// POST /api/auth/login { phoneNumber, password }
router.post('/login', async (req, res) => {
  try {
    const { phoneNumber, password } = req.body || {};
    if (!phoneNumber || !password) return res.status(400).json({ error: 'phoneNumber and password required' });
    const user = await prisma.adminUser.findUnique({ where: { phoneNumber }});
    const newUser = await prisma.adminUser.findUnique({ where: { phoneNumber }, include: { School: true } });

    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(String(password), user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const token = signToken(user);
    return res.json({ token, user: newUser });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/signup { phoneNumber, password, schoolName }
router.post('/signup', async (req, res) => {
  try {
    const { phoneNumber, password, schoolName } = req.body || {};
    if (!phoneNumber || !password || !schoolName) {
      return res.status(400).json({ error: 'phoneNumber, password, and schoolName are required' });
    }

    const existingUser = await prisma.adminUser.findFirst({where: { phoneNumber }});
    if (existingUser) {
      return res.status(409).json({ error: 'An admin user already exists. Try loggin in' });
    }

    const passwordHash = await bcrypt.hash(String(password), 10);

      const user = await prisma.adminUser.create({
        data: {
          phoneNumber,
          passwordHash,
          name: 'School Admin',
          role: 'user',
        },
      });
      const school = await prisma.school.create({
        data: {
          name: schoolName,
          adminUserId: user.id,
          logo: 'https://img.freepik.com/premium-vector/school-building-illustration_638438-385.jpg',
          academicYear: '2025/2026',
          currentTerm: 'Term 1',
          subjectsPerClass: [],
          onboardingCompleted: false,
        },
      });
    const newUser = await prisma.adminUser.findUnique({ where: { phoneNumber }, include: { School: true } });

    const token = signToken(user);
    return res.status(201).json({ token, user: newUser });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/auth/me
router.get('/me',  async (req, res) => {
  try {
    // The auth middleware is now global, so req.user is already populated.
    const user = req.user;
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json({ id: user.id, name: user.name, phoneNumber: user.phoneNumber, role: user.role, schoolId: user.schoolId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
