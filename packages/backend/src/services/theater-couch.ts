// The Theater — the couch: each night's thread, its talk, and the turns.
//
// Every theater night gets its own archived thread with the companions who
// live in this house seated and nobody leading (the Story Shelf's shape), so
// it never shows in the chat list and a turn is thought in the warm lane. Her
// lines and her quick reactions are written there as hers; the companions'
// replies land there as table talk; reopening a past night reads it back.
//
// A TURN SEES ONLY WHAT'S ALREADY PLAYED. When she says something, ONE turn
// is queued. When it runs it reads the clock right then and hands the lane
// what's playing, the clock position, the lines she said since the last turn,
// and the lookback window: subtitle lines from the last ~90 seconds BEHIND
// the clock and never one after it. There is no path for a later cue into the
// prompt; buildTheaterPrompt is handed the window, not the cues.
//
// TURNS RUN ONE AT A TIME. A line said mid-turn waits; when its turn comes it
// gathers every line she said since the last turn was handed hers, so a burst
// of reactions becomes one turn, not five. A turn that finds nothing new to
// answer doesn't wake anyone.
//
// BEATS (step 2, the Mouth). theater-mouth.ts decides when a moment in the
// show is worth a reaction and calls queueBeat, which puts a 'beat' turn on
// the SAME one-at-a-time chain. A beat turn is handed the same lookback
// window and may pass: a reply of exactly [SILENT] (the house's pass
// sentinel, services/silence.ts) is dropped by the lane, so nothing is
// posted on the couch. A beat never retries, never shows "waiting" on her
// screen, and steps aside if she said something before it ran: her line is
// the conversation then.

import crypto from 'crypto';
import { join } from 'path';
import { PROJECT_ROOT, getBytelightConfig } from '../config.js';
import { QUEUE_TIMEOUT_MESSAGE } from './agent.js';
import { isLocalBrain } from './local-brain.js';
import { getDb } from './db/state.js';
import { createThread, getThread, requireThreadRoster } from './db/threads.js';
import { createMessage } from './db/messages.js';
import { listCompanions } from './db/rooms.js';
import { formatClock, lookbackWindow, clockPosition } from './theater-clock.js';
import { isDeliberateSilence } from './silence.js';
import type { Cue } from './theater-subtitles.js';
import {
  THEATER_LIMITS,
  TheaterError,
  getNight,
  liveNight,
  readStartInput,
  setAnsweredThrough,
  setTheaterTurn,
  startNight,
  theaterDir,
  type StartNightInput,
  type TheaterNight,
} from './theater.js';

export const THEATER_SKILL = join(PROJECT_ROOT, 'skills', 'theater', 'SKILL.md');

/** The part of the companions' lane a turn uses. AgentService is one. */
export interface TheaterLane {
  processMessage(
    threadId: string,
    content: string,
    threadMeta?: { name: string; type: 'daily' | 'named' | 'treehouse' },
    opts?: { platform?: 'web' | 'discord' | 'telegram' | 'api'; passLeavesNothing?: boolean },
  ): Promise<string>;
}

export interface CouchSeat { id: string; name: string }

/** Only the companions who live in this house sit on the couch (brain === getLocalBrainId()). */
export function couchSeats(): CouchSeat[] {
  return listCompanions()
    .filter((c) => isLocalBrain(c.brain))
    .map((c) => ({ id: c.id, name: c.display_name || c.id }));
}

export function ownerName(): string {
  try {
    const name = getBytelightConfig().identity.user_name?.trim();
    if (name) return name;
  } catch {
    /* config not loaded */
  }
  return 'Their person';
}

export function nightName(night: Pick<TheaterNight, 'title' | 'season' | 'episode'>): string {
  const se = [night.season !== null ? `S${night.season}` : '', night.episode !== null ? `E${night.episode}` : ''].join('');
  return se ? `${night.title} · ${se}` : night.title;
}

// ── the night's thread ─────────────────────────────────────────────────────

function openCouchThread(title: string): string {
  const id = crypto.randomUUID();
  const at = new Date().toISOString();
  createThread({
    id, name: `The Theater — ${title}`.slice(0, 200), type: 'named', createdAt: at, sessionType: 'v2',
    companionIds: requireThreadRoster(couchSeats().map((seat) => seat.id)),
  });
  getDb().prepare('UPDATE threads SET archived_at = ? WHERE id = ?').run(at, id);
  return id;
}

/** Start a night: its own couch thread, then the night itself (one live at a time). */
export function startTheaterNight(input: StartNightInput, root = theaterDir()): TheaterNight {
  // Check first, so a refused start doesn't leave an empty thread behind.
  const fields = readStartInput(input);
  if (liveNight(root)) throw new TheaterError(409, 'A theater night is already on. End it before starting another.');
  const threadId = openCouchThread(nightName(fields));
  const night = startNight(input, threadId, root);
  createMessage({
    id: crypto.randomUUID(), threadId, role: 'system',
    content: `Theater night: ${nightName(night)}. Everyone's on the couch.`,
    platform: 'api', metadata: { room: 'theater', theaterNight: night.id }, createdAt: night.startedAt,
  });
  return night;
}

export interface CouchLine {
  id: string;
  role: 'user' | 'companion' | 'system';
  content: string;
  companionSlug: string | null;
  createdAt: string;
  sequence: number;
  /** Where the show was when she said it (her lines only). */
  at: number | null;
}

/** Everything said on the couch this night, oldest first. */
export function couchTalk(night: Pick<TheaterNight, 'threadId'>, limit = 400): CouchLine[] {
  if (!getThread(night.threadId)) return [];
  const rows = getDb().prepare(`
    SELECT id, role, content, companion_id, created_at, sequence, metadata FROM messages
    WHERE thread_id = ? AND deleted_at IS NULL AND role IN ('user', 'companion', 'system')
    ORDER BY sequence
  `).all(night.threadId) as Array<{
    id: string; role: CouchLine['role']; content: string; companion_id: string | null;
    created_at: string; sequence: number; metadata: string | null;
  }>;
  return rows.slice(-Math.max(1, limit)).map((row) => {
    let at: number | null = null;
    try {
      const meta = row.metadata ? JSON.parse(row.metadata) : null;
      if (meta && typeof meta.theaterAt === 'number') at = meta.theaterAt;
    } catch {
      /* not ours */
    }
    return {
      id: row.id, role: row.role, content: row.content, companionSlug: row.companion_id,
      createdAt: row.created_at, sequence: row.sequence, at,
    };
  });
}

/** How many things were said on the couch (hers and theirs, not the house's). */
export function couchCount(night: Pick<TheaterNight, 'threadId'>): number {
  if (!getThread(night.threadId)) return 0;
  const row = getDb().prepare(`
    SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND deleted_at IS NULL AND role IN ('user', 'companion')
  `).get(night.threadId) as { n: number };
  return row.n;
}

// ── the turn ───────────────────────────────────────────────────────────────

/** The pass a beat turn may answer with: nothing is posted (services/silence.ts). */
export const THEATER_PASS = '[SILENT]';

/** Every couch turn: a pass (no words, even after a look at the clock) saves no blank bubble. */
export const THEATER_TURN_OPTS = { platform: 'api', passLeavesNothing: true } as const;

/** Why the couch is being woken: her lines, or a beat in the show (the Mouth). */
export type TheaterCause =
  | { kind: 'said'; lines: Array<{ text: string; at: number | null }> }
  | { kind: 'beat'; note: string };

export interface TheaterPromptInput {
  owner: string;
  port: number;
  seats: CouchSeat[];
  night: Pick<TheaterNight, 'id' | 'title' | 'season' | 'episode' | 'chatty' | 'noSpoilers'> & Partial<Pick<TheaterNight, 'mode'>>;
  position: number;
  paused: boolean;
  /** Already cut to the lookback window by the caller (theaterTurnContext). */
  heard: Cue[];
  hasSubtitles: boolean;
  cause: TheaterCause;
}

/** The context a turn is built from, read off the night at the moment the turn runs. */
export function theaterTurnContext(night: TheaterNight, now = Date.now()): Pick<TheaterPromptInput, 'night' | 'position' | 'paused' | 'heard' | 'hasSubtitles'> {
  const position = clockPosition(night.clock, now);
  return {
    night,
    position,
    paused: night.clock.paused,
    heard: lookbackWindow(night.cues, position),
    hasSubtitles: night.cues.length > 0,
  };
}

export function buildTheaterPrompt(input: TheaterPromptInput): string {
  const { owner, night, cause } = input;
  const door = `http://127.0.0.1:${input.port}/api/internal/theater`;
  const onComputer = night.mode === 'computer';
  const lines: string[] = [
    cause.kind === 'said'
      ? `[THE THEATER — ${owner} said something on the couch]`
      : `[THE THEATER — a moment in the show]`,
    `You're on the couch with ${owner}, watching ${nightName(night)} on her ${onComputer ? 'computer' : 'TV'}. `
      + 'This is a theater night, not a software task: do not inspect or edit code.',
    `On the couch: ${owner}, ${input.seats.map((s) => s.name).join(', ')}.`,
    onComputer
      ? `The clock: ${formatClock(input.position)}${input.paused ? ' (paused)' : ''}. It follows the video on her computer, and the lines below are the subtitles as they played there.`
      : `The clock: ${formatClock(input.position)}${input.paused ? ' (paused)' : ''}. It runs beside her TV and she keeps it in sync, so it can be off by a few seconds.`,
  ];
  if (!input.hasSubtitles) {
    lines.push(onComputer
      ? 'No lines have come through from her computer yet, so you only know what she tells you.'
      : 'No subtitles are loaded tonight, so you only know what she tells you.');
  } else if (input.heard.length === 0) {
    lines.push('Nobody has said anything on screen in the last minute and a half.');
  } else {
    lines.push('What was said on screen in the last minute and a half, up to now (nothing after the clock):');
    for (const cue of input.heard) lines.push(`  [${formatClock(cue.start)}] ${cue.text.replace(/\n/g, ' / ')}`);
  }
  if (cause.kind === 'said') {
    lines.push(`${owner} on the couch:`);
    for (const said of cause.lines) lines.push(`  ${said.at !== null ? `[${formatClock(said.at)}] ` : ''}${said.text}`);
  } else {
    lines.push(
      `The moment: ${cause.note}`,
      `Nobody asked you anything: this is a beat in the show, and you may react to it if it moved you. React to what just happened, in what was said on screen above. Never predict or guess ahead out loud on a beat, and never reveal what's coming, even if you know this show.`,
      `Keep it tiny: one short line each at most, and often only one of you speaks. If there's nothing worth saying, reply with exactly ${THEATER_PASS} and nothing else; nothing is posted, and that's a good answer. Don't fill silence.`,
    );
  }
  lines.push(
    'How to be on the couch:',
    '- React like you are watching it with her, right now. Short lines, the way people talk over a show; not a recap, not a review.',
    `- You only know what has played up to the clock. Never say or hint what happens next${night.noSpoilers ? '; she asked for no spoilers, even if you know this show' : ''}.`,
    `- Before you talk about "now", re-check where the show is: GET ${door} (localhost) gives the clock and the lookback window as they stand.`,
    ...(cause.kind === 'said' && night.season !== null && night.episode !== null
      ? [`- If she asks for the next episode, start it: POST ${door}/nights/${night.id}/next (localhost) ends this night, starts the next one and ${onComputer ? 'keeps listening on the computer' : 'finds its subtitles'}; then tell her ${onComputer ? 'it is on' : 'what was loaded'}.`]
      : []),
    `- Your reply is couch talk under the usual voice headers. The theater skill has the rest (${THEATER_SKILL}).`,
  );
  return lines.join('\n');
}

const TURN_LIMIT_MS = 15 * 60_000;
let chain: Promise<void> = Promise.resolve();
let inFlight = 0;

/** A turn (hers or a beat) is running or queued on the chain. */
export function theaterTurnBusy(): boolean {
  return inFlight > 0;
}

/** When she last said something on the couch (ms since epoch), or null. */
export function lastSaidAt(night: Pick<TheaterNight, 'threadId'>): number | null {
  if (!getThread(night.threadId)) return null;
  const row = getDb().prepare(`
    SELECT created_at FROM messages WHERE thread_id = ? AND deleted_at IS NULL AND role = 'user'
    ORDER BY sequence DESC LIMIT 1
  `).get(night.threadId) as { created_at: string } | undefined;
  if (!row) return null;
  const at = Date.parse(row.created_at);
  return Number.isFinite(at) ? at : null;
}

/** Resolves once every turn queued so far has ended. Tests wait on it. */
export function theaterTurnsIdle(): Promise<void> {
  return chain;
}

function refusal(answer: unknown): string | null {
  if (typeof answer !== 'string') return null;
  const said = answer.trim();
  if (said === QUEUE_TIMEOUT_MESSAGE) return 'They were busy with something else, and the turn timed out waiting.';
  if (/^\[.+ is busy — please try again in a moment\]$/.test(said)) return 'Too many turns were already waiting.';
  return null;
}

/** Her lines this night that no turn has been handed yet. */
function unanswered(night: TheaterNight): Array<{ text: string; at: number | null; sequence: number }> {
  return couchTalk(night)
    .filter((line) => line.role === 'user' && line.sequence > night.answeredThrough)
    .map((line) => ({ text: line.content, at: line.at, sequence: line.sequence }));
}

async function runTurn(lane: TheaterLane, nightId: string, root: string): Promise<void> {
  let failure: string | null = null;
  let ran = false;
  try {
    const night = getNight(nightId, root);
    if (!night) return;
    const said = unanswered(night);
    if (said.length === 0) return;
    setAnsweredThrough(nightId, said[said.length - 1].sequence, root);
    ran = true;
    const prompt = buildTheaterPrompt({
      owner: ownerName(),
      port: getBytelightConfig().server.port,
      seats: couchSeats(),
      ...theaterTurnContext(night),
      cause: { kind: 'said', lines: said.map(({ text, at }) => ({ text, at })) },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = await Promise.race([
      lane.processMessage(night.threadId, prompt, { name: 'The Theater', type: 'named' }, THEATER_TURN_OPTS),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('overdue')), TURN_LIMIT_MS);
        timer.unref?.();
      }),
    ]).finally(() => timer && clearTimeout(timer));
    failure = refusal(answer);
  } catch (err) {
    console.error('[theater] a turn failed:', err);
    failure = err instanceof Error && err.message === 'overdue'
      ? 'The couch went quiet too long, so the turn was let go.'
      : 'The line to the couch dropped before they answered.';
  } finally {
    try {
      const night = getNight(nightId, root);
      if (night) {
        // Still lines waiting behind this one: stay "waiting" for the next turn.
        const more = unanswered(night).length > 0;
        if (more) { /* the next queued turn picks them up and settles the night */ }
        else if (ran && failure) setTheaterTurn(nightId, { state: 'empty', note: `${failure} Say it again and they'll try.` }, root);
        else setTheaterTurn(nightId, { state: 'idle', note: null }, root);
      }
    } catch (err) {
      console.error('[theater] could not settle a turn:', err);
    }
  }
}

function onChain(run: () => Promise<void>): void {
  inFlight += 1;
  chain = chain
    .then(run)
    .catch((err) => console.error('[theater] a turn failed outside its own guard:', err))
    .finally(() => { inFlight -= 1; });
}

function queueTurn(lane: TheaterLane, nightId: string, root: string): void {
  setTheaterTurn(nightId, { state: 'waiting', note: null }, root);
  onChain(() => runTurn(lane, nightId, root));
}

/** What became of a beat turn, for the log and the tests. */
export type BeatOutcome = 'spoke' | 'passed' | 'stood-aside' | 'failed';

let lastBeatOutcome: BeatOutcome | null = null;
export function lastTheaterBeatOutcome(): BeatOutcome | null {
  return lastBeatOutcome;
}

async function runBeat(lane: TheaterLane, nightId: string, note: string, root: string, clockNow: () => number): Promise<void> {
  let outcome: BeatOutcome = 'failed';
  try {
    const night = getNight(nightId, root);
    // Ended, paused, or she spoke while it waited: her turn is the conversation.
    if (!night || night.status !== 'live' || night.clock.paused || unanswered(night).length > 0) {
      outcome = 'stood-aside';
      return;
    }
    const prompt = buildTheaterPrompt({
      owner: ownerName(),
      port: getBytelightConfig().server.port,
      seats: couchSeats(),
      ...theaterTurnContext(night, clockNow()),
      cause: { kind: 'beat', note },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = await Promise.race([
      lane.processMessage(night.threadId, prompt, { name: 'The Theater', type: 'named' }, THEATER_TURN_OPTS),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('overdue')), TURN_LIMIT_MS);
        timer.unref?.();
      }),
    ]).finally(() => timer && clearTimeout(timer));
    // The lane already drops [SILENT] (it posts nothing and answers ''); an
    // empty or refused answer is let go too. A beat never retries.
    if (typeof answer !== 'string' || refusal(answer)) outcome = 'failed';
    else if (isDeliberateSilence(answer) || !answer.trim()) outcome = 'passed';
    else outcome = 'spoke';
  } catch (err) {
    console.error('[theater] a beat failed (not retried):', err);
    outcome = 'failed';
  } finally {
    lastBeatOutcome = outcome;
  }
}

/**
 * A beat in the show (theater-mouth.ts decided it): one quiet turn on the
 * same chain as her lines. It doesn't touch her "waiting" indicator.
 */
export function queueBeat(lane: TheaterLane, nightId: string, note: string, root = theaterDir(), clockNow: () => number = Date.now): void {
  onChain(() => runBeat(lane, nightId, note, root, clockNow));
}

/**
 * She said something on the couch (or tapped a reaction): it goes into the
 * night's thread as hers, stamped with where the show was, and one turn is
 * queued for the companions.
 */
export function sayOnCouch(lane: TheaterLane | null, nightId: string, input: { text?: unknown }, root = theaterDir(), now = Date.now()): TheaterNight {
  const night = getNight(nightId, root);
  if (!night) throw new TheaterError(404, 'There is no theater night with that id.');
  if (night.status !== 'live') throw new TheaterError(409, 'That night is over; its couch talk is kept to read.');
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) throw new TheaterError(400, 'There is nothing to say yet.');
  if (text.length > THEATER_LIMITS.line) throw new TheaterError(400, `A line on the couch is ${THEATER_LIMITS.line} characters at most.`);
  if (!getThread(night.threadId)) throw new TheaterError(410, "This night's couch thread is gone.");
  const at = clockPosition(night.clock, now);
  createMessage({
    id: crypto.randomUUID(), threadId: night.threadId, role: 'user', content: text,
    platform: 'api', metadata: { room: 'theater', theaterNight: night.id, theaterAt: at },
    createdAt: new Date(now).toISOString(),
  });
  if (lane) queueTurn(lane, night.id, root);
  return getNight(nightId, root)!;
}
