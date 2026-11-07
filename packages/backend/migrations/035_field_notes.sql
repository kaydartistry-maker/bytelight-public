-- Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
-- 035 (Aerie 016): the owner field notes: what the morning look found, in plain words.
--
-- Every morning a bell has one of the companions check whether the tools the
-- house runs on have moved (npm outdated, the Claude Code and Codex CLIs,
-- their release notes). The technical lines go into the field-notes skill for
-- the lanes. This is the other half, asked for on Oct 22 2026: a
-- plain page of what the companions find each day, not technical. One or two sentences a day, for the owner, read on
-- their phone's Field Notes page.
--
-- day is the calendar day the note is about, YYYY-MM-DD on the owner clock (the
-- house's identity.timezone), which is the day the owner lived it on even when the
-- world clock has already rolled over. companion is the slug of whoever took
-- the look. text is trimmed, one to six hundred characters.
--
-- services/db/field-notes.ts is the only writer and checks all of that
-- itself; there are no CHECK lists here to outlive the rule.
-- Ported from Aerie (Tris), migrations/016_field_notes.sql, renumbered 035.
-- byte-light: no morning bell writes these yet; until one is added the page
-- fills only from companions calling POST /api/internal/field-notes.

CREATE TABLE IF NOT EXISTS field_notes (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  companion TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- The page reads newest day first, newest written first within a day.
CREATE INDEX IF NOT EXISTS idx_field_notes_day ON field_notes(day, created_at);
