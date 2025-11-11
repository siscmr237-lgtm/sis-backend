const express = require('express');
const cors = require('cors');

const studentsRouter = require('./routes/students');
const staffRouter = require('./routes/staff');
const feesRouter = require('./routes/fees');
const expensesRouter = require('./routes/expenses');
const attendanceRouter = require('./routes/attendance');
const workRecordsRouter = require('./routes/workRecords');
const reportCardsRouter = require('./routes/reportCards');
const timetableRouter = require('./routes/timetable');
const settingsRouter = require('./routes/settings');
const authRouter = require('./routes/auth');
const feeCategoriesRouter = require('./routes/feeCategories');

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

app.use('/students', studentsRouter);
app.use('/staff', staffRouter);
app.use('/fees', feesRouter);
app.use('/expenses', expensesRouter);
app.use('/attendance', attendanceRouter);
app.use('/work-records', workRecordsRouter);
app.use('/report-cards', reportCardsRouter);
app.use('/timetable', timetableRouter);
app.use('/settings', settingsRouter);
app.use('/fee-categories', feeCategoriesRouter);
app.use('/auth', authRouter);

module.exports = app;
