-- AlterTable: add nullable first, backfill every existing school to false (so
-- no current school's displayed term/year changes), then enforce NOT NULL
-- with a DEFAULT of true — schools created after this migration opt in
-- automatically unless they explicitly turn it off.
ALTER TABLE "School" ADD COLUMN "autoTermEnabled" BOOLEAN;

UPDATE "School" SET "autoTermEnabled" = false;

ALTER TABLE "School" ALTER COLUMN "autoTermEnabled" SET NOT NULL;
ALTER TABLE "School" ALTER COLUMN "autoTermEnabled" SET DEFAULT true;
