const express = require('express');
const cors = require('cors');
const { authMiddleware } = require('./auth');
const {
  requireAdmin,
  requireSchoolActor,
  requireApprovedSchool,
  refuseWhilePending,
  requirePlatformActor,
} = require('./roleGuards');

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
const platformAuthRouter = require('./routes/platformAuth');
const platformRouter = require('./routes/platform');
const schoolRouter = require('./routes/school');
const whatsappRouter = require('./routes/whatsapp');

const app = express();

const ALLOWED_ORIGINS = [
  // The live frontend. Both the apex and the www host are listed because a
  // browser treats them as DIFFERENT origins — matching here is exact, on
  // scheme, host and port, with no subdomain or suffix logic anywhere in this
  // list — so whichever one a visitor lands on has to appear by name or its
  // requests are refused.
  "https://lewa.app",
  "https://www.lewa.app",
  // The previous Vercel domain, kept on purpose rather than replaced: the
  // deployment still answers on it, so anything still pointed there — an open
  // tab, a bookmark, a preview link — keeps working instead of failing as an
  // unreadable CORS error.
  "https://sis-snowy.vercel.app",
  // Local development, or whatever ORIGIN is set to in this environment.
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
// The platform door. Login ONLY — there is no signup route and no
// forgot-password route on it. See src/routes/platformAuth.js.
app.use('/platform/auth', platformAuthRouter);
// Scheduled jobs authenticate with CRON_SECRET, not a session, so they mount
// above authMiddleware. See src/routes/cron.js.
app.use('/cron', cronRouter);

// All routes below this line are protected
app.use(authMiddleware);

// ── THE INTERNAL CONSOLE ────────────────────────────────────────────────────
// Mounted BEFORE requireSchoolActor below, so platform traffic never reaches
// it. requirePlatformActor is the second of the two directions: an admin or
// teacher token is a perfectly valid session and would otherwise pass straight
// through authMiddleware into this router.
app.use('/platform', requirePlatformActor, platformRouter);

// ── THE SCHOOL API ──────────────────────────────────────────────────────────
// THE CHOKE POINT. Every route below refuses a platform token, once, here —
// rather than each route remembering to check.
//
// The danger is specific and quiet. Every school-scoped query filters by
// req.user.schoolId, a platform session has no schoolId, and Prisma reads
// `where: { schoolId: undefined }` as "no filter" rather than as an error. So a
// platform token reaching any of these routers would not be denied; it would be
// served EVERY school's rows. Refusing by position means a school router added
// later inherits the refusal instead of depending on whoever adds it.
app.use(requireSchoolActor);

// ── WHAT AN UNAPPROVED SCHOOL STILL NEEDS ───────────────────────────────────
// Mounted ABOVE requireApprovedSchool because this is how a school that is not
// approved finds out where it stands and gets itself approved. Behind the gate
// these would be unreachable and the waiting page would have nothing to read.
//
// /school is the status endpoint and the "Not Done" reopen — the only two calls
// the waiting page makes, and the reason it can tell a school anything at all.
//
// /onboarding is the KYC form. Every status except PENDING has a reason to be
// in it: INCOMPLETE and FAILED are a school signing up, APPROVED is a live
// school editing its own particulars. refuseWhilePending states that one
// exception rather than leaving the router open to all four.
//
// /upload is here for one reason — the onboarding form uploads the school's
// logo through it (postImage in SIS/src/lib/uploadImage.ts) before the form is
// submitted, so a school signing up has to be able to reach it or it cannot
// finish signing up. It carries the same rule as the form it serves.
app.use('/school', requireAdmin, schoolRouter);
app.use('/onboarding', requireAdmin, refuseWhilePending, onboardingRouter);
app.use('/upload', requireAdmin, refuseWhilePending, uploadRouter);

// ── THE APPROVAL GATE ───────────────────────────────────────────────────────
// Everything below here requires a school the platform team has APPROVED, and
// re-checks that on every single request.
//
// Position is the whole design, same as requireSchoolActor above it: approval
// can be withdrawn at any moment, from another browser, while this school's
// token stays valid — so the check cannot be something a route remembers to do,
// and it cannot be something the client is trusted to do. A router added below
// this line inherits the refusal. See requireApprovedSchool in roleGuards.js.
app.use(requireApprovedSchool);

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
app.use('/charge-categories', requireAdmin, chargeCategoriesRouter);
// Outbound WhatsApp to guardians. requireAdmin for the same reason as school
// finances above it, and it IS school finances: every route in this router puts
// a balance from the ledger onto a parent's phone, and a WhatsApp cannot be
// unsent. A teacher holds a valid session and would otherwise reach it.
app.use('/whatsapp', requireAdmin, whatsappRouter);

// /school, /onboarding and /upload are mounted further up, above the approval
// gate — they are the only school routers a school that is not APPROVED may
// reach, and why is written out at that mount.
// Both are admin-only there for the same reason as everything in this group: a
// teacher has no signup of their own, and the waiting page they would be
// answering for is not a screen they can reach.

module.exports = app;
