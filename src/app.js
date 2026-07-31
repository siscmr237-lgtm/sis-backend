const express = require('express');
const cors = require('cors');
const { authMiddleware } = require('./auth');

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
  //
  // The Age/X-Vercel-* entries are TEMPORARY, added alongside the client-side
  // auth diagnostic (SIS/src/lib/authDiagnostic.ts): they are what lets the
  // client tell "the app returned 401" apart from "a cache handed us a stale
  // 401", and neither is readable from JS unless exposed here. Remove them
  // together with that diagnostic.
  exposedHeaders: [
    "X-Refreshed-Token",
    "Age",
    "X-Vercel-Cache",
    "X-Vercel-Id",
    "ETag",
    "Date",
  ],
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

// All routes below this line are protected
app.use(authMiddleware);

app.use('/students', studentsRouter);
app.use('/students/:studentId/pickup-contacts', pickupContactsRouter);
app.use('/parents', parentsRouter);
app.use('/staff', staffRouter);
app.use('/expenses', expensesRouter);
app.use('/attendance', attendanceRouter);
app.use('/work-records', workRecordsRouter);
app.use('/report-cards', reportCardsRouter);
app.use('/timetable', timetableRouter);
app.use('/settings', settingsRouter);
app.use('/dashboard', dashboardRouter);
app.use('/classes', classesRouter);
app.use('/subjects', subjectsRouter);
app.use('/upload', uploadRouter);
app.use('/ledger', ledgerRouter);
app.use('/charge-categories', chargeCategoriesRouter);
app.use('/onboarding', onboardingRouter);
app.use('/test-exams', testExamsRouter);

module.exports = app;
