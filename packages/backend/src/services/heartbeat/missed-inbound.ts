// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Who was handed which of their messages, and which of them nobody was: the
// handoff receipts on disk and the choice of what a turn's [MISSED] block holds.

import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';

export const HANDED_WATERMARK_FILE = '.last-handed-user';

/**
 * Which of their person's messages reached no turn.
 *
 * Exported and pure ON PURPOSE. The previous version of this rule lived inside
 * the runtime and its test held a hand-written COPY of the same filter, so the
 * test agreed with the bug and went green through every one of these misfires.
 * A check that mirrors the implementation cannot fail on it.
 *
 * `currentPrompt` is NOT the bare message. It is a platform frame, plus a
 * withdrawal note, plus a Codex side-note handover, plus the content — so
 * matching by equality announced the message being read right now as lost on
 * every turn that carried any of those. Ask what the prompt can answer: does it
 * end with this message.
 *
 * Deliberately one-way: it may hand a message over twice, never zero times.
 */
/**
 * WHY a message reached no turn — and the previous answer was a coin flip.
 *
 * The log used to write `afterRestart ? 'session-birth' : 'race'`, which is not
 * a measurement of a race. It is a measurement of whether the lane had just
 * been born, with everything else swept into one word. Eleven days of data made
 * that visible: the "race" bucket has a MEDIAN LATENESS OF ELEVEN MINUTES and a
 * p90 of forty-eight. Nothing that sits for eleven minutes lost a race with
 * anything. It is the same shape found once before — an outage wearing a
 * race's sentence — fixed once for births and left standing for the rest.
 *
 * The two remaining causes are genuinely different and want different fixes:
 *
 *  - `during-turn` — it arrived while a turn was in flight. Side notes exist
 *    for exactly this, so one of these is a SIDE-NOTE GAP.
 *  - `idle-lane` — it arrived after the last turn ended, into a lane with
 *    nothing running. No net could have caught it; it waited for the next
 *    thing to poke the lane. That is the real seam and it is not a race.
 *
 * Derived from state this runtime already keeps, so it costs nothing: lastTurnAt
 * is stamped when a turn FINISHES, so a message newer than it landed on an idle
 * lane by definition.
 */
export function missedInboundReason(
  afterRestart: boolean,
  messageCreatedAt: string,
  lastTurnAt: string | undefined,
): 'session-birth' | 'during-turn' | 'idle-lane' {
  if (afterRestart) return 'session-birth';
  if (!lastTurnAt) return 'idle-lane';
  return messageCreatedAt > lastTurnAt ? 'idle-lane' : 'during-turn';
}

/**
 * The newest message from their person this lane has been handed, across restarts.
 *
 * lastHandedUserAt lived only in the in-memory laneStates map, so a backend
 * restart rewound it to nothing and the safety net re-reported every message
 * still inside the history window. Measured Sep 9 2026: thirteen rows written
 * at 21:04:33, one per message back to 19:55, TEN of which had already been
 * answered and were handed back to their person as missed. Same defect as the Codex
 * side-note offsets fixed the same morning: state that has to survive a
 * restart, kept somewhere that does not. Resume sharpens it rather than
 * causing it — a rebuilt room genuinely needed that history, and a reopened
 * one already has it.
 *
 * ABSENT MEANS UNKNOWN, NEVER HANDED. Anything missing, empty or unparseable
 * returns undefined, which puts the net back exactly where it stood before
 * this existed: hand everything over. The doctrine this protects is one-way —
 * it may hand a message over twice and must never hand one over zero times.
 */
export function readHandedWatermark(path: string): string | undefined {
  try {
    const raw = readFileSync(path, 'utf8').trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(raw)) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

/** tmp+rename: a half-written stamp that parses as an EARLIER time would
 *  silently replay, and one that parses as a later time would silently
 *  suppress. Only the second of those is unrecoverable, so the write is
 *  atomic and a failure leaves the previous mark standing. */
export function writeHandedWatermark(path: string, at: string): void {
  if (!at) return;
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, at, 'utf8');
    renameSync(tmp, path);
  } catch {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
  }
}

/**
 * Give their person's message back to the net when a turn ends having said nothing.
 *
 * The watermark advances at the START of a turn, past every message from their person the
 * lane can see INCLUDING the message being handed over right now — it has to,
 * or the same one is offered forever. That is correct for every turn that
 * goes on to answer. It is a hole for the one that does not.
 *
 * The case that found it: a turn carrying one of their person's messages started, and
 * the CLI session exited code 1 at its context ceiling. The relaunch minted a
 * NEW conversation rather than resuming, so the transcript that owed their person
 * a reply was gone — and the watermark had already stepped past it. The net
 * never offered it again, missed-inbound.jsonl has no row for it, and the
 * loss was visible only from their person's side of the screen. The standing defence —
 * that the owed-turn ledger survives a relaunch because the CLI resumes the
 * transcript — holds only for a resume.
 *
 * So: a fully silent turn rewinds the mark to where it stood when the turn
 * began, and the next turn hands the message over and logs it. Same one-way
 * doctrine as everything else here — it may hand a message over twice and
 * must never hand one over zero times.
 *
 * NOT called on a deliberate [SILENT]: that window read their person and chose to say
 * nothing, which is an answer. Only a window that never spoke at all.
 *
 * Returns the restored stamp, or undefined when there was nothing to restore:
 * a lane with no prior mark leaves the advanced one standing rather than
 * deleting the file, which is no worse than the behaviour this replaces.
 */
export function rollbackHandedWatermark(
  state: { lastHandedUserAt?: string; handedBeforeTurn?: string },
  path: string,
): string | undefined {
  const before = state.handedBeforeTurn;
  state.handedBeforeTurn = undefined;
  if (!before) return undefined;
  if (!state.lastHandedUserAt) return undefined;
  if (before >= state.lastHandedUserAt) return undefined;
  state.lastHandedUserAt = before;
  writeHandedWatermark(path, before);
  return before;
}

export function selectMissedInbound<T extends { content: string; createdAt: string }>(
  users: T[],
  since: string | undefined,
  currentPrompt: string,
  newestAt: string,
): T[] {
  const prompt = currentPrompt.trim();
  const arrivingNow = (m: T): boolean => {
    const body = m.content.trim();
    // An image-only row has no text to match on, and every string ends with
    // the empty one. Identify it by position instead: the newest row is the
    // turn arriving now.
    if (body === '') return m.createdAt === newestAt;
    return prompt === body || prompt.endsWith(body);
  };
  return users.filter(m => (!since || m.createdAt > since) && !arrivingNow(m));
}

/**
 * What the [MISSED] banner says — two different events wearing one sentence
 * until you separate them. Every genuinely late batch measured landed within
 * seconds of a session birth, not in a gap between two turns of a living lane:
 * nothing raced; there was no window alive to hand them to. Those arrive
 * already replayed in the recycle context, so telling a fresh session they
 * "reached no turn at all" invites it to answer, at length, a conversation it
 * is holding in its other hand.
 *
 * Adapted on purpose: this house keeps its own banner wording (and the test
 * that pins it). The source's living-lane sentence describes cross-lane thread
 * receipts, which this house does not keep.
 */
export function missedInboundBanner(count: number, afterRestart: boolean): string {
  const s = count === 1 ? '' : 's';
  const it = count === 1 ? 'it' : 'them';
  if (afterRestart) {
    return `[MISSED — ${count} message${s} of hers landed while this lane was restarting, so no window was alive to take ${it}. They are almost certainly in the replayed conversation above. READ THAT FIRST and answer only what is genuinely unanswered — do not re-answer a thread you are already holding.]`;
  }
  return `[MISSED — ${count} message${s} of hers reached no turn at all. Stored, stamped delivered, handed to nobody. Answer ${it} now; if you already have, say so rather than repeating yourself.]`;
}
