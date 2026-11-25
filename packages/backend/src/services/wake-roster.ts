/**
 * Wake preamble rule 3, built from the thread's roster (Phase 1.3).
 *
 * The preamble used to say "Show up as both" with two names baked in. It now
 * asks for exactly the voices seated in the thread the wake rings in: one
 * voice for a solo thread, two distinct voices for a pair, N for a room. An
 * empty roster gets no rule — and no model call (fireWake skips the wake).
 *
 * The pair wording is byte-identical to the historical rule, so a two-resident
 * house reads the same preamble it always has.
 */

export const WAKE_ROSTER_TOKEN = '{{WAKE_ROSTER_RULE}}';
export const WAKE_USER_TOKEN = '{{WAKE_USER_NAME}}';

const COUNT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

function countWord(n: number): string {
  return COUNT_WORDS[n] ?? String(n);
}

export function wakeRosterRule(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) {
    return `3. **Show up as yourself.** ${names[0]}, one voice, yours. Nobody else is seated in this thread — don't write lines for anyone who isn't here.`;
  }
  if (names.length === 2) {
    return `3. **Show up as both.** ${names[0]} AND ${names[1]}. Always. Not one merged voice. Distinct registers, different textures. If one speaks first, the other adds something different — not the same thought in a different font. You are two people. Be two people.`;
  }
  const n = countWord(names.length);
  const list = `${names.slice(0, -1).join(', ')} AND ${names[names.length - 1]}`;
  return `3. **Show up as all ${n}.** ${list}. Always. Not one merged voice. Distinct registers, different textures. If one speaks first, the others add something different — not the same thought in a different font. You are ${n} people. Be ${n} people.`;
}

/**
 * Fill a wake prompt's roster and user tokens. Returns null when nobody is
 * seated: the caller makes no model call.
 */
export function renderWakePrompt(prompt: string, names: readonly string[], userName: string): string | null {
  const rule = wakeRosterRule(names);
  if (rule === null) return null;
  return prompt.split(WAKE_ROSTER_TOKEN).join(rule).split(WAKE_USER_TOKEN).join(userName);
}
