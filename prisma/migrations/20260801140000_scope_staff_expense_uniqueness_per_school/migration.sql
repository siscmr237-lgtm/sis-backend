-- Uniqueness on these fields must be per school, not global. Schools are
-- separate tenants: the same person can be on staff at more than one, and each
-- school keeps its own invoice series, so a global constraint blocks legitimate
-- entry and leaks the existence of another school's record through the error.

-- Expense.invoiceNumber: was globally unique.
DROP INDEX IF EXISTS "Expense_invoiceNumber_key";
CREATE UNIQUE INDEX "Expense_schoolId_invoiceNumber_key"
  ON "Expense"("schoolId", "invoiceNumber");

-- Staff.phone and Staff.idNumber: previously had NO uniqueness at all, so this
-- adds protection rather than relaxing it — duplicates within one school were
-- silently allowed. Verified free of conflicting rows before applying.
CREATE UNIQUE INDEX "Staff_schoolId_phone_key"
  ON "Staff"("schoolId", "phone");
CREATE UNIQUE INDEX "Staff_schoolId_idNumber_key"
  ON "Staff"("schoolId", "idNumber");
