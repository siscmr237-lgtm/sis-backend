-- THE TWO-WAY INBOX: a parent's reply, and what the team says back.
--
-- Purely additive. Three new tables, no existing table touched, no row read or
-- rewritten. WhatsAppMessage stays exactly as it is -- it logs outbound TEMPLATE
-- sends and has no room for a message that arrives with no student, no purpose
-- and no template.
--
-- Worth recording alongside this migration: at the time it was written the
-- Messaging Service had NO inbound webhook configured and the production
-- WhatsApp sender's callback_url was empty, so every reply a parent had ever
-- sent was being discarded by Twilio. These tables are empty on creation and
-- stay empty until the webhook is registered by hand in the Twilio Console.

-- ---------------------------------------------------------------------------
-- 1. Inbound.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "InboundWhatsAppMessage" (
    "id"             SERIAL       NOT NULL,
    "twilioSid"      TEXT         NOT NULL,
    "fromRaw"        TEXT         NOT NULL,
    -- Nullable: normaliseToWhatsApp returns null rather than guessing at a
    -- number it cannot read, and a message that arrived is a fact either way.
    "fromNormalised" TEXT,
    "body"           TEXT         NOT NULL,
    "receivedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Null means unread.
    "readAt"         TIMESTAMP(3),
    CONSTRAINT "InboundWhatsAppMessage_pkey" PRIMARY KEY ("id")
);

-- THE IDEMPOTENCY GUARD, and it has to be an index rather than a check in the
-- route. Twilio retries any webhook that does not answer 200, so the same
-- message arrives more than once as a matter of routine, and two retries in
-- flight together would both pass an application-level "have I seen this?".
CREATE UNIQUE INDEX IF NOT EXISTS "InboundWhatsAppMessage_twilioSid_key"
  ON "InboundWhatsAppMessage" ("twilioSid");

CREATE INDEX IF NOT EXISTS "InboundWhatsAppMessage_fromNormalised_receivedAt_idx"
  ON "InboundWhatsAppMessage" ("fromNormalised", "receivedAt");
CREATE INDEX IF NOT EXISTS "InboundWhatsAppMessage_receivedAt_idx"
  ON "InboundWhatsAppMessage" ("receivedAt");

-- ---------------------------------------------------------------------------
-- 2. Who the number turned out to be. Zero, one, or several rows per message.
-- ---------------------------------------------------------------------------
-- NO FOREIGN KEYS to School, Student or Parent, on purpose. A key to Student
-- would either cascade this record away when a student is deleted or block the
-- deletion, and neither is the right answer for the log of a conversation that
-- really happened. Same reasoning as RetiredReceiptNumber: ids as plain columns
-- for as long as the rows exist, names copied in as text so it still reads when
-- they do not.
CREATE TABLE IF NOT EXISTS "InboundWhatsAppMatch" (
    "id"          SERIAL  NOT NULL,
    "messageId"   INTEGER NOT NULL,
    "schoolId"    INTEGER,
    "schoolName"  TEXT,
    "studentId"   INTEGER,
    "studentName" TEXT,
    "parentId"    INTEGER,
    "parentName"  TEXT,
    CONSTRAINT "InboundWhatsAppMatch_pkey" PRIMARY KEY ("id")
);

-- The one FK, and it is right: a match describes a message and without that
-- message it describes nothing.
DO $$ BEGIN
  ALTER TABLE "InboundWhatsAppMatch"
    ADD CONSTRAINT "InboundWhatsAppMatch_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "InboundWhatsAppMessage"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "InboundWhatsAppMatch_messageId_studentId_key"
  ON "InboundWhatsAppMatch" ("messageId", "studentId");
CREATE INDEX IF NOT EXISTS "InboundWhatsAppMatch_schoolId_idx"
  ON "InboundWhatsAppMatch" ("schoolId");

-- ---------------------------------------------------------------------------
-- 3. Outbound free-form replies.
-- ---------------------------------------------------------------------------
-- A different Twilio call from every other send in this app: plain Body rather
-- than an approved template by ContentSid, permitted only inside the 24-hour
-- window that the customer's last inbound message opens.
CREATE TABLE IF NOT EXISTS "OutboundWhatsAppReply" (
    "id"                   SERIAL       NOT NULL,
    "toRaw"                TEXT         NOT NULL,
    "toNormalised"         TEXT         NOT NULL,
    "body"                 TEXT         NOT NULL,
    -- Written BEFORE the Twilio call, like every other send here, so a failure
    -- is a visible row rather than nothing at all.
    "status"               TEXT         NOT NULL DEFAULT 'queued',
    "twilioSid"            TEXT,
    "errorCode"            TEXT,
    "errorMessage"         TEXT,
    "sentAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- A plain id and a copied name rather than a relation, so what was said to a
    -- parent survives the account that said it being disabled or renamed.
    "sentByPlatformUserId" INTEGER,
    "sentByName"           TEXT,
    CONSTRAINT "OutboundWhatsAppReply_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "OutboundWhatsAppReply_toNormalised_sentAt_idx"
  ON "OutboundWhatsAppReply" ("toNormalised", "sentAt");
CREATE INDEX IF NOT EXISTS "OutboundWhatsAppReply_twilioSid_idx"
  ON "OutboundWhatsAppReply" ("twilioSid");
