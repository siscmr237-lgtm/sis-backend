-- Aligns the live PickupContact table with schema.prisma.
--
-- PickupContact was created by a hand-written script rather than by Prisma, so
-- the live table diverges from the model in exactly three ways:
--   * "createdAt" and "updatedAt" are timestamptz, where Prisma's DateTime maps
--     to timestamp(3);
--   * "updatedAt" carries a DEFAULT now(), which Prisma's @updatedAt does not
--     generate (the client writes the value);
--   * the studentId foreign key lacks ON UPDATE CASCADE.
--
-- This is the ONLY migration in this repair that changes anything on the live
-- database. It is safe to do so here: PickupContact holds zero rows, so the type
-- change rewrites nothing and cannot lose data. Without it, `prisma migrate dev`
-- would stop failing with P3006 only to start reporting schema DRIFT on these
-- three items — and offer to reset the database, which is precisely the outcome
-- this whole exercise exists to prevent.
--
-- On a FRESH database every statement below is a no-op:
-- 20260703013000_repair_untracked_schema already created the table with these
-- exact definitions, so the types already match, there is no default to drop,
-- and the constraint is dropped and recreated identically.

-- timestamptz -> timestamp(3) discards the zone offset by converting to the
-- session time zone. Pinned to UTC so the result does not depend on whoever runs
-- this or on a server default changing later. SET LOCAL is scoped to the
-- migration's transaction and reverts automatically.
SET LOCAL TimeZone = 'UTC';

ALTER TABLE "PickupContact"
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3),
  ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMP(3),
  ALTER COLUMN "updatedAt" DROP DEFAULT;

-- Recreated rather than altered: PostgreSQL cannot change a foreign key's
-- referential actions in place. IF EXISTS keeps the drop valid on a fresh
-- database, where the constraint was created moments earlier by the repair
-- migration and is simply replaced with an identical definition.
ALTER TABLE "PickupContact" DROP CONSTRAINT IF EXISTS "PickupContact_studentId_fkey";

ALTER TABLE "PickupContact" ADD CONSTRAINT "PickupContact_studentId_fkey"
  FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;
