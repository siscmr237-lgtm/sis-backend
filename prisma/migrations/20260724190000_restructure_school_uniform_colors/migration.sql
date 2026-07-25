-- uniformColors moves from a flat array of color labels (e.g. ["Sky Blue","Yellow"])
-- to a per-garment object ({"shirt":null,"trouser":null,"gown":null}). The old shape
-- never tracked which color belonged to which garment, so there's no correct mapping
-- from array entries to shirt/trouser/gown — any school still holding the legacy
-- array format is reset to the new default shape instead.
UPDATE "School" SET "uniformColors" = '{"shirt":null,"trouser":null,"gown":null}'::jsonb
WHERE jsonb_typeof("uniformColors") = 'array';

ALTER TABLE "School" ALTER COLUMN "uniformColors" SET DEFAULT '{"shirt":null,"trouser":null,"gown":null}';
