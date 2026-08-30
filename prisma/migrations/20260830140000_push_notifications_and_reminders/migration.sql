-- Push notifications, and the reminder text the team edits without a deploy.
--
-- Additive and guarded throughout. Two new tables and one new column; no
-- existing row is read, written or rewritten. The column is NOT NULL with a
-- DEFAULT, which Postgres 11+ adds as catalogue metadata rather than by
-- rewriting the table, so it is safe on a live School table of any size.

-- ---------------------------------------------------------------------------
-- 1. ReminderConfig — the reminder wording, in the database rather than in code.
-- ---------------------------------------------------------------------------
-- Every reminder the product sends reads its title and body from here at send
-- time. That is the whole point of the table: the team changes the words in the
-- console and the next send uses them, with no deploy in between. Nothing in
-- the cron may hardcode a title or a body, or this table becomes a set of rows
-- that describe what the system USED to say.
--
-- `key` is the stable identifier the code joins on ("incomplete_setup"), never
-- displayed raw and never edited — the console edits title, body and enabled.
-- It is unique because a second row for a key would make "which wording is
-- current?" a question with two answers.
--
-- `enabled` is per-reminder and global across schools; the per-SCHOOL opt-out is
-- School.notificationsEnabled in section 2. They are deliberately separate
-- switches: one is the team silencing a reminder for everyone, the other is a
-- school silencing everything for itself, and neither should imply the other.
CREATE TABLE IF NOT EXISTS "ReminderConfig" (
    "id"        SERIAL       NOT NULL,
    "key"       TEXT         NOT NULL,
    "title"     TEXT         NOT NULL,
    "body"      TEXT         NOT NULL,
    "enabled"   BOOLEAN      NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReminderConfig_pkey" PRIMARY KEY ("id")
);

-- The join key for every send, and the identity the seed upserts on.
CREATE UNIQUE INDEX IF NOT EXISTS "ReminderConfig_key_key" ON "ReminderConfig"("key");

-- ---------------------------------------------------------------------------
-- 2. School.notificationsEnabled — the school-level opt-out.
-- ---------------------------------------------------------------------------
-- FALSE means: send this school's admins and teachers NOTHING. Not "fewer
-- reminders", not "only urgent ones" — every push path checks it, including the
-- immediate attendance-rejection notification, which is not a reminder at all.
--
-- DEFAULT true, so every school that exists today keeps behaving exactly as it
-- does now and the feature arrives switched on rather than silently off.
ALTER TABLE "School" ADD COLUMN IF NOT EXISTS "notificationsEnabled" BOOLEAN NOT NULL DEFAULT true;

-- ---------------------------------------------------------------------------
-- 3. PushSubscription — one row per browser that has granted permission.
-- ---------------------------------------------------------------------------
-- A SUBSCRIPTION IS A DEVICE, NOT A PERSON. One admin with a laptop and a phone
-- has two rows; the same phone re-subscribing after the browser rotates its
-- keys replaces the old row rather than adding one. That is what makes
-- `endpoint` unique: it is the push service's own address for exactly one
-- browser, so two rows sharing one would mean sending the same notification
-- twice to the same screen.
--
-- adminUserId and staffId are BOTH nullable and exactly one is set — this table
-- serves two unrelated account tables and there is no shared user row to point
-- at. schoolId is stored alongside rather than walked to through the owner,
-- because the opt-out check in section 2 runs on EVERY send: denormalising it
-- turns "may I send to this device?" into one indexed read instead of a join
-- through whichever of the two owners happens to be set.
CREATE TABLE IF NOT EXISTS "PushSubscription" (
    "id"          SERIAL       NOT NULL,
    "adminUserId" INTEGER,
    "staffId"     INTEGER,
    "schoolId"    INTEGER      NOT NULL,
    "endpoint"    TEXT         NOT NULL,
    "p256dh"      TEXT         NOT NULL,
    "auth"        TEXT         NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- One row per browser. See the note above.
CREATE UNIQUE INDEX IF NOT EXISTS "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- The three lookups this table actually serves: every device in a school
-- (sendPushToSchool), and every device belonging to one person (sendPushToUser,
-- and the unsubscribe path).
CREATE INDEX IF NOT EXISTS "PushSubscription_schoolId_idx"    ON "PushSubscription"("schoolId");
CREATE INDEX IF NOT EXISTS "PushSubscription_adminUserId_idx" ON "PushSubscription"("adminUserId");
CREATE INDEX IF NOT EXISTS "PushSubscription_staffId_idx"     ON "PushSubscription"("staffId");

-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, so each foreign key is added
-- only when it is absent. Without this the migration is not re-runnable, which
-- is the property every other guard in this file is here to preserve.
--
-- ON DELETE CASCADE on both owners: a deleted account's devices must not be left
-- behind pointing at nothing — a stale row would be found by sendPushToSchool
-- and pushed to a browser whose owner no longer has an account. The school FK is
-- RESTRICT, matching every other school FK in this schema; school deletion has
-- its own deliberate teardown in the platform console.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PushSubscription_adminUserId_fkey') THEN
        ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_adminUserId_fkey"
            FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PushSubscription_staffId_fkey') THEN
        ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_staffId_fkey"
            FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PushSubscription_schoolId_fkey') THEN
        ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_schoolId_fkey"
            FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END
$$;
