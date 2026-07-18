-- Student
CREATE INDEX "Student_schoolId_idx" ON "Student"("schoolId");
CREATE INDEX "Student_schoolId_class_idx" ON "Student"("schoolId", "class");

-- Staff
CREATE INDEX "Staff_schoolId_idx" ON "Staff"("schoolId");

-- Expense
CREATE INDEX "Expense_schoolId_date_idx" ON "Expense"("schoolId", "date");

-- AttendanceRecord
CREATE INDEX "AttendanceRecord_schoolId_date_idx" ON "AttendanceRecord"("schoolId", "date");
CREATE INDEX "AttendanceRecord_schoolId_personId_idx" ON "AttendanceRecord"("schoolId", "personId");

-- WorkRecord
CREATE INDEX "WorkRecord_schoolId_idx" ON "WorkRecord"("schoolId");
CREATE INDEX "WorkRecord_staffId_schoolId_idx" ON "WorkRecord"("staffId", "schoolId");

-- ReportCard
CREATE INDEX "ReportCard_schoolId_idx" ON "ReportCard"("schoolId");
CREATE INDEX "ReportCard_schoolId_studentId_idx" ON "ReportCard"("schoolId", "studentId");
CREATE INDEX "ReportCard_schoolId_term_academicYear_idx" ON "ReportCard"("schoolId", "term", "academicYear");

-- TimetableEntry
CREATE INDEX "TimetableEntry_schoolId_idx" ON "TimetableEntry"("schoolId");
CREATE INDEX "TimetableEntry_schoolId_class_idx" ON "TimetableEntry"("schoolId", "class");
