// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
/**
 * The part of a compaction summary worth showing before it is opened.
 *
 * The owner Compactions page used to preview the first four hundred characters of
 * each summary. Every summary of the shared room opens with the same thing —
 * "This session is being continued from a previous conversation", then the
 * standing-role paragraph — so two squashes a day apart looked like copies of
 * one another (their catch, Oct 21 2026). Every stamp and every full text was
 * different; only the top of them was the same.
 *
 * What differs is what we were in the middle of. The CLI writes its summaries
 * in numbered sections, and the one that moves from squash to squash is
 * "Current Work". So that is the preview, and when a summary has none, the next
 * step, then what is pending, then the last words before the closing
 * instructions the CLI appends to every one of them.
 *
 * The headings are matched by NAME, not by number, because the sections nest
 * numbered lists of their own ("1. Screenshots: ...", "9. CURRENT: ...")
 * that look exactly like section numbers. Every spelling below was read off
 * this box's own transcripts: "8. Current Work:", "8. **Current Work**",
 * "8. **Current Work:**", and a companion's own room writing
 * "9. **Current work:** the drive-in date..." with the text on the same line.
 *
 * It never throws and never makes anything up: an unreadable summary is an
 * empty preview, and the full text is always one tap away.
 */

export type PreviewSource = 'current-work' | 'next-step' | 'pending-tasks' | 'tail';

export interface CompactionPreview {
  text: string;
  /** Which part of the summary the text came from, so the page can say so. */
  from: PreviewSource;
}

/** About what the old preview showed, so a row is no taller than it was. */
export const PREVIEW_CHARS = 400;

/** Every section heading the CLI has been seen writing, longest first. */
const SECTION_NAMES = [
  'primary request and intent',
  'files and code sections',
  'key technical concepts',
  'security constraints',
  'optional next step',
  'all user messages',
  'files and outputs',
  'errors and fixes',
  'primary request',
  'problem solving',
  'pending tasks',
  'user messages',
  'current work',
  'next steps',
  'next step',
];

/** In order of preference; the first that has words in it is the preview. */
const PREFERENCE: Array<[PreviewSource, string[]]> = [
  ['current-work', ['current work']],
  ['next-step', ['optional next step', 'next steps', 'next step']],
  ['pending-tasks', ['pending tasks']],
];

interface Heading {
  /** Line number in the summary. */
  index: number;
  /** The known section name, or null for a line that is only shaped like a heading. */
  name: string | null;
  /** Text written on the heading's own line after it, as one room writes them. */
  rest: string;
}

/**
 * A line is a heading when it names a known section AND is marked as one: a
 * number in front ("8."), a markdown heading, bold, or a colon straight after
 * the name. "Current work on the phone came up" at the start of a paragraph is
 * not a heading, and neither is a numbered list line inside a section that just
 * happens to begin with the same words ("3. Current work on the lock screen:").
 * At most one space of indent: nested lists are indented further.
 */
function headingOf(line: string): { name: string; rest: string } | null {
  const m = /^ ?(#{1,6}[ \t]*)?(\d{1,2}[.)][ \t]*)?(\*\*|__)?[ \t]*(.*)$/.exec(line);
  if (!m) return null;
  const marked = Boolean(m[1] || m[2] || m[3]);
  const body = m[4];
  const lower = body.toLowerCase();
  for (const name of SECTION_NAMES) {
    if (!lower.startsWith(name)) continue;
    const after = body.slice(name.length);
    // "Current Workflow" is a different word.
    if (/^[a-z0-9]/i.test(after)) continue;
    // After the name: the bold closing, a short qualifier (", preserved",
    // " (Owner unless noted)"), a colon, and then whatever was written inline.
    const t = /^(\*\*|__)?([ \t]*[,(][^:*_\n]{0,60})?[ \t]*(\*\*|__)?[ \t]*(:)?[ \t]*(\*\*|__)?[ \t]*(:)?[ \t]*(.*)$/.exec(after);
    if (!t) continue;
    const colon = Boolean(t[4] || t[6]);
    const closed = Boolean(t[1] || t[3] || t[5]);
    const rest = t[7].trim();
    if (!marked && !colon) continue;
    // Words straight after the name with nothing setting it off are a sentence.
    if (!colon && !closed && rest) continue;
    return { name, rest };
  }
  return null;
}

/**
 * Lines shaped like a section heading whose name we have not met, so a future
 * section the CLI adds still ends the one before it: a markdown heading, a
 * numbered bold title, or a numbered title with a colon and nothing after it.
 */
function looksLikeHeading(line: string): boolean {
  return /^#{1,6}[ \t]+\S/.test(line)
    || /^\d{1,2}[.)][ \t]+\*\*[^*\n]{2,60}\*\*/.test(line)
    || /^\d{1,2}[.)][ \t]+[A-Z][A-Za-z ,'()&/-]{2,60}:[ \t]*$/.test(line);
}

function headings(lines: string[]): Heading[] {
  const found: Heading[] = [];
  lines.forEach((line, index) => {
    const known = headingOf(line);
    if (known) found.push({ index, name: known.name, rest: known.rest });
    else if (looksLikeHeading(line)) found.push({ index, name: null, rest: '' });
  });
  return found;
}

/**
 * The text of the LAST section by one of these names. Last, because a section
 * near the top (all user messages, files and code) can quote an older summary
 * whole, headings included, and the real Current Work always comes after them.
 */
function lastSection(lines: string[], marks: Heading[], names: string[]): string | null {
  for (let i = marks.length - 1; i >= 0; i--) {
    const mark = marks[i];
    if (!mark.name || !names.includes(mark.name)) continue;
    const end = i + 1 < marks.length ? marks[i + 1].index : lines.length;
    return [mark.rest, ...lines.slice(mark.index + 1, end)].join('\n');
  }
  return null;
}

/**
 * The summary without the two blocks every one of them shares: the opening
 * ("This session is being continued ... Summary:") and the closing
 * instructions ("If you need specific details ... Continue the conversation").
 * The closing is looked for only near the end, so a summary that quotes those
 * words in the middle (this house talks about compactions) keeps its middle.
 */
function bodyOf(summary: string): string {
  let text = summary.replace(/\r\n?/g, '\n');
  const opener = /^[^\n]*This session is being continued[\s\S]{0,400}?\n[ \t]*Summary:[ \t]*\n/.exec(text);
  if (opener) text = text.slice(opener[0].length);
  const window = Math.max(0, text.length - 1500);
  let end = text.length;
  for (const closer of [
    /\n[ \t]*If you need specific details from before compaction/gi,
    /\n[ \t]*(?:Please )?[Cc]ontinue the conversation from where/g,
  ]) {
    let last = -1;
    for (const m of text.matchAll(closer)) last = m.index ?? last;
    if (last >= window && last < end) end = last;
  }
  return text.slice(0, end);
}

/** Markdown down to plain words: list markers, bold and code marks gone, one line. */
function plain(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim().replace(/^(?:[-*+•]|\d{1,2}[.)])[ \t]+/, ''))
    .filter(Boolean)
    .join(' ')
    .replace(/\*\*|__/g, '')
    .replace(/`+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A cut with no space near it can land between the two halves of an emoji,
 * which arrives on their screen as a question-mark box. Drop the stray half.
 */
const LONE_HIGH = /[\uD800-\uDBFF]$/;
const LONE_LOW = /^[\uDC00-\uDFFF]/;

/** The front of the text, cut between words, with an ellipsis saying it was cut. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = text.slice(0, max - 1);
  const space = room.lastIndexOf(' ');
  const head = space > max * 0.6 ? room.slice(0, space) : room.replace(LONE_HIGH, '');
  return head.replace(/[\s,;:–—-]+$/, '') + '…';
}

/** The end of the text, from a word, with an ellipsis saying there was more before. */
function tailOf(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = text.slice(text.length - (max - 1));
  const space = room.indexOf(' ');
  const tail = space >= 0 && space < max * 0.4 ? room.slice(space + 1) : room.replace(LONE_LOW, '');
  return '…' + tail.replace(/^[\s,;:–—-]+/, '');
}

export function previewOf(summary: string, max = PREVIEW_CHARS): CompactionPreview {
  const text = bodyOf(typeof summary === 'string' ? summary : '');
  const lines = text.split('\n');
  const marks = headings(lines);
  for (const [from, names] of PREFERENCE) {
    const section = lastSection(lines, marks, names);
    if (section === null) continue;
    const words = plain(section);
    if (words) return { text: cut(words, max), from };
  }
  const words = plain(text);
  return { text: words ? tailOf(words, max) : '', from: 'tail' };
}
