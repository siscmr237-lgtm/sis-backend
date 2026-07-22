const jwt = require('jsonwebtoken');
const { prisma } = require('./db/prisma');

const JWT_SECRET = process.env.JWT_SECRET;

async function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

  if (!token) {
    return res.status(401).json({ code: 'SESSION_INVALID', error: 'Your session is no longer valid.' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await prisma.adminUser.findUnique({ where: { id: payload.sub }, include: { School: true } });
    if (!user) return res.status(401).json({ code: 'SESSION_INVALID', error: 'Your session is no longer valid.' });
    if (user.isActive === false) return res.status(401).json({ code: 'SESSION_INVALID', error: 'Your session is no longer valid.' });
    if (!user.School.length) return res.status(401).json({ code: 'SESSION_INVALID', error: 'Your session is no longer valid.' });
    req.user = {
      ...user,
      schoolId: user.School[0].id,
    };
    next();
  } catch (e) {
    return res.status(401).json({ code: 'SESSION_INVALID', error: 'Your session is no longer valid.' });
  }
}

module.exports = { authMiddleware };