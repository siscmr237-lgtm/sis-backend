-- Date of birth and the parent/guardian link become OPTIONAL on a student.
--
-- A school enrolling a child rarely has everything to hand on the day — the
-- birth certificate is at home, the guardian's number belongs to someone who
-- is not in the room — and requiring both meant the child could not be put on
-- the roster at all until they turned up.
--
-- dateOfBirth: NULL rather than a stand-in date. The create route already
-- accepted a missing one and quietly stored today's date instead, so the
-- profile then displayed a birthday that was simply false. NULL says "not
-- recorded", which is what is actually known.
--
-- parentId: NULL rather than a link to a blank Parent row. Parent is deduped by
-- @@unique([schoolId, name, phone]), so an empty name/phone pair would be a
-- single shared "nobody" record that every contactless student pointed at, and
-- correcting one child's guardian would silently rewrite it for all of them.
--
-- Nothing is lost and nothing is rewritten: every existing row has a value and
-- keeps it. Dropping NOT NULL cannot fail on existing data, so this needs no
-- backfill and is safe to run against a populated table.
--
-- Reversing it means re-adding NOT NULL, which would first require inventing a
-- birth date and a guardian for any student saved without one in the meantime.
-- There is no automatic way back.
ALTER TABLE "Student" ALTER COLUMN "dateOfBirth" DROP NOT NULL,
ALTER COLUMN "parentId" DROP NOT NULL;

-- The foreign key is rebuilt only to change its delete action. A REQUIRED
-- relation is RESTRICT ("you may not delete a parent who has children"); an
-- optional one is SET NULL ("the children stay, with no guardian on file"),
-- which is now a state a student is allowed to be in. Nothing in the app
-- deletes a Parent today, so this changes no current behaviour — it is here so
-- the database matches what the Prisma schema now describes, rather than
-- leaving a permanent difference for the next migration to trip over.
ALTER TABLE "Student" DROP CONSTRAINT "Student_parentId_fkey";
ALTER TABLE "Student" ADD CONSTRAINT "Student_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Parent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
