-- The post-KYC setup wizard's "has this admin been through it?" flag.
--
-- One additive, nullable column. It is a no-op against every existing row:
-- NULL is the correct starting value for a school that has never seen the
-- wizard, which is exactly what every school predating this migration is.
--
-- Deliberately NOT a progress column. It records only that the wizard was left,
-- never which steps were done — those are read live from the tables by the same
-- code the dashboard checklist uses, so a skipped step simply has no data and
-- shows as outstanding on the checklist.

ALTER TABLE "School" ADD COLUMN IF NOT EXISTS "setupWizardCompletedAt" TIMESTAMP(3);
