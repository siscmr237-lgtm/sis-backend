-- Admin-triggered WhatsApp absence notices.
--
-- Additive throughout, and written with IF NOT EXISTS / DO blocks because dev
-- and production are the SAME database: this file may well be run a second time
-- against objects it already created, and re-running it has to be a no-op rather
-- than an error that aborts the deploy mid-way.
--
-- Nothing here rewrites, backfills or drops an existing row. The only change to
-- an existing table is one new column with a DEFAULT, and the only new table is
-- empty on creation.

-- ---------------------------------------------------------------------------
-- 1. Guardian consent.
-- ---------------------------------------------------------------------------
-- ADD COLUMN ... DEFAULT false NOT NULL. Postgres 11+ stores this default in the
-- catalogue rather than rewriting every row, so it is a metadata-only change and
-- does not lock the table for the length of a table scan.
--
-- The default is FALSE, which means every guardian already on file reads as
-- having given no consent, and the feature reaches nobody until each one is
-- ticked by hand. That is the point. Nobody enrolled before this column existed
-- was ever asked the question, and defaulting to true would have the school
-- assert an agreement that was never given -- to a batch send, to a phone
-- number, about a named child.
ALTER TABLE "Parent" ADD COLUMN IF NOT EXISTS "whatsappConsent" BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- 2. The outbound message log.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "WhatsAppMessage" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "studentId" INTEGER NOT NULL,
    "parentId" INTEGER,
    "templateSid" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "referenceDate" TIMESTAMP(3) NOT NULL,
    "toNumber" TEXT NOT NULL,
    "twilioSid" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppMessage_pkey" PRIMARY KEY ("id")
);

-- THE DUPLICATE GUARD. This is the reason the table exists at all, and it is a
-- database constraint rather than a check in the route because a check in the
-- route cannot survive concurrency: two admins sending the same register, or one
-- admin double-clicking, both read "not sent yet" and both send, and a parent is
-- told twice that their child was absent.
--
-- The route CREATEs this row before calling Twilio and treats a unique violation
-- as "already sent", so the row is claimed first and the loser of the race never
-- reaches the provider.
--
-- `referenceDate` is normalised to midnight UTC in application code (the same
-- startOfDayUTC that AttendanceRecord.date goes through). Without that this
-- index keys on a timestamp and two notices a few milliseconds apart both fit.
--
-- `purpose` is in the key so a future fee reminder for the same student on the
-- same day is a different message, not a blocked duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS "WhatsAppMessage_studentId_purpose_referenceDate_key"
    ON "WhatsAppMessage"("studentId", "purpose", "referenceDate");

-- The screen's own query: every notice this school sent for one register date.
CREATE INDEX IF NOT EXISTS "WhatsAppMessage_schoolId_referenceDate_idx"
    ON "WhatsAppMessage"("schoolId", "referenceDate");

-- The status webhook's query. Twilio hands back only a MessageSid, so this is
-- the only column the callback has to find a row by, and it is looked up once
-- per status transition per message -- several times for every message sent.
CREATE INDEX IF NOT EXISTS "WhatsAppMessage_twilioSid_idx"
    ON "WhatsAppMessage"("twilioSid");

-- Foreign keys, each guarded by name because ADD CONSTRAINT has no IF NOT EXISTS.
--
-- studentId CASCADEs: the log is a record of messages about a child, and a
-- deleted child's messages are not a thing to keep pointing at a row that is
-- gone.
--
-- parentId SET NULLs and is nullable: a guardian can be unlinked or replaced
-- afterwards, and the log of what was sent has to survive that. `toNumber`
-- records the digits actually dialled, so the row still answers the question
-- that matters even once the Parent it names is gone.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WhatsAppMessage_schoolId_fkey') THEN
        ALTER TABLE "WhatsAppMessage" ADD CONSTRAINT "WhatsAppMessage_schoolId_fkey"
            FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WhatsAppMessage_studentId_fkey') THEN
        ALTER TABLE "WhatsAppMessage" ADD CONSTRAINT "WhatsAppMessage_studentId_fkey"
            FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WhatsAppMessage_parentId_fkey') THEN
        ALTER TABLE "WhatsAppMessage" ADD CONSTRAINT "WhatsAppMessage_parentId_fkey"
            FOREIGN KEY ("parentId") REFERENCES "Parent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END
$$;
