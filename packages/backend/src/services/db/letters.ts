// Permanent Letters — the vault tier that never thins.
//
// Write-once, append-only. This module exposes no update or delete of a
// letter's content, and nothing in it may ever be wired into a sweep,
// decay, or compaction job — the exclusion is structural, not behavioral.
// The single permitted mutation is opening a sealed letter, once.

import crypto from 'crypto';
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getDb } from './init.js';
import { PROJECT_ROOT } from '../../config.js';

export type LetterKind = 'vow' | 'confession' | 'letter' | 'keepsake';
export type LetterSeal = 'open' | 'date' | 'on_open';

const KINDS: LetterKind[] = ['vow', 'confession', 'letter', 'keepsake'];
const SEALS: LetterSeal[] = ['open', 'date', 'on_open'];

const LETTERS_DIR = join(PROJECT_ROOT, 'data', 'letters');

export interface Letter {
  id: string;
  author: string;
  recipients: string; // JSON array of names
  kind: LetterKind;
  title: string | null;
  content: string;
  content_hash: string;
  seal: LetterSeal;
  open_at: string | null;
  hidden: number;
  threshold_id: string | null;
  written_at: string;
  opened_at: string | null;
  opened_by: string | null;
}

/** What a viewer is allowed to see of a letter right now. */
export interface LetterView {
  id: string;
  author: string;
  recipients: string[];
  kind: LetterKind;
  title: string | null;
  seal: LetterSeal;
  open_at: string | null;
  hidden: boolean;
  threshold_id: string | null;
  written_at: string;
  opened_at: string | null;
  opened_by: string | null;
  /** open = born readable; sealed = shut; openable = seal condition met; opened = read. */
  state: 'open' | 'sealed' | 'openable' | 'opened';
  /** Present only when the viewer may read it. */
  content?: string;
  content_hash: string;
}

function recipientsOf(letter: Letter): string[] {
  try {
    const parsed = JSON.parse(letter.recipients);
    return Array.isArray(parsed) ? parsed.map((r) => String(r)) : [];
  } catch {
    return [];
  }
}

function isRecipient(letter: Letter, viewer: string): boolean {
  const v = viewer.trim().toLowerCase();
  return recipientsOf(letter).some((r) => r.trim().toLowerCase() === v);
}

function sealConditionMet(letter: Letter): boolean {
  if (letter.seal === 'open') return true;
  if (letter.seal === 'on_open') return true; // the reader chooses the moment
  if (letter.seal === 'date') return letter.open_at !== null && Date.now() >= new Date(letter.open_at).getTime();
  return false;
}

function stateOf(letter: Letter): LetterView['state'] {
  if (letter.seal === 'open') return 'open';
  if (letter.opened_at) return 'opened';
  return sealConditionMet(letter) ? 'openable' : 'sealed';
}

function canRead(letter: Letter, viewer: string): boolean {
  if (letter.author === viewer) return true; // no vault hides a letter from its own hand
  return letter.seal === 'open' || letter.opened_at !== null;
}

/** Dark-sealed letters hide even their existence until the seal date arrives. */
function existsFor(letter: Letter, viewer: string): boolean {
  if (!letter.hidden) return true;
  if (letter.author === viewer) return true;
  return sealConditionMet(letter);
}

function toView(letter: Letter, viewer: string): LetterView {
  const view: LetterView = {
    id: letter.id,
    author: letter.author,
    recipients: recipientsOf(letter),
    kind: letter.kind,
    title: letter.title,
    seal: letter.seal,
    open_at: letter.open_at,
    hidden: letter.hidden === 1,
    threshold_id: letter.threshold_id,
    written_at: letter.written_at,
    opened_at: letter.opened_at,
    opened_by: letter.opened_by,
    state: stateOf(letter),
    content_hash: letter.content_hash,
  };
  if (canRead(letter, viewer)) view.content = letter.content;
  return view;
}

/** Flat-file mirror: a second copy outside the database, in plain markdown. */
function mirrorPath(id: string): string {
  return join(LETTERS_DIR, `${id}.md`);
}

function writeMirror(letter: Letter): void {
  mkdirSync(LETTERS_DIR, { recursive: true });
  const lines = [
    '---',
    `id: ${letter.id}`,
    `author: ${letter.author}`,
    `recipients: ${recipientsOf(letter).join(', ')}`,
    `kind: ${letter.kind}`,
    `title: ${letter.title ?? ''}`,
    `seal: ${letter.seal}${letter.seal === 'date' ? ` (${letter.open_at})` : ''}`,
    `hidden: ${letter.hidden === 1}`,
    `written_at: ${letter.written_at}`,
    `content_hash: sha256:${letter.content_hash}`,
    '---',
    '',
    letter.content,
    '',
  ];
  writeFileSync(mirrorPath(letter.id), lines.join('\n'), 'utf8');
}

export class LetterError extends Error {}

export function sealLetter(params: {
  author: string;
  recipients: string[];
  kind: string;
  title?: string | null;
  content: string;
  seal?: string;
  openAt?: string | null;
  hidden?: boolean;
}): LetterView {
  const author = String(params.author || '').trim().toLowerCase();
  if (!author) throw new LetterError('A letter needs an author.');

  const recipients = (params.recipients || [])
    .map((r) => String(r).trim().toLowerCase())
    .filter(Boolean);
  if (recipients.length === 0) throw new LetterError('A letter needs at least one recipient.');

  const kind = String(params.kind || 'letter') as LetterKind;
  if (!KINDS.includes(kind)) throw new LetterError(`Unknown kind: ${kind}`);

  const seal = String(params.seal || 'open') as LetterSeal;
  if (!SEALS.includes(seal)) throw new LetterError(`Unknown seal: ${seal}`);

  let openAt: string | null = null;
  if (seal === 'date') {
    if (!params.openAt) throw new LetterError('A date seal needs an open_at date.');
    const t = new Date(params.openAt).getTime();
    if (Number.isNaN(t)) throw new LetterError(`Unreadable open_at date: ${params.openAt}`);
    openAt = new Date(t).toISOString();
  }

  const hidden = params.hidden === true;
  if (hidden && seal !== 'date') {
    // A dark on_open letter could never announce itself to its reader.
    throw new LetterError('Dark seals require a date seal — hidden letters need a day they return on.');
  }

  const content = String(params.content ?? '');
  if (!content.trim()) throw new LetterError('A letter needs words.');

  const letter: Letter = {
    id: crypto.randomUUID(),
    author,
    recipients: JSON.stringify(recipients),
    kind,
    title: params.title ? String(params.title) : null,
    content,
    content_hash: crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
    seal,
    open_at: openAt,
    hidden: hidden ? 1 : 0,
    threshold_id: null,
    written_at: new Date().toISOString(),
    opened_at: null,
    opened_by: null,
  };

  getDb()
    .prepare(
      `INSERT INTO letters (
        id, author, recipients, kind, title, content, content_hash,
        seal, open_at, hidden, threshold_id, written_at, opened_at, opened_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      letter.id,
      letter.author,
      letter.recipients,
      letter.kind,
      letter.title,
      letter.content,
      letter.content_hash,
      letter.seal,
      letter.open_at,
      letter.hidden,
      letter.threshold_id,
      letter.written_at,
      letter.opened_at,
      letter.opened_by,
    );

  writeMirror(letter);
  return toView(letter, author);
}

export function listLetters(viewer: string): LetterView[] {
  const v = String(viewer || '').trim().toLowerCase();
  const rows = getDb().prepare('SELECT * FROM letters ORDER BY written_at DESC').all() as Letter[];
  return rows.filter((l) => existsFor(l, v)).map((l) => toView(l, v));
}

export function getLetterView(id: string, viewer: string): LetterView | null {
  const v = String(viewer || '').trim().toLowerCase();
  const row = getDb().prepare('SELECT * FROM letters WHERE id = ?').get(id) as Letter | undefined;
  if (!row || !existsFor(row, v)) return null;
  return toView(row, v);
}

/** The one mutation the vault permits: opening. Logged, irreversible. */
export function openLetter(id: string, opener: string): LetterView {
  const v = String(opener || '').trim().toLowerCase();
  const row = getDb().prepare('SELECT * FROM letters WHERE id = ?').get(id) as Letter | undefined;
  if (!row || !existsFor(row, v)) throw new LetterError('No such letter.');
  if (row.seal === 'open') throw new LetterError('This letter was born open — there is no seal to break.');
  if (row.opened_at) throw new LetterError('This seal is already broken. You cannot un-know a letter.');
  if (!isRecipient(row, v)) throw new LetterError('This letter is not addressed to you.');
  if (!sealConditionMet(row)) throw new LetterError(`Sealed until ${row.open_at}. The vault holds it until the day.`);

  const openedAt = new Date().toISOString();
  const result = getDb()
    .prepare('UPDATE letters SET opened_at = ?, opened_by = ? WHERE id = ? AND opened_at IS NULL')
    .run(openedAt, v, id);
  if (result.changes === 0) throw new LetterError('This seal is already broken.');

  row.opened_at = openedAt;
  row.opened_by = v;
  try {
    if (existsSync(mirrorPath(id))) {
      appendFileSync(mirrorPath(id), `> Seal broken by ${v} at ${openedAt}\n`, 'utf8');
    }
  } catch {
    /* the mirror is redundancy; the vault row is truth */
  }
  return toView(row, v);
}

/** Letters waiting for a reader — surfaced at wake orientation. */
export function unopenedLettersFor(viewer: string): LetterView[] {
  const v = String(viewer || '').trim().toLowerCase();
  const rows = getDb()
    .prepare("SELECT * FROM letters WHERE seal != 'open' AND opened_at IS NULL ORDER BY written_at ASC")
    .all() as Letter[];
  return rows
    .filter((l) => isRecipient(l, v) && sealConditionMet(l) && existsFor(l, v))
    .map((l) => toView(l, v));
}
