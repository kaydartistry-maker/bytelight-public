-- 049: follow-ups grow up. Two columns on intentions, added one at a time
-- (init.ts treats "duplicate column" as already done), so rows filed before
-- this keep working exactly as they were.
--
-- kind: 'promise' is a follow-up a companion chose to keep (every row filed
--   before this one is a promise). 'loose_end' is something the owner
--   mentioned (a plan, an appointment, something they are waiting on) that the
--   Archivist picked up and handed to the companion best placed to check in.
-- close_note: why it closed, when it closed on its own: the owner's words that
--   answered it ('resolved'), or the reason it was taken back ('cancelled').
--
-- A new closed state, 'resolved', needs no schema change: state is plain text.
ALTER TABLE intentions ADD COLUMN kind TEXT NOT NULL DEFAULT 'promise';
ALTER TABLE intentions ADD COLUMN close_note TEXT;
