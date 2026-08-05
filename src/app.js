const express = require('express');
const cors = require('cors');
const { authMiddleware } = require('./auth');
const { requireAdmin } = require('./roleGuards');

const studentsRouter = require('./routes/students');
const staffRouter = require('./routes/staff');
const expensesRouter = require('./routes/expenses');
const attendanceRouter = require('./routes/attendance');
const workRecordsRouter = require('./routes/workRecords');
const reportCardsRouter = require('./routes/reportCards');
const timetableRouter = require('./routes/timetable');
const settingsRouter = require('./routes/settings');
const authRouter = require('./routes/auth');
const passwordResetRouter = require('./routes/passwordReset');
const dashboardRouter = require('./routes/dashboard');
const classesRouter = require('./routes/classes');
const subjectsRouter = require('./routes/subjects');
const uploadRouter = require('./routes/upload');
const ledgerRouter = require('./routes/ledger');
const chargeCategoriesRouter = require('./routes/chargeCategories');
const onboardingRouter = require('./routes/onboarding');
const pickupContactsRouter = require('./routes/pickupContacts');
const testExamsRouter = require('./routes/testExams');
const parentsRouter = require('./routes/parents');
const academicYearRouter = require('./routes/academicYear');
const cronRouter = require('./routes/cron');

const app = express();

const ALLOWED_ORIGINS = [
  "https://sis-snowy.vercel.app",
  process.env.ORIGIN || "http://localhost:3000"
];

// Refusing an origin has to ABORT the request, not just withhold a header.
//
// cors@2.8.5 only breaks the middleware chain when this callback yields an
// Error: look at corsMiddleware in node_modules/cors/lib/index.js — on
// `cb(null, false)`, and on the plain array form this used to be configured
// with, it calls next() with NO error. The request then runs to completion and
// cors merely omits Access-Control-Allow-Origin, so the browser discards a
// response the server has already produced — writes included. A rejected
// cross-origin POST still committed its changes; only the reply was thrown
// away, which also means a client retry could apply it twice.
//
// Passing an Error is therefore the whole fix: it is what turns "not allowed"
// into "not executed".
function corsOriginCheck(origin, callback) {
  // No Origin header at all — not a browser cross-origin request. Vercel's cron
  // invocations, uptime checks, curl and any server-to-server call land here.
  // They are authorised by CRON_SECRET or a session, never by origin, and they
  // neither need nor can use an Access-Control-Allow-Origin header.
  if (!origin) return callback(null, true);
  if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
  const denied = new Error('Origin not allowed');
  denied.code = 'CORS_ORIGIN_DENIED';
  return callback(denied);
}

// Registered FIRST — ahead of express.json() and every route — so a disallowed
// origin is turned away before anything else in the app touches the request,
// including body parsing. There is deliberately no app.options('*', cors())
// blanket handler any more: that answered every preflight permissively with
// `Access-Control-Allow-Origin: *`, which told the browser to go ahead and send
// the real request that then executed. cors() below handles preflight for the
// allowed origins by itself.
app.use(cors({
  origin: corsOriginCheck,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  // Without this, the browser silently drops X-Refreshed-Token from the
  // response — CORS only exposes a small safelisted set of headers to JS
  // by default, and the rolling session depends on the client reading it.
  exposedHeaders: ["X-Refreshed-Token"],
  credentials: true,
}));

// Converts the refusal above into a definitive 403. It sits immediately after
// the CORS middleware because cors() signals refusal with next(err): Express
// then skips every remaining ordinary middleware AND every route to reach the
// next error handler, which is this one. That skip is what guarantees no route
// handler runs. It applies to the preflight too, so a denied browser is stopped
// at OPTIONS and never sends the real request at all.
//
// Anything that is not a CORS denial is passed along untouched.
app.use((err, _req, res, next) => {
  if (err && err.code === 'CORS_ORIGIN_DENIED') {
    return res.status(403).json({
      code: 'ORIGIN_NOT_ALLOWED',
      error: 'This origin is not allowed to call this API.',
    });
  }
  return next(err);
});

app.use(express.json());

// Nothing this API returns may ever be stored by a shared cache. Every response
// is either a credential (the login token), data scoped to one school, or an
// authentication decision — and the cache key an intermediary would use does
// NOT include Authorization, so a proxy that caches one of these can serve one
// user's data, or a stale 401, to somebody else's authenticated request.
//
// This has to be set explicitly because a Vercel function that returns no
// Cache-Control of its own gets `public, max-age=0, must-revalidate` filled in
// for it — `public` being exactly the wrong default here. Registered before
// every route and before authMiddleware so it also lands on the 401s that
// middleware returns early, which are the most damaging responses to cache.
app.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
  res.setHeader('Pragma', 'no-cache'); // HTTP/1.0 intermediaries
  res.setHeader('Expires', '0');
  // Belt-and-braces for anything that ignores no-store but honours Vary: make
  // the token part of the cache key so entries can't cross accounts.
  res.vary('Authorization');
  next();
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Public routes
app.use('/auth', authRouter);
app.use('/password-reset', passwordResetRouter);
// Scheduled jobs authenticate with CRON_SECRET, not a session, so they mount
// above authMiddleware. See src/routes/cron.js.
app.use('/cron', cronRouter);

// All routes below this line are protected
app.use(authMiddleware);

// Mixed routers: these serve BOTH actor types, so the admin/teacher split is
// made per route inside them (requireAdmin / requireTeacher) and, for the reads
// a teacher is allowed, narrowed to their own classes and subjects.
app.use('/students', studentsRouter);
app.use('/staff', staffRouter);
app.use('/attendance', attendanceRouter);
app.use('/timetable', timetableRouter);
app.use('/ledger', ledgerRouter);
app.use('/test-exams', testExamsRouter);

// Admin-only routers, gated here at the mount rather than route by route.
//
// A teacher's token is a perfectly valid session, so authMiddleware alone lets
// it reach every router below — school finances, payroll, other people's staff
// records, the whole class and fee configuration. Guarding at the mount is what
// makes that safe by construction: a route added to any of these routers later
// inherits the check instead of depending on whoever adds it remembering. If one
// of these ever needs a teacher-facing endpoint, move it up to the group above
// and gate the individual routes.
app.use('/students/:studentId/pickup-contacts', requireAdmin, pickupContactsRouter);
app.use('/parents', requireAdmin, parentsRouter);
app.use('/expenses', requireAdmin, expensesRouter);
app.use('/work-records', requireAdmin, workRecordsRouter);
app.use('/report-cards', requireAdmin, reportCardsRouter);
app.use('/settings', requireAdmin, settingsRouter);
app.use('/academic-year', requireAdmin, academicYearRouter);
app.use('/dashboard', requireAdmin, dashboardRouter);
app.use('/classes', requireAdmin, classesRouter);
app.use('/subjects', requireAdmin, subjectsRouter);
app.use('/upload', requireAdmin, uploadRouter);
app.use('/charge-categories', requireAdmin, chargeCategoriesRouter);
app.use('/onboarding', requireAdmin, onboardingRouter);

module.exports = app;
