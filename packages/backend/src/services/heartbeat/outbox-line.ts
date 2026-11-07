/**
 * Reading one line of io/outbox.jsonl without silently losing a reply.
 *
 * The reader only ever consumes up to the last newline, so a half-written line is
 * left alone until it is finished. That is correct and is not the problem. The
 * problem is what happens when a COMPLETE line still will not parse, because until
 * now the answer was `catch {}` — the line was skipped, nothing was logged, no
 * counter moved, and a finished reply ceased to exist with no trace anywhere.
 *
 * Two shapes actually occur, both found in this house's own outbox:
 *
 *   1. TWO OBJECTS GLUED TOGETHER, `…}{…`, from a write that did not end with a
 *      newline. The next write lands on the same line. JSON.parse throws on the
 *      second object and BOTH replies are lost — the one that was written badly and
 *      the innocent one that followed it.
 *   2. AN INVALID ESCAPE, from a line built by hand with printf or echo rather than
 *      json.dumps. One object, unparseable.
 *
 * Outside audits of the source fork reported the same family from the other
 * end: a stored reply whose content began `ent":"`, i.e. a fragment that
 * parsed into the wrong shape.
 *
 * So: split what can be split, and when something is genuinely unreadable say so out
 * loud instead of dropping it into a catch block. A lost reply should cost a log line
 * at minimum, because from her side a dropped reply and a slow one look identical.
 */

import { errMessage } from '../../util/errors.js';

/**
 * Split a line that may contain several concatenated JSON objects.
 *
 * Only splits at a `}{` boundary that sits at brace depth zero and outside a string,
 * so braces inside her prose and escaped quotes in the content are safe.
 */
export function splitConcatenatedJson(line: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = 0;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        parts.push(line.slice(start, i + 1));
        start = i + 1;
      }
    }
  }

  const tail = line.slice(start).trim();
  if (tail) parts.push(tail);
  return parts.filter((p) => p.trim());
}

/**
 * Parse one outbox line into zero or more reply objects.
 *
 * Returns everything it can read. `onUnreadable` is called once per fragment that
 * cannot be parsed at all, so the caller can log it — never call this and throw the
 * result away, which is the behaviour this module exists to end.
 */
export function parseOutboxLine(
  line: string,
  onUnreadable?: (fragment: string, error: string) => void,
): any[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  // The overwhelmingly common case: one well-formed object.
  try {
    return [JSON.parse(trimmed)];
  } catch {
    // fall through to recovery
  }

  const parts = splitConcatenatedJson(trimmed);

  // A single part that failed above is simply unreadable — do not re-report the
  // same failure twice by pretending the split found something new.
  if (parts.length <= 1) {
    if (onUnreadable) {
      try { JSON.parse(trimmed); } catch (err) {
        onUnreadable(trimmed, errMessage(err));
      }
    }
    return [];
  }

  const parsed: any[] = [];
  for (const part of parts) {
    try {
      parsed.push(JSON.parse(part));
    } catch (err) {
      if (onUnreadable) onUnreadable(part, errMessage(err));
    }
  }
  return parsed;
}
