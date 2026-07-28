const jwt = require('jsonwebtoken');
const { prisma } = require('./db/prisma');
const { signSessionToken } = require('./utils/sessionToken');

const JWT_SECRET = process.env.JWT_SECRET;

async function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

  if (!token) {
    return res.status(401).json({ code: 'SESSION_INVALID', error: 'Your session is no longer valid.' });
  }

  // A malformed/expired/tampered token is the only thing that genuinely means
  // "this session is dead" — verified separately from the DB lookup below so
  // the two failure modes can never be conflated.
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ code: 'SESSION_INVALID', error: 'Your session is no longer valid.' });
  }

  // A transient failure here (DB blip, connection pool exhaustion, etc.) is
  // NOT proof the session is invalid — surfacing it as SESSION_INVALID would
  // log out a genuinely active user over a server hiccup that has nothing to
  // do with their token. This is the same bug class as the earlier fix for
  // the stale post-logout 401: don't let an unrelated failure masquerade as
  // "your session expired."
  let user;
  try {
    user = await prisma.adminUser.findUnique({ where: { id: payload.sub }, include: { School: true } });
  } catch (e) {
    console.error('authMiddleware: user lookup failed', e);
    return res.status(503).json({ code: 'SERVER_UNAVAILABLE', error: 'Something went wrong on our end. Please try again.' });
  }

  if (!user || user.isActive === false || !user.School.length) {
    return res.status(401).json({ code: 'SESSION_INVALID', error: 'Your session is no longer valid.' });
  }

  req.user = {
    ...user,
    schoolId: user.School[0].id,
  };

  // Rolling idle timeout: genuine activity (any real API call reaching this
  // point) extends the session. There is no background/keepalive polling
  // anywhere in this app — every call here is a real user-triggered feature
  // call — so an idle tab that makes no calls simply isn't extended, and its
  // last-issued token lapses on its own.
  res.setHeader('X-Refreshed-Token', signSessionToken(user));

  next();
}

module.exports = { authMiddleware };