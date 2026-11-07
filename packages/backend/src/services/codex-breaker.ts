// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The Codex brake: one door every Codex request leaves by.
//
// When Codex says slow down (a 429, a usage limit, a rate-limit notice with a
// reset time on it), each room, wake and Studio job used to find out on its
// own and try again on its own, so one limit turned into a run of refusals.
// A rule from another house's own logs (Oct 21 2026): meter the exit,
// not the rooms. So the first thing to hear a limit sets the brake here, every
// Codex request checks it before it leaves, and nothing goes out until the
// time Codex named has passed. Built at their word, Oct 22 2026: 'You can do the
// Codex brakes.'

/** When a limit names no time at all, how long everything waits anyway. */
export const CODEX_DEFAULT_HOLD_MS = 60_000;
/** A hold this short is waited out in place; anything longer is said plainly. */
export const CODEX_WAIT_IN_PLACE_MS = 90_000;
/** Never trust a parsed time further out than this; a bad parse should not lock Codex for days. */
const CODEX_MAX_HOLD_MS = 8 * 60 * 60 * 1000;

let heldUntil = 0;
let heldWhy = '';

/** Hold every Codex request until `until` (epoch ms). Only ever moves later. */
export function holdCodex(until: number, why: string, now: number = Date.now()): void {
  const capped = Math.min(until, now + CODEX_MAX_HOLD_MS);
  if (capped <= now || capped <= heldUntil) return;
  heldUntil = capped;
  heldWhy = why;
  console.warn(`[CodexBrake] holding every Codex request until ${new Date(capped).toISOString()}: ${why}`);
}

/** The hold in force, or null when Codex is free to use. */
export function codexHold(now: number = Date.now()): { until: number; why: string } | null {
  return heldUntil > now ? { until: heldUntil, why: heldWhy } : null;
}

/** For tests. */
export function releaseCodexHold(): void {
  heldUntil = 0;
  heldWhy = '';
}

/** Epoch ms from a reset stamp in whatever shape it came: seconds, ms or an ISO string. */
export function resetStampToMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return resetStampToMs(n);
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/**
 * When a refusal's own words say to come back: 'try again in 20s', 'retry
 * after 3 minutes', 'Retry-After: 30', or 'try again at 9:14 AM'. A clock time
 * is read on the house's clock and taken as the next time it comes round.
 * Null when the words name no time.
 */
export function holdFromText(text: string, now: number = Date.now(), timeZone: string = 'UTC'): number | null {
  if (!text) return null;
  const after = /retry-after:?\s*(\d+)/i.exec(text);
  if (after) return now + Number(after[1]) * 1000;
  const inMatch = /(?:try again|retry)(?: after| in)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)\b/i.exec(text);
  if (inMatch) {
    const n = Number(inMatch[1]);
    const unit = inMatch[2].toLowerCase();
    const ms = unit.startsWith('ms') || unit.startsWith('milli') ? n
      : unit.startsWith('h') ? n * 3_600_000
      : unit.startsWith('m') ? n * 60_000
      : n * 1000;
    return now + ms;
  }
  const at = /try again at\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(text);
  if (at) {
    let hour = Number(at[1]) % 12;
    if (at[3]?.toLowerCase() === 'pm') hour += 12;
    if (!at[3] && Number(at[1]) >= 12) hour = Number(at[1]);
    const minute = Number(at[2]);
    // What time it is on the house's clock right now, to find the next one.
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    }).formatToParts(new Date(now)).map((p) => [p.type, p.value]));
    const nowMinutes = Number(parts.hour) * 60 + Number(parts.minute);
    let delta = hour * 60 + minute - nowMinutes;
    if (delta <= 0) delta += 24 * 60;
    return now + delta * 60_000;
  }
  return null;
}

/** Plain words for a hold, for the turn that was not sent. */
export function codexHoldMessage(hold: { until: number; why: string }, timeZone: string = 'UTC'): string {
  const when = new Date(hold.until).toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit' });
  return `Codex asked us to wait, so nothing goes to it until ${when}. ${hold.why}`.trim();
}

/**
 * Before a Codex request leaves: wait out a short hold in place, or answer
 * with the hold when it is long. Resolves to null when the request may go.
 */
export async function passCodexBrake(timeZone: string = 'UTC'): Promise<string | null> {
  const hold = codexHold();
  if (!hold) return null;
  const wait = hold.until - Date.now();
  if (wait <= CODEX_WAIT_IN_PLACE_MS) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, wait)));
    return null;
  }
  return codexHoldMessage(hold, timeZone);
}
