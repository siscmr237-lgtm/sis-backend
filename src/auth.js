const jwt = require('jsonwebtoken');
const { prisma } = require('./db/prisma');

const JWT_SECRET = process.env.JWT_SECRET;

async function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await prisma.adminUser.findUnique({ where: { id: payload.sub }, include: { School: true } });
    if (!user || !user.School) return res.status(401).json({ error: 'Unauthorized: Invalid user or school not found' });
    req.user = {
      ...user,
      schoolId: user.School[0].id,
    };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
}

module.exports = { authMiddleware };