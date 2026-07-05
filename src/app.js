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
const dashboardRouter = require('./routes/dashboard');
const classesRouter = require('./routes/classes');
const subjectsRouter = require('./routes/subjects');
const uploadRouter = require('./routes/upload');
const ledgerRouter = require('./routes/ledger');
const chargeCategoriesRouter = require('./routes/chargeCategories');

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
  credentials: true,
}));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Public routes
app.use('/auth', authRouter);

// All routes below this line are protected
app.use(authMiddleware);

app.use('/students', studentsRouter);
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

module.exports = app;
