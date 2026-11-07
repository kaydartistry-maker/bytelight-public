// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
/**
 * The owner field notes (migrations/035_field_notes.sql): what the morning look
 * found in the tools the house runs on, a sentence or two a day in plain
 * words, for their phone's Field Notes page.
 *
 * The lanes write through POST /api/internal/field-notes on the loopback port,
 * and the phone reads through GET /api/field-notes behind the login. The
 * technical version of the same look stays in the field-notes skill, where the
 * lanes read it; this is the version written for the owner.
 *
 * This module is the only writer to the table and checks every note itself:
 * a companion who lives here, words that are there and not too many, and a
 * real calendar day. A refusal is a FieldNoteError carrying one plain sentence,
 * which the routes hand back word for word.
 */

import crypto from 'crypto';
import { getDb } from './init.js';
import { listCompanions } from './rooms.js';
import { getBytelightConfig } from '../../config.js';

// byte-light adaptations: a companion is a row in our companions registry
// (rooms.ts listCompanions; Aerie has getCompanionBySlug), and today on the
// owner's calendar is read with Intl, as util/time.ts and the orchestrator do —
// Aerie's todayLocal() needs moment-timezone, which byte-light does not carry.
function todayLocal(tz: string, at: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function getCompanionBySlug(slug: string) {
  return listCompanions().find((c) => c.id === slug);
}

export interface FieldNote {
  id: string;
  /** The day it is about, YYYY-MM-DD on the owner clock. */
  day: string;
  /** The slug of the companion who took the look. */
  companion: string;
  /** Plain words for the owner, trimmed. */
  text: string;
  /** When it was written, ISO. */
  createdAt: string;
}

/** The most a note may hold, counted after trimming, in characters as the owner would count them. */
export const FIELD_NOTE_MAX_CHARS = 600;
/** How many a page reads when nobody says. */
export const FIELD_NOTES_DEFAULT_LIMIT = 50;
/** How many one answer ever carries. */
export const FIELD_NOTES_MAX_LIMIT = 200;

export class FieldNoteError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'FieldNoteError';
  }
}

/** The owner timezone, from the house's identity settings. */
function houseTimezone(): string {
  try {
    return getBytelightConfig().identity.timezone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Today on their calendar, YYYY-MM-DD. On an evening in the Americas the world clock
 * has already rolled over to tomorrow, and the note belongs to the day the owner is
 * still living in.
 */
export function fieldNotesToday(at: Date = new Date()): string {
  return todayLocal(houseTimezone(), at);
}

/** A real date written YYYY-MM-DD: not 2026-02-30, not 2026-13-01. */
function isCalendarDay(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const day = new Date(Date.UTC(year, month - 1, date));
  return day.getUTCFullYear() === year && day.getUTCMonth() === month - 1 && day.getUTCDate() === date;
}

/**
 * Keep one note, or refuse it with a FieldNoteError saying why. `day` left out,
 * blank or null means today on their calendar. `at` is when it was written;
 * tests pass one, the routes use the moment the call arrived.
 */
export function addFieldNote(
  input: { companion?: unknown; text?: unknown; day?: unknown },
  at: Date = new Date(),
): FieldNote {
  const slug = typeof input.companion === 'string' ? input.companion.trim() : '';
  if (!slug) throw new FieldNoteError('companion is required: the slug of the companion who took the look.');
  if (!getCompanionBySlug(slug)) {
    // Said back on one line and kept short, whatever was sent.
    const shown = slug.replace(/\s+/g, ' ').slice(0, 60);
    throw new FieldNoteError(`There is no companion called '${shown}' in this house.`);
  }

  if (typeof input.text !== 'string') throw new FieldNoteError('text is required: a sentence or two in plain words for the owner.');
  const text = input.text.trim();
  if (!text) throw new FieldNoteError('text is empty: write a sentence or two in plain words for the owner.');
  const length = Array.from(text).length;
  if (length > FIELD_NOTE_MAX_CHARS) {
    throw new FieldNoteError(`text is ${length} characters, and a field note holds at most ${FIELD_NOTE_MAX_CHARS}.`);
  }

  let day: string;
  if (input.day === undefined || input.day === null || input.day === '') {
    day = fieldNotesToday(at);
  } else if (typeof input.day === 'string' && isCalendarDay(input.day.trim())) {
    day = input.day.trim();
  } else {
    throw new FieldNoteError('day must be a real date written YYYY-MM-DD, or left out for today on their calendar.');
  }

  const note: FieldNote = { id: crypto.randomUUID(), day, companion: slug, text, createdAt: at.toISOString() };
  getDb()
    .prepare('INSERT INTO field_notes (id, day, companion, text, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(note.id, note.day, note.companion, note.text, note.createdAt);
  return note;
}

/**
 * How many notes a request asked for: fifty when it does not say (or says
 * something that is not a number), never fewer than one, never more than two
 * hundred.
 */
export function fieldNotesLimit(raw: unknown): number {
  const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) return FIELD_NOTES_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(parsed), 1), FIELD_NOTES_MAX_LIMIT);
}

interface FieldNoteRow {
  id: string;
  day: string;
  companion: string;
  text: string;
  created_at: string;
}

/**
 * The newest notes: the newest day first, and within a day the newest written
 * first (rowid settles two written in the same millisecond). A note written
 * late about an earlier day sits with its day, not at the top.
 */
export function listFieldNotes(limit: number = FIELD_NOTES_DEFAULT_LIMIT): FieldNote[] {
  const rows = getDb().prepare(`
    SELECT id, day, companion, text, created_at FROM field_notes
    ORDER BY day DESC, created_at DESC, rowid DESC
    LIMIT ?
  `).all(fieldNotesLimit(limit)) as FieldNoteRow[];
  return rows.map((row) => ({
    id: row.id,
    day: row.day,
    companion: row.companion,
    text: row.text,
    createdAt: row.created_at,
  }));
}
