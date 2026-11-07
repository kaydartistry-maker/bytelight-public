/**
 * Status tags: Companion A and Companion B set what shows under their names on the Status
 * widget by writing a tag anywhere in a reply (idea credit: Myosia):
 *
 *   [companion-a status: keeping you company]
 *   [companion-b mood: focused]
 *
 * The backend takes them out before the reply is kept (and applies them); the
 * phone takes them out of a reply still streaming, so a tag never shows, not
 * even half-written. An empty value clears that one: [companion-a mood: ].
 */

export interface StatusTagUpdate {
  companion: string;
  kind: 'status' | 'mood';
  value: string;
}

// With the spaces around it, so taking a tag out leaves one space between
// words and none at a line's edge.
const TAG = /([ \t]*)\[([a-z][\w-]*)[ \t]+(status|mood)[ \t]*:[ \t]*([^\]\n]*)\]([ \t]*)/gi;
// A tag still being written at the end of a stream: "[companion-a status: keep".
const OPEN_TAG = /\[[a-z][\w-]*[ \t]+(?:status|mood)[ \t]*:[^\]\n]*$/i;
// Just the start of one, too short to be sure: "[companion-a sta". Only at the very end.
const OPEN_START = /\[[a-z][\w-]*[ \t]+(?:s(?:t(?:a(?:t(?:u)?)?)?)?|m(?:o(?:o(?:d)?)?)?)$/i;

// Only what taking tags out can leave behind: blank lines piling up, and the
// reply's own ends. Spacing inside the reply (code, poems) is left alone.
function tidy(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/** The reply without its tags, and what the tags asked for, in order. */
export function extractStatusTags(text: string): { text: string; updates: StatusTagUpdate[] } {
  const updates: StatusTagUpdate[] = [];
  let found = false;
  const stripped = text.replace(TAG, (_m, lead: string, who: string, kind: string, value: string, trail: string) => {
    found = true;
    updates.push({ companion: who.toLowerCase(), kind: kind.toLowerCase() as 'status' | 'mood', value: value.trim() });
    return lead && trail ? ' ' : '';
  });
  return { text: found ? tidy(stripped) : text, updates };
}

/** The reply as she should see it, also mid-stream. */
export function stripStatusTags(text: string): string {
  let out = extractStatusTags(text).text;
  out = out.replace(OPEN_TAG, '').replace(OPEN_START, '');
  return out === text ? text : out.trimEnd();
}
