-- Section letters were appended with no separator, producing "Day CareA" and
-- "Pre-NurseryA". Rename them to "Day Care A" / "Pre-Nursery A".
--
-- Class names are stored as plain strings on four other tables and matched by
-- exact text, so every one of them has to be carried along with the rename;
-- missing any would silently detach those rows from their class. Students are
-- updated first, while the old names still exist to join against.

CREATE TEMP TABLE class_renames AS
WITH levels(level) AS (
  VALUES ('Pre-Nursery'), ('Nursery 1'), ('Nursery 2'), ('Day Care'),
         ('Class 1'), ('Class 2'), ('Class 3'), ('Class 4'), ('Class 5'), ('Class 6')
)
SELECT c."schoolId",
       c.name                                   AS old_name,
       l.level || ' ' || right(c.name, 1)       AS new_name
FROM "Class" c
JOIN levels l ON c.name = l.level || right(c.name, 1)
WHERE right(c.name, 1) ~ '^[A-Z]$';

UPDATE "Student" s SET class = r.new_name
FROM class_renames r
WHERE s."schoolId" = r."schoolId" AND s.class = r.old_name;

UPDATE "WorkRecord" w SET class = r.new_name
FROM class_renames r
WHERE w."schoolId" = r."schoolId" AND w.class = r.old_name;

UPDATE "ReportCard" rc SET class = r.new_name
FROM class_renames r
WHERE rc."schoolId" = r."schoolId" AND rc.class = r.old_name;

UPDATE "TimetableEntry" t SET class = r.new_name
FROM class_renames r
WHERE t."schoolId" = r."schoolId" AND t.class = r.old_name;

UPDATE "Class" c SET name = r.new_name
FROM class_renames r
WHERE c."schoolId" = r."schoolId" AND c.name = r.old_name;

DROP TABLE class_renames;

-- One student was saved through the broken Add Student dropdown and holds a
-- bare level name ("Nursery 2") that never existed as a class row, leaving
-- them off every roster. Reassigned to section A by explicit instruction.
UPDATE "Student" SET class = 'Nursery 2 A'
WHERE code = 'STUUHFMC' AND class = 'Nursery 2';
