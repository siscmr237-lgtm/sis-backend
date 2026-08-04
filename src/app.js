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

app.use(express.json());
app.options('*', cors());

app.use(cors({
  origin: [
    "https://sis-snowy.vercel.app",
    process.env.ORIGIN || "http://localhost:3000"
  ],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  // Without this, the browser silently drops X-Refreshed-Token from the
  // response — CORS only exposes a small safelisted set of headers to JS
  // by default, and the rolling session depends on the client reading it.
  exposedHeaders: ["X-Refreshed-Token"],
  credentials: true,
}));

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
