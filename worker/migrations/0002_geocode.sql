-- Record WHAT the geocoder matched, not just where it landed.
--
-- A geocoder that cannot find a street will often return the centre of the
-- city instead, with no error. Stored as bare coordinates that is
-- indistinguishable from a correct answer, and the first anyone knows is a
-- driver parked a mile from the child. Keeping the matched label and a
-- confidence lets the family confirm it and an admin audit it later.

ALTER TABLE households ADD COLUMN home_geocode_label TEXT NOT NULL DEFAULT '';
ALTER TABLE households ADD COLUMN home_geocode_confidence TEXT NOT NULL DEFAULT '';
ALTER TABLE households ADD COLUMN alternate_geocode_label TEXT NOT NULL DEFAULT '';
ALTER TABLE households ADD COLUMN alternate_geocode_confidence TEXT NOT NULL DEFAULT '';
