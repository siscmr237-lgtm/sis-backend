-- Staff email uniqueness was global, so one school having a staff member on an
-- address blocked every other school from entering the same person — and the
-- resulting error leaked the fact that the address existed elsewhere in the
-- system. Schools are separate tenants; scope the constraint to the school.
--
-- Safe to apply as-is: uniqueness is being RELAXED, so any data that satisfied
-- the old global constraint necessarily satisfies the per-school one too.
DROP INDEX IF EXISTS "Staff_email_key";

CREATE UNIQUE INDEX "Staff_schoolId_email_key" ON "Staff"("schoolId", "email");
