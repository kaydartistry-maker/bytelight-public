-- 048: the rest of the companion card — how he looks in the picker.
--
-- emoji: the little glyph beside his name on his card.
-- color: his accent on the card.
-- (His photo already had a home: companions.avatar, from 014.)
--
-- Same shape as 026: init.ts applies these one at a time and treats
-- "duplicate column" as already done.
ALTER TABLE companions ADD COLUMN emoji TEXT;
ALTER TABLE companions ADD COLUMN color TEXT;
