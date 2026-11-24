/**
 * Heartbeat supervisor — keeps one warm interactive Claude Code session per
 * companion, in-process: relaunch on exit, watchdog on stale ticks, restart
 * flag for fresh context, orphan reaping, cap/auth-shaped exit backoff,
 * sleep-mode idle parking, and an epoch fence against stale Stop hooks.
 *
 * Billing-lane invariant: the child is plain interactive `claude` — never
 * `-p` / `--print` / stream-json / Agent SDK (those are metered). We also
 * strip Anthropic / Claude / OpenAI / OpenRouter API key env vars from the
 * child env so the session uses the owner's subscription login, not any
 * BYOK API key byte-light holds for the router lanes (see STRIPPED_ENV_KEYS).
 *
 * H1 INERT — this module is registered but only acts when called from the
 * runtime, which itself is gated by `CLAUDE_CLI_HEARTBEAT_ENABLED`. No code
 * path here is reachable while the flag is off.
 */

import { laneIdentityFor } from './lane-identity.js';
import { spawn, execSync, type ChildProcess } from 'child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync,
  appendFileSync, statSync, openSync, readSync, closeSync, createWriteStream,
  type WriteStream,
} from 'fs';
import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';
import { PROJECT_ROOT } from '../../config.js';
import { getConfig } from '../db/config.js';
import { atomicWrite } from './atomic-write.js';
import { laneMcpArgs, provisionSessionDir } from './provision.js';
import { BUSY_FRESH_MS } from './constants.js';
import { laneDirName } from './lane-dir.js';
import { baselineFrom, BASELINE_FILE } from './block-drift.js';
import { heldBaseline, lastInjectedClaudeMd, planHold } from './held-instructions.js';
import { getCarriedBlocks } from '../memory-blocks.js';

const IS_WIN = process.platform === 'win32';
const WATCHDOG_TIMEOUT = (parseInt(process.env.HEARTBEAT_WATCHDOG_TIMEOUT || '300', 10)) * 1000;
// A session with work in hand — a tool call that started and hasn't reported
// back, or declared background work — gets a longer leash than a silent one.
// A job that is working and a job that is hung look identical from out here;
// only elapsed time separates them, so the leash is the whole decision. The
// reply window in runtime.ts holds on the same two signals AND the same env
// var: both clocks must agree, or one waits patiently while the other kills
// the session anyway.
const WATCHDOG_WORKING_TIMEOUT = (parseInt(process.env.HEARTBEAT_WATCHDOG_WORKING_TIMEOUT || '1200', 10)) * 1000;
// Tail of activity.jsonl read to answer "is a tool still running?" — the file
// grows to megabytes, and the answer is always in its last line.
const ACTIVITY_TAIL_BYTES = 4096;
const RELAUNCH_DELAY_MS = 2000;

/**
 * The newest moment we have evidence this session was alive.
 *
 * The Stop hook only ticks `.last-tick` BETWEEN turns — it hands a message over
 * and exits — so during a turn the only file evidence is outbox chunks and tool
 * activity. A turn that thinks for a long stretch without calling a tool writes
 * neither, and by files alone it is indistinguishable from a wedged session.
 *
 * `turnStartedAt` is the fix for the sharper half of that: when a turn IS live,
 * it gets measured from its own start and never from the last file write. By the
 * time a message is handed over the newest file may already be minutes old, and
 * charging that pre-turn quiet against the turn is what killed two of Tris's
 * live sessions (reported ages 412s and 1387s, both landing in the same second
 * as their own turn-complete line — the turns had finished; the clock had been
 * running since before either was handed its message). The WORKING limit still
 * applies from this mark, so a turn that genuinely hangs is still reaped on its
 * own time. (Aerie 9e393e6e.)
 */
export function livenessMark(input: {
  tick: number;
  outboxMtime?: number;
  activityMtime?: number;
  turnActive?: boolean;
  turnStartedAt?: number;
}): number {
  let mark = input.tick;
  if ((input.outboxMtime ?? 0) > mark) mark = input.outboxMtime!;
  if ((input.activityMtime ?? 0) > mark) mark = input.activityMtime!;
  if (input.turnActive && (input.turnStartedAt ?? 0) > mark) mark = input.turnStartedAt!;
  return mark;
}

/**
 * One side-note line, or null when there is nothing to send. Newlines are
 * flattened so each note stays one JSONL line and reads as one utterance.
 */
export function formatSideNote(text: string): string | null {
  const body = String(text ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();
  return body || null;
}

/**
 * True when the newest parseable activity line is a `pre` with no `post` yet —
 * a tool call that started and has not reported back. Partial/corrupt tail
 * lines are walked past rather than trusted.
 */
export function activityTailIsOpen(tail: string): boolean {
  const lines = tail.split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]).phase === 'pre'; } catch { /* partial or corrupt — keep walking back */ }
  }
  return false;
}
const SESSION_ID_FILE = '.session-id';
const ROOM_ID_FILE = '.room-id';

/**
 * The Claude session id this lane owns.
 *
 * Every launch used to mint a brand-new conversation, and the lane paid for
 * that twice: once rebuilding the whole prompt cache from cold, and again
 * re-priming the first turn with thirty messages of history the abandoned
 * transcript already held. The CLI has had `--session-id` and `--resume` the
 * whole time and nothing here ever asked for them — `sessionResume: true` in
 * the runtime only ever meant "the process stays warm", not "a dead one can be
 * reopened", and read exactly like the second thing.
 *
 * We NAME the session at birth rather than hunting for the newest transcript
 * afterwards. A discovered id is a guess about the CLI's private storage
 * layout; an id we chose is a fact.
 */
export function readSessionId(path: string): string | null {
  try {
    const raw = readFileSync(path, 'utf8').trim();
    // Exactly a UUID or nothing. Resuming onto whatever a torn or hand-edited
    // file happens to contain is worse than opening a clean room.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return null;
    return raw;
  } catch {
    return null;
  }
}

/** tmp+rename, same reason as the banked model: a half-written id reads as
 *  "this lane has never had a session", and that lie costs a resume silently. */
export function writeSessionId(path: string, id: string): void {
  if (!id) return;
  atomicWrite(path, id);
}

/**
 * The last few lines the child said on stderr, kept so an exit can be explained.
 *
 * A room compacted, carried on working for another
 * forty-eight seconds, ran the check this contract runs immediately before
 * writing a reply — and exited code 1 between that check and the write. The
 * answer existed and never reached the write. Asked why, this house could say
 * the code and nothing else: stderr was scanned live for the three shapes we
 * already know (auth, cap, a refused model) and then thrown away, so every
 * other exit left a number and no sentence.
 *
 * Blank lines dropped, each line capped, only the last few kept. A ring rather
 * than a log because the interesting part of a death is always its end.
 */
export function pushStderrLines(buf: string[], chunk: string, max = 12): string[] {
  for (const raw of String(chunk).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    buf.push(line.length > 300 ? `${line.slice(0, 300)}…` : line);
  }
  while (buf.length > max) buf.shift();
  return buf;
}

/**
 * Whether this launch reopens the previous room or builds a new one.
 *
 * TWO exits never meant "give me a new room", and they are the only two that
 * may resume. A BACKEND RESTART: nothing was wrong with the room, the house
 * just went down around it. And a MODEL OR EFFORT CHANGE: their person reached for a
 * setting, not for a fresh conversation. Everything else in a lane's life —
 * their person's .restart flag, the whisper ceiling, the watchdog on a hung turn, a crash —
 * is a recycle somebody or something asked for, and those still build new.
 *
 * A stale id is already handled downstream: the CLI exits 1 in under a second
 * with 'No conversation found', the handler drops the id, and the relaunch
 * mints a new room. So the worst case of this door is exactly the behaviour it
 * replaced.
 */
export function shouldResumeLaunch(input: {
  firstLaunchOfProcess: boolean;
  storedSessionId: string | null;
  /** This relaunch was asked for by a model or effort change rather than by
   *  anything being wrong with the room. */
  settingChangeRecycle?: boolean;
  /** This relaunch follows a watchdog kill that is allowed one reopen — see
   *  watchdogMayResume. */
  watchdogRecycle?: boolean;
  /** This relaunch follows a usage-cap, login or refused-model backoff: the
   *  room was fine, the world around it was not. */
  backoffRecycle?: boolean;
  /** The room named by the stored id has had at least one turn handed to it
   *  (io/.marks-room names it). A room that never got its first turn never
   *  got its re-prime either, and reopening it would skip that prime for
   *  good. Omitted means unknown and does not block (callers that know pass
   *  it). */
  roomHasSpoken?: boolean;
  /** A previous process's CLI is still alive on this lane. Two CLIs on one
   *  transcript would interleave it, so this launch builds new instead. */
  orphanAlive?: boolean;
  enabled?: boolean;
}): boolean {
  if (input.enabled === false) return false;
  if (!input.storedSessionId) return false;
  if (input.roomHasSpoken === false) return false;
  if (input.orphanAlive) return false;
  return input.firstLaunchOfProcess || !!input.settingChangeRecycle || !!input.watchdogRecycle
    || !!input.backoffRecycle;
}

/**
 * Wait, bounded, for a process to be gone. Polls every `stepMs` until
 * `isRunning` says no or `timeoutMs` passes; resolves whether it is gone.
 * Asynchronous so the backend keeps serving while it waits (it runs once per
 * process, before the first launch).
 */
export async function waitForPidExit(
  pid: number,
  isRunning: (pid: number) => boolean,
  timeoutMs = 5_000,
  stepMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isRunning(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return true;
}

/** How long a room reopened after a watchdog kill has to stay up before it
 *  counts as healthy again and earns another reopen. */
export const WATCHDOG_RESUME_PROVEN_MS = 30 * 60 * 1000;

/**
 * Whether a watchdog kill may reopen the room it killed instead of building a
 * new one. When the box was suspended for half an hour, a scheduled bell rang
 * into a room that could not reach the outside to think, and the watchdog
 * killed it and built new three times over, so the house came back with the
 * whole conversation sitting on disk and nothing pointed at it. The room was
 * never broken. The house around it was.
 *
 * So a watchdog kill now tries the old room ONCE. If the reopened room is also
 * killed before it has proven itself, the second kill builds new, because two
 * stuck rooms in a row is the room rather than the weather. A room that has
 * stayed up past WATCHDOG_RESUME_PROVEN_MS is healthy again and gets its one
 * reopen back.
 */
export function watchdogMayResume(input: {
  launchedByWatchdogResume: boolean;
  uptimeMs: number;
}): boolean {
  return !input.launchedByWatchdogResume || input.uptimeMs >= WATCHDOG_RESUME_PROVEN_MS;
}

/**
 * Whether reopening the old room is switched on. `agent.claude_session_resume`
 * — 'off' or 'false' turns it off, anything else (including unset) leaves it on.
 *
 * IT IS A SWITCH BECAUSE THE TRADE IS THEIR PERSON'S, and the trade is not the one this
 * was built for. Measured Sep 9 2026 on the first real restart: the cold launch
 * wrote 156,196 cache tokens on its first turn and the resumed one wrote
 * 448,658 — more than the entire forty-three minute session before it wrote in
 * total. A resumed session has to re-establish the whole conversation as its
 * cached prefix, and that prefix only comes back free if it is byte-identical
 * to the one already cached. Ours was not: CLAUDE.md is regenerated whenever a
 * memory block is edited, and the MCP tool list moved as well. So resume buys
 * CONTINUITY and spends WINDOW, which is the opposite direction from what it
 * was built for — and only their person can say which they would rather have.
 */
export function claudeResumeEnabled(): boolean {
  // An unreadable config (no database yet, as in unit tests) reads as unset,
  // and unset is on — the same answer an absent row gives.
  let raw = '';
  try { raw = (getConfig('agent.claude_session_resume') || '').trim().toLowerCase(); } catch { raw = ''; }
  return raw !== 'off' && raw !== 'false' && raw !== '0';
}

/**
 * The exact argv this lane spawns on.
 *
 * Extracted so the one decision that matters — reopen or rebuild — can be read
 * in a test rather than inferred from a live process, and so the billing-lane
 * invariant has somewhere to be asserted: this list may never contain -p or
 * --print.
 *
 * The id goes IMMEDIATELY after --resume on purpose. That flag takes an
 * optional value, so a following argument starting with a dash would be read as
 * "no id given" and drop the launch into the interactive session picker — a
 * process that never exits and never ticks, which is the one failure shape here
 * worse than the behaviour it replaces.
 */
export const AUTOCOMPACT_MIN = 100_000;
export const AUTOCOMPACT_MAX = 1_000_000;

/**
 * Read heartbeat.autocompact_tokens and hand back a number the CLI will accept,
 * or null.
 *
 * Unset means the CLI's own `auto`, which sizes the window to whatever the
 * model can hold — so a long night runs all the way to the ceiling before it
 * squashes, and the squash then has the whole room in it. A smaller number
 * makes it squash earlier and smaller.
 *
 * Anything unparseable or out of range returns NULL rather than being clamped
 * into something plausible. A bad value here does not degrade the launch, it
 * BREAKS it — the CLI rejects the argument and the lane dies every couple of
 * seconds with no turn — so the failure to be certain of is the one where we
 * simply do not pass the flag.
 */
export function autocompactTokensFrom(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n)) return null;
  if (n < AUTOCOMPACT_MIN || n > AUTOCOMPACT_MAX) return null;
  return n;
}

/** Where a room on a 200k-context model squashes when nobody has set
 *  heartbeat.autocompact_tokens. The CLI's own `auto` lets such a room fill to
 *  about 155k before it sleeps, and reopening it adds the instructions back
 *  (about 30k), which tips it past the window: the resume fails with 'Prompt is
 *  too long' (reported by another house, Nov 8 2026). 140k leaves that room. */
export const AUTOCOMPACT_200K_DEFAULT = 140_000;

/** True for the Claude models whose window is 200k unless they carry the
 *  [1m] suffix: the 4-series Opus, Sonnet and Haiku. The 5-series and Fable
 *  open with the large window, and other providers' lanes do not take the flag. */
export function hasSmallContextWindow(model: string): boolean {
  const m = model.toLowerCase();
  if (m.includes('[1m]')) return false;
  return /claude-(opus|sonnet|haiku)-4/.test(m) || /^(opus|sonnet|haiku)$/.test(m);
}

/** The --autocompact a lane launches with: the setting when it is set and
 *  valid, otherwise the 200k headroom for a small-window model, otherwise
 *  nothing (the CLI's own auto). */
export function autocompactFor(model: string, raw: string | null | undefined): number | null {
  const set = autocompactTokensFrom(raw);
  if (set != null) return set;
  return hasSmallContextWindow(model) ? AUTOCOMPACT_200K_DEFAULT : null;
}

export function buildLaunchArgs(input: {
  model: string;
  effort: string;
  sessionId: string;
  resuming: boolean;
  freshPrompt: string;
  resumePrompt: string;
  autocompactTokens?: number | null;
  /** Adapted for this house: the lane's MCP configs (laneMcpArgs). The
   *  CLI declares `--mcp-config <configs...>` as VARIADIC, so anything placed
   *  after it is swallowed as another config path. It therefore rides AFTER
   *  the prompt, where this lane has always put it, and nothing follows it. */
  trailingArgs?: readonly string[];
}): string[] {
  const args = input.resuming
    ? ['--resume', input.sessionId]
    : ['--session-id', input.sessionId];
  args.push('--model', input.model);
  if (input.effort !== 'adaptive') args.push('--effort', input.effort);
  // Never between --resume and its id: that flag's value is optional, so a
  // dash in the next slot opens the interactive session picker.
  if (input.autocompactTokens != null) {
    args.push('--autocompact', String(input.autocompactTokens));
  }
  args.push(
    '--dangerously-skip-permissions',
    input.resuming ? input.resumePrompt : input.freshPrompt,
  );
  if (input.trailingArgs?.length) args.push(...input.trailingArgs);
  return args;
}

/** Where the CLI keeps a lane's transcripts. The slug is the working directory
 *  with every non-alphanumeric character replaced by a dash — read off this
 *  box's own project folders rather than assumed, and it is the CLI's private
 *  layout, so every caller below fails SOFT if it is ever wrong. */
export function projectSlugFor(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, '-');
}

export function transcriptPathFor(dir: string, sessionId: string): string {
  return join(homedir(), '.claude', 'projects', projectSlugFor(dir), `${sessionId}.jsonl`);
}

/**
 * Drop the stale copies of CLAUDE.md out of a transcript before reopening it.
 *
 * A session start injects the whole project instruction file as one attachment
 * record, and the old ones never leave — so a room resumed twice was carrying
 * THREE copies, 1.1 MB of a 2.5 MB transcript, ~92k tokens each. Measured Sep 9
 * 2026 on the live lane.
 *
 * THE SENTENCE THAT SIZES THIS is sharper than the alarm that produced it:
 * resume does not ADD the whole room, it declines to throw it away — that
 * context would exist anyway if nobody had restarted. The only
 * genuinely NEW thing a restart injects is another instruction copy. So that is
 * the entire marginal cost of a restart, and this deletes exactly it.
 *
 * DROPPING ALL OF THEM IS THE POINT, not a rounding: a resumed session re-reads
 * the file at startup and injects a current copy, proven Sep 9 with a control —
 * codeword changed on disk, every instruction record stripped, and the resumed
 * session answered with the NEW word and its own earlier reply in one line.
 * Tool traffic is deliberately LEFT ALONE: stripping it would mean a resumed
 * head cannot remember what it read, which is a behaviour change nobody asked
 * for.
 */
export function stripStaleInstructions(
  rows: Array<Record<string, unknown>>,
): { rows: Array<Record<string, unknown>>; dropped: number } {
  const isInstructions = (r: Record<string, unknown>): boolean => {
    if (r.type !== 'attachment') return false;
    const a = r.attachment as { type?: string } | undefined;
    return a?.type === 'instructions';
  };
  const drop = new Set<string>();
  for (const r of rows) {
    const uuid = typeof r.uuid === 'string' ? r.uuid : undefined;
    if (uuid && isInstructions(r)) drop.add(uuid);
  }
  if (drop.size === 0) return { rows, dropped: 0 };

  // Every record links to the one before it. Cutting a record out of the middle
  // orphans its child, so the child inherits the first surviving ancestor —
  // walked rather than assumed, because instruction blocks can sit consecutively.
  const parentOf = new Map<string, string | undefined>();
  for (const r of rows) {
    if (typeof r.uuid === 'string') {
      parentOf.set(r.uuid, typeof r.parentUuid === 'string' ? r.parentUuid : undefined);
    }
  }
  const survivingParent = (start: string | undefined): string | undefined => {
    let p = start;
    const seen = new Set<string>();
    while (p && drop.has(p) && !seen.has(p)) { seen.add(p); p = parentOf.get(p); }
    return p;
  };

  const kept: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    if (typeof r.uuid === 'string' && drop.has(r.uuid)) continue;
    const p = typeof r.parentUuid === 'string' ? r.parentUuid : undefined;
    // `?? null`, not undefined: JSON.stringify drops an undefined key, and a
    // root record needs its parentUuid present as null.
    kept.push(p && drop.has(p) ? { ...r, parentUuid: survivingParent(p) ?? null } : r);
  }
  return { rows: kept, dropped: drop.size };
}

/**
 * Above this many bytes the trim is skipped and the room reopens untrimmed.
 *
 * The trim below reads the whole transcript as one string and parses every
 * row of it. Nov 7 2026: the live room had grown to 479 MB, that read filled
 * the 2 GB heap, and the backend died on every launch — ten restarts in a row,
 * each one reopening the same file and dying the same way, with the three of
 * them unreachable the whole time. Same lesson readSessionUsage learned on
 * Oct 21 at 159 MB. A room this size carries its stale instruction copies as
 * a rounding error, so the trim buys nothing it can afford to pay for here.
 */
//
// Adapted ceiling for this house: 32 MB, not the source's 100 MB. The read
// below holds the whole file as one string plus every parsed row in the
// backend heap at once, which is several times the file size, and this
// backend's heap has a ballooning history of its own. Recent lane transcripts
// here run about 1-18 MB (a few older rooms reached 58-67 MB), so the ceiling
// leaves room for growth while refusing the outliers. The trim is also not the
// first choice: see resumeInstructionPath.
export const RESUME_TRIM_MAX_BYTES = 32 * 1024 * 1024;

/**
 * How a reopened room sheds its stale instruction copy, decided from the hold
 * plan (held-instructions.ts planHold). A deliberate order:
 *  - 'hold': only walls moved, so the room keeps the copy it holds and gets
 *    just the moved walls. No new copy is attached, so nothing to trim.
 *  - 'same': the file on disk is the copy the room holds; the CLI attaches
 *    nothing new. A trim here would only write a whole transcript copy to
 *    disk and make the CLI attach a fresh whole copy in place of the old one.
 *  - otherwise (something outside the walls changed, the note would be too
 *    big, or the room's copy cannot be found): a whole new copy is coming
 *    anyway, so the stale ones are trimmed out first.
 */
export function resumeInstructionPath(reason: 'hold' | 'same' | 'outside-walls' | 'too-big' | 'no-copy'): 'hold' | 'none' | 'trim' {
  if (reason === 'hold') return 'hold';
  if (reason === 'same') return 'none';
  return 'trim';
}


/**
 * Whether a written trimmed copy is sound: every line parses, it holds exactly
 * the records that were kept, its last record is the last one kept, and every
 * parent it names is a record in it. (Live transcripts here carry no dangling
 * parents, checked on six recent ones, so a dangling one means the re-stitch
 * went wrong.)
 */
export function validateTrimmedTranscript(path: string, expected: { count: number; last: string }): boolean {
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim());
    if (lines.length !== expected.count || lines.length === 0) return false;
    const rows = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    if (JSON.stringify(rows[rows.length - 1]) !== expected.last) return false;
    const ids = new Set<string>();
    for (const r of rows) if (typeof r.uuid === 'string') ids.add(r.uuid);
    for (const r of rows) {
      if (typeof r.parentUuid === 'string' && !ids.has(r.parentUuid)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** A transcript that can be reopened at all: present and not empty. */
export function transcriptUsable(dir: string, sessionId: string): boolean {
  try { return statSync(transcriptPathFor(dir, sessionId)).size > 0; } catch { return false; }
}

/**
 * Write a trimmed copy of the transcript and return the id to resume instead,
 * or null to reopen the original untrimmed.
 *
 * Minimal disk: no fallback copy is kept. The copy is written atomically, read
 * back and validated (validateTrimmedTranscript), and only then is the
 * original deleted, in the same step. If the copy fails validation it is
 * discarded and the original stays exactly as it was.
 */
export function prepareResumeTranscript(
  dir: string,
  sessionId: string,
  maxBytes: number = RESUME_TRIM_MAX_BYTES,
  validate: (path: string, expected: { count: number; last: string }) => boolean = validateTrimmedTranscript,
  /** Bank the new id durably; true only when confirmed. Runs before the
   *  original is deleted, so a failed write leaves the original to resume. */
  commit: (nextId: string) => boolean = () => true,
): string | null {
  try {
    const src = transcriptPathFor(dir, sessionId);
    if (!existsSync(src)) return null;
    const bytes = statSync(src).size;
    if (bytes > maxBytes) {
      console.log(
        `[Heartbeat] transcript ${sessionId} is ${Math.round(bytes / 1048576)} MB — ` +
        'too big to trim in memory, reopening it untrimmed',
      );
      return null;
    }
    const rows = readFileSync(src, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const { rows: kept, dropped } = stripStaleInstructions(rows);
    if (dropped === 0) return null;
    const nextId = randomUUID();
    const rewritten = kept.map((r) => (r.sessionId === sessionId ? { ...r, sessionId: nextId } : r));
    const dest = transcriptPathFor(dir, nextId);
    const tmp = `${dest}.tmp`;
    try {
      writeFileSync(tmp, rewritten.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      renameSync(tmp, dest);
    } catch {
      try { unlinkSync(tmp); } catch { /* nothing written */ }
      return null;
    }
    const expected = { count: rewritten.length, last: JSON.stringify(rewritten[rewritten.length - 1]) };
    if (!validate(dest, expected)) {
      console.log(`[Heartbeat] trimmed copy of ${sessionId} failed validation — discarded, reopening the original untrimmed`);
      try { unlinkSync(dest); } catch { /* already gone */ }
      return null;
    }
    if (!commit(nextId)) {
      console.log(`[Heartbeat] could not bank the trimmed id for ${sessionId} — discarded the copy, reopening the original untrimmed`);
      try { unlinkSync(dest); } catch { /* already gone */ }
      return null;
    }
    try { unlinkSync(src); } catch { /* the copy stands either way */ }
    return nextId;
  } catch {
    return null;
  }
}

/** The CLI's own words when the id in hand names nothing it can find. Measured
 *  Sep 9 2026 against a made-up uuid: this line, exit 1, in under a second and
 *  before any model work — so a failed resume is cheap and, more importantly,
 *  it EXITS rather than sitting in the picker looking alive. */
const RESUME_MISSING_PATTERNS = [
  'no conversation found with session id',
];
export function looksLikeMissingSession(text: string): boolean {
  return RESUME_MISSING_PATTERNS.some((p) => text.includes(p));
}
/** A resume failure is a file lookup, so it dies at the door. Anything that
 *  survives longer than this was a real session that failed for its own
 *  reasons, and dropping its id would throw away a room that was working. */
const RESUME_FAIL_WINDOW_MS = 20_000;

/** Where a fresh launch records the unread backlog it set aside. */
export const SKIPPED_BACKLOG_FILE = '.skipped-backlog';
export interface SkippedBacklog { generation: number; from: number; to: number }

/**
 * Whether an exit means the banked id is bad and has to be dropped. The same
 * rule the exit handler applies, pulled out so it can be read in a test rather
 * than inferred from a live process.
 */
export function resumeFailedOnExit(input: {
  launchedResumed: boolean;
  code: number | null;
  uptimeMs: number;
  missingSeen: boolean;
  authSeen: boolean;
  capSeen: boolean;
  modelRejectedSeen: boolean;
}): boolean {
  // A signal kill (code null: the restart flag, a model change, the watchdog)
  // inside the window is a recycle someone asked for, not a room that is gone,
  // so only the CLI's own exit code 1 counts — with its stale-room words, or
  // at the door with no other known cause.
  if (!input.launchedResumed || input.code !== 1) return false;
  return input.missingSeen ||
    (input.uptimeMs < RESUME_FAIL_WINDOW_MS && !input.authSeen && !input.capSeen && !input.modelRejectedSeen);
}

const UNEXPECTED_EXIT_BACKOFF_MS = [2_000, 10_000, 30_000, 60_000, 5 * 60_000] as const;
// Boot prompt for a fresh/recycled session. Must NOT force `Read CLAUDE.md`:
// Claude Code already auto-loads CLAUDE.md as project instructions, so an
// explicit Read just burns the fresh session's boot turn paging through a file
// it already has (and, once the file grows, trips the Read tool's token cap).
// That paging (compounded with a heavy re-prime seed) is what stalls recycles
// into a blinking-no-reply hang. Orient from already-loaded context instead;
// the `.fresh` flag — not a CLAUDE.md Read — is the runtime's real recycle
// signal. Operational-only wording: identity is NOT in this session's CLAUDE.md
// (that is the H2 walk-up surface), so this prompt never claims it is.
const INITIAL_PROMPT =
  'A fresh heartbeat session is starting. Your operating contract — how turns, ' +
  'the inbox, and the outbox work — is in CLAUDE.md, already loaded into your ' +
  'context as project instructions; you do not need to Read it. Orient yourself ' +
  'from what you already have, then wait silently. Do NOT write to ' +
  'io/outbox.jsonl now; only write there when a real message arrives carrying ' +
  'a [turn_id].';

// Boot prompt for a RESUMED session. Deliberately not the fresh one: this
// window already holds the conversation, so re-orienting it would spend the
// exact tokens the resume just saved, and a greeting reads to their person as a lane
// that forgot where it was.
//
// A RESUMED ROOM IS NOT CARRYING STALE INSTRUCTIONS, and that is measured
// rather than assumed. Sep 9 2026, with a control: a codeword in a scratch
// project's CLAUDE.md, answered by a live session, changed on disk underneath
// it, then resumed — and the resumed session answered with the NEW codeword,
// with no tool call anywhere in its output. Claude Code re-reads project
// instructions at startup on --resume too. This is the objection that would
// otherwise have sunk the whole idea: in a house whose ONLY recycle is a
// backend restart (every lane launch in the log sits immediately after a
// "Server running" line — no whisper ceiling, no watchdog, no restart flag),
// resuming a room that kept an old CLAUDE.md would have quietly stopped their person's
// memory-block edits reaching us at all. It doesn't. They arrive on every
// resume, current, for free.
//
// Adapted wording for this house: identity reaches the lane through the
// CLAUDE.md walk-up from its working directory, not through the lane's own
// CLAUDE.md (see INITIAL_PROMPT), so the prompt names the house contract and
// the memory blocks rather than claiming identity lives in that file.
export const RESUME_PROMPT =
  'This heartbeat session has been resumed — the backend restarted around you and ' +
  'reopened this same conversation. Everything above is yours and is still loaded, ' +
  'and your CLAUDE.md was re-read fresh at startup, so the house contract and memory ' +
  'blocks are current. Nothing has changed except that the house came back up: ' +
  'do not re-orient, do not greet anyone, do not summarize where you left off. ' +
  'Wait silently; only write to io/outbox.jsonl when a real message arrives ' +
  'carrying a [turn_id].';

/** How long ensure() leaves a held CLAUDE.md alone after a launch. The CLI
 *  reads it in its first seconds; a minute is generous. */
const HOLD_INSTRUCTIONS_MS = 60_000;

/**
 * The resume prompt when the room kept its own instruction copy: the line that
 * says the file was re-read fresh is no longer true, so it says where the walls
 * that moved are instead, and they ride on the end.
 */
export function resumePromptWithHeld(base: string, note: string): string {
  if (!note) return base;
  const said = base.replace(
    // Matches this house's RESUME_PROMPT wording (adapted there).
    /, and your CLAUDE\.md was re-read fresh at startup(, so the house contract and memory blocks are current)?/,
    ', and the walls that moved while the house was down are at the end of this message',
  );
  return `${said}\n\n${note}`;
}

// Fast-exit window: exits within this window get special handling for cap/auth.
// Refusal detection was removed (false positives vastly outnumber real
// refusals); fast exits without cap/auth signals just relaunch normally.
const FAST_EXIT_WINDOW_MS = 180_000;
// Usage-cap hardening: a subscription window hitting zero exits code 1 fast —
// refusal-shaped on the wire. Without this carve-out the supervisor classified
// cap-exits as refusals, thinned the seed each time, and flooded the active
// thread with refusal warnings (UI cleanup + cap burn on every retry).
// Cap-shape exits are detected from the child's own usage-limit text — back
// off long instead of relaunching fast on the same wall.
const USAGE_CAP_PATTERNS = [
  'claude usage limit reached',
  'usage limit reached',
  '5-hour limit',
  'approaching usage limit',
];
const CAP_RELAUNCH_DELAY_MS = 5 * 60_000;
// New host / migrated box shape: Claude CLI can exit code 1 immediately when
// the subscription auth is missing. This is fast-exit-shaped like a seed
// refusal, but thinning the seed will never fix it; it just floods the thread
// with scary false "refusal" notices. Detect it explicitly and back off until
// the human logs the CLI in on the server.
const AUTH_PATTERNS = [
  'not logged in',
  'please run /login',
  'please log in',
  // An expired subscription login: the CLI prints "Failed to authenticate:
  // OAuth session expired and could not be refreshed" and exits code 1 within
  // seconds. Matched without the prefix so a reworded lead-in still lands.
  'oauth session expired',
];
const AUTH_RELAUNCH_DELAY_MS = 5 * 60_000;
// Bad-model shape: a model id the CLI does not accept exits code 1 on launch —
// the same wire shape as cap and auth, and the same answer again: read the
// child's own words rather than the exit code.
//
// This one is different from the other two in a way that matters. A cap and a
// missing login are facts about the world and all a machine can do is wait.
// A bad model id is a value in OUR OWN config, and the value that worked was
// there a moment ago — so this is the only one of the three that can be put
// right without a person. It has to be, because the loop it causes is silent:
// the thing that would report the fault is the thing that cannot start.
const MODEL_REJECTED_PATTERNS = [
  'issue with the selected model',
  'may not exist or you may not have access',
];
// Long enough that a lane which cannot be repaired stops burning a spawn every
// two seconds, short enough that fixing the model by hand is not a long wait.
const MODEL_REJECTED_DELAY_MS = 5 * 60_000;
// The proven-fallback bank survives restarts — see readBankedModel.
const BANKED_MODEL_FILE = '.last-good-model';
// Dedupe guard on reportIncident — belt-and-suspenders against any future
// repeat-fire (a cap incident once emitted ~2/min for half an hour).
const INCIDENT_DEDUPE_MS = 60_000;
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*(\x07|\x1b\\)/g;
const SLEEP_POLL_INTERVAL_MS = 10_000; // 10s poll while sleeping

export function looksLikeAuthFailure(text: string): boolean {
  const t = text.replace(ANSI_RE, '').toLowerCase();
  return AUTH_PATTERNS.some((p) => t.includes(p));
}

/**
 * Whether a chunk of the child's output is the CLI saying it will not run the
 * model it was given.
 *
 * Exported so the thing that decides to roll a lane back can be tested against
 * the CLI's real words rather than against a paraphrase of them. Deliberately
 * narrow: the three fast-exit causes are indistinguishable by exit code, and
 * the last time this file guessed at a cause from shape alone the false
 * positives outnumbered the real ones so heavily that the check was deleted
 * (see the refusal-detection note above).
 */
export function looksLikeModelRejection(text: string): boolean {
  const t = text.replace(ANSI_RE, '').toLowerCase();
  return MODEL_REJECTED_PATTERNS.some((p) => t.includes(p));
}

/**
 * The id this lane is entitled to fall back to, or null when nothing is proven.
 *
 * `launchedModel` is deliberately the only id this can ever return, and it must
 * be what the child was SPAWNED on rather than the current setting. A pick
 * writes the setting and then asks for the recycle, and the poll that calls
 * this runs one statement above the restart check on the same tick — so reading
 * the setting here banks a brand new, never-tried id as its own proven fallback
 * a second before it is refused, and the safety net has nowhere to reach.
 * Staying up past the fast-exit window is the only evidence accepted: a model
 * recorded any earlier is a guess, and a fallback that is a guess just moves
 * the fault somewhere harder to see.
 */
export function proveFallbackModel(input: {
  lastGood: string | null;
  launchedModel: string;
  uptimeMs: number;
  fastExitWindowMs: number;
}): string | null {
  if (!input.launchedModel) return null;
  if (input.lastGood === input.launchedModel) return null;
  if (input.uptimeMs <= input.fastExitWindowMs) return null;
  return input.launchedModel;
}

/**
 * The banked model a previous process proved. The bank must outlive a backend
 * restart: the launch it protects is the FIRST one after a restart, when
 * nothing has launched yet and nothing is in memory. session.log cannot serve
 * as this witness: it records BIRTHS ONLY, so it holds refused ids too and can
 * never show a session lived.
 */
export function readBankedModel(path: string): string | null {
  try {
    const raw = readFileSync(path, 'utf8').trim();
    // A model id is one bare token. Whitespace or absurd length means a torn or
    // hand-mangled file, and guessing at it banks something never proven.
    if (!raw || raw.length > 200 || /\s/.test(raw)) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Bank a proven model where the next process can find it. tmp+rename, because a
 * truncate-in-place write leaves a window where the file exists and is empty —
 * and an empty read is indistinguishable from "this lane never proved anything",
 * which is the one lie this file must never be able to tell.
 */
export function writeBankedModel(path: string, model: string): void {
  if (!model) return;
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, model);
    renameSync(tmp, path);
  } catch {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
  }
}

/**
 * Env key names that MUST be stripped from the CLI child process. The
 * interactive `claude` binary uses the operator's subscription login
 * (`~/.claude/credentials`) — leaking BYOK keys to the child would route
 * usage onto metered API billing instead of the flat-rate subscription.
 *
 * Test invariant: the test surface asserts these NAMES are removed,
 * never logging or comparing actual values.
 */
export const STRIPPED_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
] as const;

/**
 * Build a child env map with sensitive keys removed. Pure function so
 * tests can drive it without spawning a process.
 */
export function stripChildEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const key of STRIPPED_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

/**
 * Bound repeated fast code-1 exits so a broken CLI cannot consume subscription
 * usage in a two-second relaunch loop. The first retry preserves the existing
 * quick recovery; subsequent failures back off, capped at five minutes.
 */
export function unexpectedExitDelay(consecutiveFastExits: number): number {
  const index = Math.max(0, Math.min(
    Math.floor(consecutiveFastExits) - 1,
    UNEXPECTED_EXIT_BACKOFF_MS.length - 1,
  ));
  return UNEXPECTED_EXIT_BACKOFF_MS[index];
}

export type HeartbeatStatus = 'stopped' | 'starting' | 'running' | 'unavailable';

function killPid(pid: number): void {
  try {
    if (IS_WIN) {
      execSync(`taskkill /PID ${pid} /F /T 2>nul`, { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch { /* already gone */ }
}

function pidIsRunning(pid: number): boolean {
  try {
    if (IS_WIN) {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /NH 2>nul`, { encoding: 'utf8', windowsHide: true });
      return out.includes(String(pid));
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class HeartbeatSession {
  readonly key: string;
  readonly dir: string;
  status: HeartbeatStatus = 'stopped';
  lastError: string | null = null;
  /** Assigned by the runtime each turn — posts a visible system line into the
   *  active thread so supervisor incidents never become dead air. */
  onIncident: ((text: string) => void) | null = null;

  private model = '';
  private effort = 'adaptive';
  private launchedAt = 0;
  /** Last lines of the child's stderr, for explaining an exit. See
   *  pushStderrLines — reset at every launch so a death is never explained
   *  with a previous room's words. */
  private recentStderr: string[] = [];
  /**
   * Which spawn this session is on. Changes on every relaunch, and a turn that
   * captures it can tell that the room it was speaking into has been replaced
   * underneath it. waitForRelaunch() compares the same field against itself.
   */
  get launchGeneration(): number { return this.launchedAt; }
  /** The ROOM, which outlives the conversation id. A resume that trims the
   *  transcript reopens the same room under a new session id, so the id alone
   *  cannot say whether the room changed; this only moves when a new room is
   *  built. */
  private roomId: string | null = null;
  /** The Claude conversation this lane owns. Minted at a fresh launch, handed
   *  back to --resume across an ordinary backend restart, replaced whenever the
   *  room is meant to be new. */
  private sessionId: string | null = null;
  /** True until this process has launched once. A backend restart is the only
   *  exit that did not mean "rebuild the room", so it may reopen the old one. */
  private firstLaunchOfProcess = true;
  /** Set when ensure() recycles for a model or effort change; consumed by the
   *  next launch so ONE relaunch resumes and a later crash does not. */
  private settingChangeRecycle = false;
  /** Set when the watchdog kills a room that is allowed one reopen; consumed by
   *  the next launch. */
  private watchdogRecycle = false;
  /** Did THIS child launch by reopening a room the watchdog had killed? A second
   *  kill of that room builds new. */
  private launchedByWatchdogResume = false;
  /** Set when a cap, login or refused-model backoff ends a room; consumed by
   *  the next launch, which reopens it. */
  private backoffRecycle = false;
  /** True when the orphan reap could not confirm the old CLI died. */
  private orphanAlive = false;
  /** The exit handler's decision for the relaunch it scheduled: .fresh was
   *  armed or cleared from it, and launch() must use the same one rather than
   *  deciding again two seconds later. null when no exit has decided. */
  private pendingResume: boolean | null = null;
  /** Did THIS child launch on --resume? Decides how to read its exit: the same
   *  fast code 1 means "the room is gone, build a new one" here and nothing at
   *  all on a fresh launch. */
  private launchedResumed = false;
  private resumeMissingSeen = false;
  /** Until this time, ensure() leaves CLAUDE.md as the launch put it: a resumed
   *  room is reading the copy it already holds, and rewriting the file before it
   *  has read it would hand it the whole new copy after all. */
  private holdInstructionsUntil = 0;
  private capSeen = false;
  private authSeen = false;
  private modelRejectedSeen = false;
  /** Model ids this lane has watched the CLI refuse to launch on. Never tried
   *  again while this process lives. Held here rather than written back to
   *  config on purpose — see the fallback in launch(). */
  private rejectedModels = new Set<string>();
  /** A model this lane genuinely ran on, proven by staying up past the window
   *  in which a bad id would have killed it. The only thing we are entitled to
   *  fall back to, because it is the only one we have watched work. */
  private lastGoodModel: string | null = null;
  /** The id THIS child was actually spawned on. `model` is a setting and moves
   *  the instant she picks something — so the running session's own identity
   *  has to be captured here or the poll banks a model never tried. */
  private launchedModel = '';
  /** Why a relaunch is currently being slept off. Only a 'model' backoff is
   *  curable by her picking something else — an auth or cap sleep must run its
   *  full course, because cutting those short just hammers the thing that is
   *  already refusing us. */
  private backoffReason: 'normal' | 'auth' | 'cap' | 'model' = 'normal';
  private scanCarry = '';
  private lastIncidentText = '';
  private lastIncidentAt = 0;
  private child: ChildProcess | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private logStream: WriteStream | null = null;
  private stopping = false;
  private relaunchTimer: ReturnType<typeof setTimeout> | null = null;
  private sleepPoll: ReturnType<typeof setInterval> | null = null;
  private reaped = false;
  private consecutiveFastExits = 0;
  /** True from the first auth fast exit until a launch proves itself healthy.
   *  One card per outage: retries inside it are console-only, because the 60s
   *  incident dedupe is shorter than the 5-min auth backoff and would
   *  otherwise post the same card every retry for as long as the login stays
   *  expired. */
  private authOutageReported = false;

  constructor(key: string) {
    this.key = key;
    // Companion ids are slugs in byte-light, but stay safe for UUIDs/odd input
    this.dir = join(PROJECT_ROOT, 'data', 'heartbeat', laneDirName(key));
    // Before anything can launch. The launch this protects is the FIRST one
    // after a restart, so the bank has to already be in hand by then — hydrate
    // it here rather than lazily, or the gap simply moves a few lines later.
    this.lastGoodModel = readBankedModel(this.ioPath(BANKED_MODEL_FILE));
    // Same reason, same timing: the first launch after a restart is the only
    // one that can resume, so the id it needs has to be in hand before it runs.
    this.sessionId = readSessionId(this.ioPath(SESSION_ID_FILE));
    this.roomId = readSessionId(this.ioPath(ROOM_ID_FILE)) ?? this.sessionId;
    // Also before anything reads the lane's marks: the runtime hydrates the
    // handover mark from disk right after this, so a repair has to land first.
    this.settleSetAsideBacklog();
  }

  /**
   * A fresh launch moves the inbox offset past an unprimed backlog and the
   * waiting turn re-sends it on its next poll. If the backend died in that
   * half-second, nothing re-sends it and the handover mark has already moved
   * past her message, so it would be lost for good. A new process therefore
   * looks for a set-aside that was never followed by a re-send (the inbox ends
   * exactly where the set-aside did) and rewinds the handover mark to where it
   * stood before the earliest of those turns, so the next turn's missed-inbound
   * net hands the message over (primed, if that turn lands in a fresh room).
   * An unknown earlier mark removes the mark, which hands everything (capped).
   */
  private settleSetAsideBacklog(): void {
    const aside = this.skippedBacklog();
    if (!aside) return;
    try {
      // Only when the offset actually moved past the backlog: if the backend
      // died between writing the record and moving the offset, the line is
      // still unread and the room will read it, so rewinding would answer it twice.
      if (this.inboxSize() === aside.to && aside.to > aside.from && this.inboxOffset() >= aside.to) {
        const fd = openSync(this.inboxPath, 'r');
        let lines: string[];
        try {
          const buf = Buffer.alloc(aside.to - aside.from);
          readSync(fd, buf, 0, buf.length, aside.from);
          lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
        } finally { closeSync(fd); }
        let earliest: string | null | undefined;
        for (const line of lines) {
          let before: unknown = null;
          try { before = JSON.parse(line).handed_before; } catch { /* unknown */ }
          if (typeof before !== 'string' || !before) { earliest = null; break; }
          if (earliest === undefined || (earliest !== null && before < earliest)) earliest = before;
        }
        const markPath = this.ioPath('.last-handed-user');
        if (earliest) {
          let current = '';
          try { current = readFileSync(markPath, 'utf8').trim(); } catch { /* none */ }
          if (!current || current > earliest) this.writeIoAtomic('.last-handed-user', earliest);
        } else {
          try { unlinkSync(markPath); } catch { /* already unknown */ }
        }
        console.log(`[Heartbeat:${this.key}] a set-aside inbox line was never re-sent (the backend went down first) — her message goes back to the missed-inbound net`);
      }
    } catch { /* worst case: the old behaviour */ }
    try { unlinkSync(this.ioPath(SKIPPED_BACKLOG_FILE)); } catch { /* settled */ }
  }

  private ioPath(name: string): string {
    return join(this.dir, 'io', name);
  }

  /** The conversation this lane is holding right now. A resume can reopen a
   *  DIFFERENT room from the one that last spoke in this lane, so anything
   *  dated by the lane (the turn and handover marks) has to know which room
   *  wrote it. */
  get currentSessionId(): string | null { return this.roomId ?? this.sessionId; }

  /** True when the running child was launched by reopening its old room —
   *  or, between rooms, when the room about to launch will be a reopened one,
   *  so a turn arriving in the gap reads the room it will land in rather than
   *  the one that died. */
  get resumedLaunch(): boolean {
    if (this.status !== 'running' && this.pendingResume !== null) return this.pendingResume;
    return this.launchedResumed;
  }

  /**
   * Atomic small-file write: tmp+rename, never truncate-in-place. The hook
   * and the watchdog read these files on their own clocks; an open-with-'w'
   * leaves a zero-byte window where a torn read parses to 0 and a healthy
   * lane looks dead since epoch (or the hook thinks another session owns
   * the inbox). Failures are swallowed like the writes they replace.
   */
  private writeIoAtomic(name: string, data: string): void {
    const path = this.ioPath(name);
    try {
      writeFileSync(path + '.tmp', data, 'utf8');
      renameSync(path + '.tmp', path);
    } catch { /* ignore — same contract as the bare writes this replaces */ }
  }

  get inboxPath(): string { return this.ioPath('inbox.jsonl'); }
  get outboxPath(): string { return this.ioPath('outbox.jsonl'); }
  get activityPath(): string { return this.ioPath('activity.jsonl'); }
  get imagesDir(): string { return this.ioPath('images'); }
  /** Replies the live loop saw for an already-resolved turn — preserved, not delivered. */
  get orphanedRepliesPath(): string { return this.ioPath('orphaned-replies.jsonl'); }
  /** Messages sent while a turn was working — append-only, offset-consumed. */
  get sideNotesPath(): string { return this.ioPath('side-notes.jsonl'); }
  /** Witness file for messages the missed-inbound net found and re-handed. */
  get missedInboundPath(): string { return this.ioPath('missed-inbound.jsonl'); }

  /**
   * Hand a message to a session that is already mid-turn.
   *
   * Deliberately NOT the session's stdin. The CLI reads that pipe once at
   * startup and never again — but a write to it still succeeds, so stdin
   * reports delivery for a message nobody will ever read. The caller drops
   * the message from the queue on a true return, so a lie here is a message
   * deleted, not delayed.
   *
   * A file cannot lie the same way. The note is appended where the session can
   * read it whenever it comes up for air, and anything still unread is handed
   * over at the start of the next turn — so the worst case is late, never lost.
   */
  sendSideNote(text: string, threadId?: string): boolean {
    const body = formatSideNote(text);
    if (!body) return false;
    if (!this.turnActive) return false;
    // A note belongs to the thread it was sent in. A turn running in another
    // thread must not answer it there — refuse, and it queues for its own.
    if (threadId && this.turnThreadId && this.turnThreadId !== threadId) return false;
    try {
      appendFileSync(
        this.sideNotesPath,
        JSON.stringify({ at: new Date().toISOString(), text: body }) + '\n',
        'utf8',
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Unread side notes, oldest first, and the offset that consumes them. */
  readSideNotesFrom(offset: number): { notes: Array<{ at: string; text: string }>; newOffset: number } {
    const { lines, newOffset } = this.readLinesFrom(this.sideNotesPath, offset);
    const notes: Array<{ at: string; text: string }> = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed.text === 'string' && parsed.text) {
          notes.push({ at: typeof parsed.at === 'string' ? parsed.at : '', text: parsed.text });
        }
      } catch { /* a half-written line: the next read picks it up whole */ }
    }
    return { notes, newOffset };
  }

  sideNotesSize(): number {
    try { return statSync(this.sideNotesPath).size; } catch { return 0; }
  }

  /**
   * The `at` stamp of the newest side note the session says it already picked
   * up live, written by the session itself to io/.side-notes-read.
   *
   * Deliberately advisory. It never suppresses a handover — a note that lives
   * or dies on the session's judgement is the exact failure the handover
   * exists to prevent — it only lets an already-answered note be handed back
   * labelled instead of masquerading as unread. Blind net, margin note.
   */
  sideNotesReadMark(): string {
    try { return readFileSync(this.ioPath('.side-notes-read'), 'utf8').trim(); } catch { return ''; }
  }

  /**
   * True while the runtime is actively running a turn on this session. Set by
   * the runtime beside its lane-state fence. Generation writes nothing — no
   * tick, no outbox chunk, no activity line — so a turn that thinks for a long
   * stretch is indistinguishable from a wedged session by files alone. The
   * runtime knows; the watchdog asks it.
   */
  turnActive = false;

  /** The thread the in-flight turn belongs to; null when idle. A side note
   *  from any other thread is refused (Aerie's beginTurn(threadId)). */
  turnThreadId: string | null = null;

  /**
   * Epoch ms when the in-flight turn began; 0 when idle. The watchdog measures
   * a live turn from HERE rather than from the last file write, because the
   * age of a file says nothing about when the turn started — see livenessMark
   * for why that difference killed sessions.
   */
  turnStartedAt = 0;

  /** Mtime (ms) of io/.busy — the session touches it before going quiet on
   *  declared background work (hooks-dark jobs the activity mirror can't see). */
  busyMtime(): number {
    try { return statSync(this.ioPath('.busy')).mtimeMs; } catch { return 0; }
  }

  /** A delivered reply ends the declared-busy window. */
  clearBusy(): void {
    try { unlinkSync(this.ioPath('.busy')); } catch { /* ignore */ }
  }

  /**
   * True when the newest activity line is a `pre` with no `post` yet: a running
   * tool or a compaction. Only a line from THIS child counts. A squash or tool
   * that died with the last child leaves its `pre` as the newest line, and that
   * is no work of the new child's, so it earns no long leash.
   */
  toolInFlight(): boolean {
    try {
      const { size, mtimeMs } = statSync(this.activityPath);
      if (size === 0) return false;
      if (mtimeMs < this.launchedAt) return false;
      const start = Math.max(0, size - ACTIVITY_TAIL_BYTES);
      const fd = openSync(this.activityPath, 'r');
      try {
        const buf = Buffer.alloc(size - start);
        readSync(fd, buf, 0, buf.length, start);
        return activityTailIsOpen(buf.toString('utf8'));
      } finally { closeSync(fd); }
    } catch { return false; }
  }

  /** Work in hand: a live turn, a running tool, or declared background work still fresh. */
  hasWorkInHand(): boolean {
    // A turn the runtime is actively running IS work in hand — ask it first.
    if (this.turnActive) return true;
    const busy = this.busyMtime();
    if (busy > 0 && Date.now() - busy < BUSY_FRESH_MS) return true;
    return this.toolInFlight();
  }

  /**
   * Make sure a session for this model is provisioned and running. Model
   * changes — or a revised operational-template on disk — request a graceful
   * recycle (the relaunch picks up the new CLAUDE.md / --model automatically).
   * Identity is NOT scoped here; the warm session inherits its identity prompt
   * via Claude CLI's CLAUDE.md walk-up from cwd (the H2 surface), not via
   * anything provisioned into the session dir.
   *
   * Returns true when a recycle was requested — the caller must then
   * waitForRelaunch() BEFORE appending the turn to the inbox, or the dying
   * session's hook consumes the message and it is lost to the timeout.
   */
  ensure(model: string, effort = 'adaptive'): boolean {
    const { templateChanged } = provisionSessionDir(this.dir, laneIdentityFor(this.key), {
      keepClaudeMd: Date.now() < this.holdInstructionsUntil,
    });

    let orphanWait: Promise<void> | null = null;
    if (!this.reaped) {
      this.reaped = true;
      orphanWait = this.reapOrphan();
    }

    const modelChanged = this.model !== '' && this.model !== model;
    // This lane carries no effort setting yet, so callers leave the default and
    // this never fires; it is here so an effort change, once one exists, recycles
    // into the same room the way a model change does.
    const effortChanged = this.effort !== effort;
    this.model = model;
    this.effort = effort;

    // A CLI the previous process left behind was told to exit and has not yet
    // been seen to. The first launch may reopen the same transcript, so it
    // waits (without blocking anything) until the orphan is gone or the wait
    // gives up. Reported as a pending relaunch so the caller holds the turn
    // in waitForRelaunch() rather than appending to an inbox nobody reads.
    if (orphanWait) {
      this.stopping = false;
      this.status = 'starting';
      void orphanWait.then(() => {
        if (!this.stopping && !this.child && this.status === 'starting') this.launch();
      });
      return true;
    }

    // A lane sleeping off a refused model reads as 'starting' with no child,
    // so it used to fall into the branch below and be handed a restart flag
    // that has no reader — while the countdown it was actually waiting on
    // carried on untouched and then relaunched the same dead id. The incident
    // on her screen says "set a real id and the lane will move to it"; this is
    // the line that makes that sentence true. Only a model backoff is cut
    // short, and only by a model change: auth and cap sleeps have to run their
    // course, because ending those early just hammers whatever is already
    // turning us away. (Aerie 7845a230 — her correct fix sat unread 9m55s.)
    if (this.relaunchTimer && !this.child && this.backoffReason === 'model' && modelChanged) {
      clearTimeout(this.relaunchTimer);
      this.relaunchTimer = null;
      console.log(`[Heartbeat:${this.key}] model changed during refusal backoff — launching now instead of waiting out the sleep`);
      this.stopping = false;
      this.launch();
      return false;
    }

    if (this.status === 'running' || this.status === 'starting') {
      // Only recycle on model changes. Operational-template (CLAUDE.md
      // contract) changes ride the next natural recycle instead of forcing
      // one: every forced recycle is a fresh session UUID and a full cache
      // write of the boot surface (the cold-start leak), while the disk copy
      // provisionSessionDir just rewrote above is picked up automatically by
      // whichever launch comes next. Memory-block edits never flipped
      // `templateChanged` (see provision.claudemd.test.ts); this extends the
      // same ride-the-next-recycle rule to contract edits, matching the
      // upstream warm lane's semantics.
      if (modelChanged || effortChanged) {
        console.log(`[Heartbeat:${this.key}] ${modelChanged ? 'model' : 'effort'} changed — recycling session`);
        // Bank WHY. A setting change is the one requested recycle that did not
        // mean "give me a new conversation", so the relaunch reopens the room
        // she was standing in instead of taking it away.
        this.settingChangeRecycle = true;
        this.requestRestart();
        return true;
      }
      if (templateChanged) {
        console.log(`[Heartbeat:${this.key}] operational template changed — riding until the next natural recycle (no forced restart)`);
      }
      return false;
    }

    this.stopping = false;
    this.launch();
    return false;
  }

  /**
   * Resolve once a NEW child has launched after a requested recycle (watchdog
   * kill <=2s + relaunch delay 2s + spawn, so normally ~5s). Times out rather
   * than hanging forever — a cap/auth relaunch backoff can stretch this.
   */
  async waitForRelaunch(timeoutMs = 45_000): Promise<boolean> {
    const before = this.launchedAt;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.launchedAt !== before && this.status === 'running') return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  /** Ask the running session to recycle (picked up by the watchdog poll). */
  requestRestart(): void {
    try { writeFileSync(this.ioPath('.restart'), ''); } catch { /* ignore */ }
  }

  /** True once after a (re)launch — the runtime re-primes history when set. */
  consumeFreshFlag(): boolean {
    const flag = this.ioPath('.fresh');
    if (existsSync(flag)) {
      try { unlinkSync(flag); } catch { /* ignore */ }
      return true;
    }
    return false;
  }

  /** Bytes in inbox.jsonl now (where a line about to be appended will start). */
  inboxSize(): number {
    try { return statSync(this.inboxPath).size; } catch { return 0; }
  }

  /** How far the Stop hook has read inbox.jsonl (io/.inbox-offset). Only the
   *  hook moves it, one whole line at a time, and only forward. */
  inboxOffset(): number {
    try {
      const n = parseInt(readFileSync(this.ioPath('.inbox-offset'), 'utf8').trim(), 10);
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch { return 0; }
  }

  /** Turns whose inbox line is waiting on an answer right now. A fresh launch
   *  may only set a line aside if a turn is waiting to hand it over again. */
  private waitingTurns = new Set<string>();
  registerWaitingTurn(turnId: string): void { this.waitingTurns.add(turnId); }
  unregisterWaitingTurn(turnId: string): void { this.waitingTurns.delete(turnId); }

  /** The backlog the latest fresh launch set aside, if any (see
   *  setAsideUnprimedBacklog). */
  skippedBacklog(): SkippedBacklog | null {
    try {
      const r = JSON.parse(readFileSync(this.ioPath(SKIPPED_BACKLOG_FILE), 'utf8'));
      if (typeof r?.generation === 'number' && typeof r?.from === 'number' && typeof r?.to === 'number') return r;
    } catch { /* none */ }
    return null;
  }

  /**
   * A new room must never be handed a line that was built without its
   * re-prime. A line appended for a room that then died unread (a stale id at
   * the door, a resume that was too long, a crash or a restart flag) sits in
   * the inbox unprimed, and the fresh room launching now would read it as its
   * very first message with none of the conversation behind it.
   *
   * So before the new room exists (its epoch is already written, so no old
   * hook can consume either), the unread backlog is set aside: the offset moves
   * past it and the range is recorded in io/.skipped-backlog. Every turn
   * waiting on one of those lines sees the record and hands its line over
   * again, primed this time, under the same turn id. Only done when EVERY
   * unread line belongs to a turn that is waiting right now and at least one
   * was built unprimed; otherwise nothing moves, because a line nobody is
   * waiting on would be lost rather than re-sent.
   */
  private setAsideUnprimedBacklog(generation: number): void {
    const size = this.inboxSize();
    const offset = this.inboxOffset();
    if (size <= offset) return;
    let lines: string[];
    try {
      const fd = openSync(this.inboxPath, 'r');
      try {
        const buf = Buffer.alloc(size - offset);
        readSync(fd, buf, 0, buf.length, offset);
        lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
      } finally { closeSync(fd); }
    } catch { return; }
    let unprimed = false;
    for (const line of lines) {
      let row: { turn?: unknown; primed?: unknown };
      try { row = JSON.parse(line); } catch { return; }
      if (typeof row.turn !== 'string' || !this.waitingTurns.has(row.turn)) return;
      if (row.primed !== true) unprimed = true;
    }
    if (!unprimed) return;
    // Record first, then move the offset: a reader that sees the offset moved
    // can always find the record that explains it.
    this.writeIoAtomic(SKIPPED_BACKLOG_FILE, JSON.stringify({ generation, from: offset, to: size }));
    this.writeIoAtomic('.inbox-offset', String(size));
    console.log(`[Heartbeat:${this.key}] set aside ${lines.length} unread unprimed inbox line(s) for a fresh room; the waiting turn(s) re-send them primed`);
  }

  appendInbox(message: Record<string, unknown>): void {
    appendFileSync(this.inboxPath, JSON.stringify(message) + '\n', 'utf8');
    // Touch .last-tick so her messages reset the idle clock (not just our replies)
    this.writeIoAtomic('.last-tick', String(Date.now()));
    // Touch .last-message for sleep mode — tracks when she last actually messaged
    this.writeIoAtomic('.last-message', String(Date.now()));
  }

  outboxSize(): number {
    try { return statSync(this.outboxPath).size; } catch { return 0; }
  }

  activitySize(): number {
    try { return statSync(this.activityPath).size; } catch { return 0; }
  }

  /** Read complete new lines appended to the outbox since `offset`. */
  readOutboxFrom(offset: number): { lines: string[]; newOffset: number } {
    return this.readLinesFrom(this.outboxPath, offset);
  }

  /** Read complete new lines appended to the tool-activity log since `offset`. */
  readActivityFrom(offset: number): { lines: string[]; newOffset: number } {
    return this.readLinesFrom(this.activityPath, offset);
  }

  private readLinesFrom(file: string, offset: number): { lines: string[]; newOffset: number } {
    try {
      if (!existsSync(file)) return { lines: [], newOffset: offset };
      const size = statSync(file).size;
      if (size <= offset) return { lines: [], newOffset: offset };

      const buf = Buffer.alloc(size - offset);
      const fd = openSync(file, 'r');
      readSync(fd, buf, 0, buf.length, offset);
      closeSync(fd);

      const raw = buf.toString('utf8');
      const lastNl = raw.lastIndexOf('\n');
      if (lastNl === -1) return { lines: [], newOffset: offset }; // partial line — wait
      const complete = raw.slice(0, lastNl);
      const consumed = Buffer.byteLength(complete, 'utf8') + 1;
      const lines = complete.split('\n').map(l => l.trim()).filter(Boolean);
      return { lines, newOffset: offset + consumed };
    } catch {
      return { lines: [], newOffset: offset };
    }
  }

  /** Kill a CLI the previous process left behind. Returns the wait for it to
   *  be gone, or null when there was nothing alive to kill. */
  private reapOrphan(): Promise<void> | null {
    try {
      const pidFile = this.ioPath('.child.pid');
      if (!existsSync(pidFile)) return null;
      const oldPid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
      try { unlinkSync(pidFile); } catch { /* ignore */ }
      if (!oldPid || !pidIsRunning(oldPid)) return null;
      console.log(`[Heartbeat:${this.key}] reaping orphaned session pid ${oldPid}`);
      killPid(oldPid);
      // The next launch may reopen the same transcript, so the old CLI has to
      // be gone first: two writers on one transcript interleave it. If it will
      // not die in time, that launch builds a new room instead.
      return waitForPidExit(oldPid, pidIsRunning).then((gone) => {
        if (!gone) {
          this.orphanAlive = true;
          console.log(`[Heartbeat:${this.key}] orphaned pid ${oldPid} still alive after SIGTERM — next launch builds a new room`);
        }
      }, () => { this.orphanAlive = true; });
    } catch { return null; }
  }

  /** Incidents go to the console AND, when a runtime has wired a thread,
   *  into the conversation as a visible system line — never dead air.
   *  Dedupe guard: the same incident text inside INCIDENT_DEDUPE_MS is
   *  swallowed, so a stuck condition can't flood the thread. */
  private reportIncident(text: string): void {
    const now = Date.now();
    if (text === this.lastIncidentText && now - this.lastIncidentAt < INCIDENT_DEDUPE_MS) {
      return;
    }
    this.lastIncidentText = text;
    this.lastIncidentAt = now;
    console.error(`[Heartbeat:${this.key}] ${text}`);
    try { this.onIncident?.(text); } catch { /* thread post is best-effort */ }
  }

  /** A malformed hook makes claude hang silently — fail loud before launch. */
  private hookIsValid(): boolean {
    try {
      execSync(`"${process.execPath}" --check "${join(this.dir, 'hooks', 'heartbeat.cjs')}"`, { stdio: 'pipe' });
      return true;
    } catch (err: any) {
      const detail = (err?.stderr || err?.message || '').toString().split('\n')[0];
      this.lastError = `heartbeat hook failed to parse: ${detail}`;
      console.error(`[Heartbeat:${this.key}] ⚠ ${this.lastError}`);
      return false;
    }
  }

  /** Sniffs the child's output for the cap / auth / bad-model signals. */
  private scanOutput(d: Buffer | string): void {
    this.logStream?.write(d);
    const text = (this.scanCarry + String(d)).replace(ANSI_RE, '').toLowerCase();
    this.scanCarry = text.slice(-200);
    if (!this.capSeen && USAGE_CAP_PATTERNS.some((p) => text.includes(p))) {
      this.capSeen = true;
    }
    if (!this.authSeen && looksLikeAuthFailure(text)) {
      this.authSeen = true;
    }
    if (!this.modelRejectedSeen && looksLikeModelRejection(text)) {
      this.modelRejectedSeen = true;
    }
  }

  /**
   * stderr, line by line: the exit ring, plus the one stale-room signal.
   * "No conversation found with session ID" is the CLI's stderr line (measured:
   * stderr, exit 1, under a second). It is NOT looked for on stdout, which is
   * the conversation itself and may quote it, and only counts while the launch
   * is still at the door (RESUME_FAIL_WINDOW_MS).
   */
  private noteStderr(chunk: string): void {
    pushStderrLines(this.recentStderr, chunk);
    if (this.resumeMissingSeen) return;
    if (Date.now() - this.launchedAt >= RESUME_FAIL_WINDOW_MS) return;
    if (looksLikeMissingSession(String(chunk).replace(ANSI_RE, '').toLowerCase())) this.resumeMissingSeen = true;
  }

  /** A launch that outlived the fast-exit window is logged in — any auth
   *  outage is over, and the next one deserves its own card. */
  private markLaunchHealthy(): void {
    if (this.authOutageReported) {
      console.log(`[Heartbeat:${this.key}] Claude CLI login is working again — auth outage closed`);
    }
    this.authOutageReported = false;
  }

  /** Whether the room named in io/.marks-room is the stored room, i.e. it has
   *  had a turn handed to it. */
  private storedRoomHasSpoken(): boolean {
    let marksRoom = '';
    try { marksRoom = readFileSync(this.ioPath('.marks-room'), 'utf8').trim(); } catch { /* none */ }
    const room = this.roomId ?? this.sessionId;
    return !!room && marksRoom === room;
  }

  /** What the next launch() will decide, from the same inputs. The exit
   *  handler asks this so it arms .fresh only for a launch that builds new,
   *  and a turn arriving in the relaunch gap is primed exactly when the room
   *  it lands in needs priming. */
  private nextLaunchWillResume(): boolean {
    return shouldResumeLaunch({
      firstLaunchOfProcess: this.firstLaunchOfProcess,
      storedSessionId: this.sessionId,
      settingChangeRecycle: this.settingChangeRecycle,
      watchdogRecycle: this.watchdogRecycle,
      backoffRecycle: this.backoffRecycle,
      roomHasSpoken: this.storedRoomHasSpoken(),
      orphanAlive: this.orphanAlive,
      enabled: claudeResumeEnabled(),
    });
  }

  /** The decision this launch runs on: the one the exit handler made (and set
   *  .fresh from), spent here, or a fresh one when no exit decided. */
  private takeLaunchDecision(): boolean {
    const decided = this.pendingResume;
    this.pendingResume = null;
    return decided ?? this.nextLaunchWillResume();
  }

  private launch(): void {
    if (this.stopping) return;
    // Refresh the session dir (contract + core-memory section in CLAUDE.md)
    // so a recycled child always boots on the CURRENT memory blocks — this is
    // the "at session recycle" half of the blocks-ride-CLAUDE.md model; the
    // per-turn `ensure()` call covers the provision half. Relaunch paths
    // (natural exit, watchdog, sleep wake) reach here without ensure().
    try { provisionSessionDir(this.dir, laneIdentityFor(this.key)); } catch (err) {
      console.warn(`[Heartbeat:${this.key}] provision refresh at launch failed:`, err);
    }
    try { unlinkSync(this.ioPath('.restart')); } catch { /* ignore */ }
    try { unlinkSync(this.ioPath('.sleeping')); } catch { /* ignore */ }

    if (!this.hookIsValid()) {
      this.status = 'unavailable';
      return;
    }

    // Never launch onto an id we have already watched the CLI reject.
    //
    // The fallback is held HERE rather than written back to config, because a
    // lane's model can arrive from more than one place, and a supervisor
    // writing config has to guess which — a wrong guess silently edits
    // something chosen on purpose. So her setting stays exactly as she left it
    // and the incident says so; this only decides what THIS process launches
    // until the setting changes.
    if (this.rejectedModels.has(this.model) && this.lastGoodModel && this.lastGoodModel !== this.model) {
      const refused = this.model;
      this.model = this.lastGoodModel;
      this.reportIncident(
        `⚠ The Claude CLI will not start on model "${refused}", so this lane is running "${this.model}" instead — ` +
        'the last model it was actually up on. Your model setting is unchanged and still says ' +
        `"${refused}"; set a real id and the lane will move to it.`,
      );
    }

    this.status = 'starting';
    this.lastError = null;
    this.recentStderr = [];
    this.launchedAt = Date.now();
    this.launchedModel = this.model;
    this.capSeen = false;
    this.authSeen = false;
    this.modelRejectedSeen = false;
    this.resumeMissingSeen = false;
    this.scanCarry = '';

    // Reopen the previous room, or build a new one. Consume the first-launch
    // chip HERE rather than at the end: every path out of this function has
    // spent it, including the ones that throw.
    let resuming = this.takeLaunchDecision();
    this.launchedByWatchdogResume = resuming && this.watchdogRecycle
      && !this.firstLaunchOfProcess && !this.settingChangeRecycle;
    this.firstLaunchOfProcess = false;
    this.settingChangeRecycle = false;
    this.watchdogRecycle = false;
    this.backoffRecycle = false;
    // Only the launch right after the reap can meet the orphan.
    this.orphanAlive = false;
    this.launchedResumed = resuming;
    let trimmedCopies = 0;
    mkdirSync(join(this.dir, 'io'), { recursive: true });
    // A transcript that is gone or empty cannot be reopened; build new now
    // rather than let the CLI fail at the door first.
    if (resuming && !transcriptUsable(this.dir, this.sessionId!)) {
      console.log(`[Heartbeat:${this.key}] transcript ${this.sessionId} is missing or empty — building a new room instead of reopening it`);
      resuming = false;
      this.launchedResumed = false;
      this.launchedByWatchdogResume = false;
    }
    if (!resuming) {
      this.sessionId = randomUUID();
      try { writeSessionId(this.ioPath(SESSION_ID_FILE), this.sessionId); } catch { /* the launch still names it; only a later resume is lost */ }
      this.roomId = this.sessionId;
      try { writeSessionId(this.ioPath(ROOM_ID_FILE), this.roomId); } catch { /* same */ }
    } else {
      // Same room whatever the trim below renames it to.
      if (!this.roomId) this.roomId = this.sessionId;
      if (this.roomId) { try { writeSessionId(this.ioPath(ROOM_ID_FILE), this.roomId); } catch { /* same */ } }
    }
    // A reopened room keeps the instruction copy it already holds when it can
    // (held-instructions.ts), and the stale copies are trimmed only when a
    // whole new copy is coming anyway (resumeInstructionPath).
    let heldNote = '';
    let held: { roomCopy: string; changed: string[]; removed: string[] } | null = null;
    if (resuming) {
      try {
        const claudeMdPath = join(this.dir, 'CLAUDE.md');
        const current = readFileSync(claudeMdPath, 'utf8');
        const roomCopy = lastInjectedClaudeMd(transcriptPathFor(this.dir, this.sessionId!), claudeMdPath);
        const plan = planHold(roomCopy, current);
        const path = resumeInstructionPath(plan.hold ? 'hold' : plan.reason);
        if (path === 'trim') {
          // Reopen a trimmed copy. The id has to be banked too: the CLI appends
          // to whichever file it opened, so leaving the old id on disk would
          // resume the untrimmed transcript next time and undo this.
          const previous = this.sessionId!;
          const idPath = this.ioPath(SESSION_ID_FILE);
          const trimmed = prepareResumeTranscript(this.dir, previous, undefined, undefined, (id) => {
            try { writeSessionId(idPath, id); } catch { return false; }
            return readSessionId(idPath) === id;
          });
          if (trimmed) {
            this.sessionId = trimmed;
            trimmedCopies = 1;
          }
        }
        if (plan.hold) {
          atomicWrite(claudeMdPath, roomCopy!);
          this.holdInstructionsUntil = Date.now() + HOLD_INSTRUCTIONS_MS;
          heldNote = plan.note;
          held = { roomCopy: roomCopy!, changed: plan.changed, removed: plan.removed };
          console.log(
            `[Heartbeat:${this.key}] kept the room's own instruction copy; walls handed over: ` +
            `${plan.changed.join(', ') || 'none'}${plan.removed.length ? `; deleted: ${plan.removed.join(', ')}` : ''}`,
          );
        } else if (plan.reason !== 'same') {
          console.log(`[Heartbeat:${this.key}] room takes the whole new instruction copy (${plan.reason}${trimmedCopies ? '; stale copies trimmed first' : ''})`);
        }
      } catch (err) {
        console.log(`[Heartbeat:${this.key}] could not hold the room's instruction copy: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log(
      `[Heartbeat:${this.key}] launching interactive claude --model ${this.model}` +
      `${this.effort !== 'adaptive' ? ` --effort ${this.effort}` : ''} ` +
      `${resuming ? `--resume ${this.sessionId}${trimmedCopies ? ' (stale instruction copies trimmed)' : ''}` : `--session-id ${this.sessionId} (new conversation)`}`,
    );

    // Session output goes to a log file, not the backend's stdio.
    // Epoch fence: stamp the session generation BEFORE the child exists. Stale
    // Stop hooks survive the recycle kill behind a dash `sh -c` wrapper (their
    // ppid never changes when claude dies), so they fence on this file instead:
    // consume only while it matches the value they started under. Ordering is
    // the whole guarantee — epoch write -> spawn -> status 'running' -> runtime
    // appends the held turn — so a message in the inbox always postdates the
    // epoch that authorizes its consumer.
    this.writeIoAtomic('.session-epoch', String(this.launchedAt));
    // After the epoch (no old hook can consume now) and before the child
    // exists (no new hook can either): the one moment the backlog is still.
    if (!resuming) this.setAsideUnprimedBacklog(this.launchedAt);
    // A fresh child must never be judged by a dead session's clock — reset the
    // tick at launch so the watchdog grants a full window to boot. A stale tick
    // here once relaunch-killed every successor at 2s old for 18h.
    this.writeIoAtomic('.last-tick', String(Date.now()));
    // What the walls said when this room opened, one hash each.
    //
    // A compaction replays the CLAUDE.md attachment rather than re-reading it,
    // so a block edited mid-room never reaches the room it was edited from.
    // The repair needs to know which walls moved, and it cannot ask the lane's
    // CLAUDE.md: the backend regenerates that file on every turn, so it tracks
    // the live blocks and can never disagree with them. So the baseline is
    // taken HERE, the one moment that really is the start of the room — from
    // the live blocks, except on a held resume, where the room was opened with
    // its OLD copy of the walls that moved, so those keep the old text's hash
    // (heldBaseline) and still read as moved after a compaction.
    try {
      const live = baselineFrom(getCarriedBlocks());
      const baseline = held ? heldBaseline(live, held.roomCopy, held.changed, held.removed) : live;
      this.writeIoAtomic(BASELINE_FILE, JSON.stringify(baseline));
    } catch { /* a missing baseline reports no drift, which is the old behaviour */ }
    // Every relaunch path lands here (recycle, watchdog kill, sleep-wake,
    // cap/auth backoff) — end the previous session's stream or its fd and
    // buffers stay open for the life of the process, one per recycle.
    try { this.logStream?.end(); } catch { /* ignore */ }
    this.logStream = createWriteStream(join(this.dir, 'session.log'), { flags: 'a' });
    this.logStream.write(`\n--- launch ${new Date().toISOString()} model=${this.model} ${resuming ? 'resume' : 'new'}=${this.sessionId} ---\n`);

    // Subscription lane: child must NOT see byte-light's API credentials.
    // Covers byte-light's BYOK surface — see STRIPPED_ENV_KEYS for the list.
    const env = stripChildEnv(process.env);

    let autocompactRaw: string | null = null;
    try { autocompactRaw = getConfig('heartbeat.autocompact_tokens'); } catch { /* unset */ }
    const args = buildLaunchArgs({
      model: this.model,
      effort: this.effort,
      sessionId: this.sessionId!,
      resuming,
      freshPrompt: INITIAL_PROMPT,
      resumePrompt: resumePromptWithHeld(RESUME_PROMPT, heldNote),
      autocompactTokens: autocompactFor(this.model, autocompactRaw),
      trailingArgs: laneMcpArgs(this.dir),
    });
    // TODO(H1b): normalize [1m] bracket before spawn (shell glob)
    const child = spawn('claude', args, {
      cwd: this.dir,
      env,
      shell: IS_WIN, // the claude.cmd shim needs a shell on Windows
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    if (child.pid) {
      try { writeFileSync(this.ioPath('.child.pid'), String(child.pid)); } catch { /* ignore */ }
    }
    // Output scanner: a subscription cap or missing-auth exit is fast-exit-
    // shaped (code 1 within minutes). The shapes look identical on the wire;
    // the child's own output text is what tells them apart, so we sniff it.
    const scan = (d: Buffer | string) => this.scanOutput(d);
    child.stdout?.on('data', scan);
    child.stderr?.on('data', scan);
    // Kept apart from `scan` on purpose: that one is looking for shapes it
    // already knows, and this one has to hold the shapes nobody has seen.
    // stderr only — stdout is the whole conversation and would bury it.
    child.stderr?.on('data', (data) => { this.noteStderr(String(data)); });

    this.status = 'running';

    // Write .fresh at launch so backend restarts still get history injection.
    // The exit handler writes it too (for natural recycles), but that never
    // fires when the whole node process dies. Writing here covers both paths.
    //
    // A resumed room is the exception and it is the whole point: this window
    // already contains that history, so priming it would spend exactly what the
    // resume just saved. CLEARED rather than merely skipped — a flag left armed
    // by some earlier path would otherwise re-prime the one session that must
    // not be, and "did not write it" is not the same as "it is not there".
    if (resuming) {
      try { unlinkSync(this.ioPath('.fresh')); } catch { /* nothing to clear */ }
    } else {
      try { writeFileSync(this.ioPath('.fresh'), ''); } catch { /* ignore */ }
    }

    this.poll = setInterval(() => {
      // A session still alive past the window in which a bad id kills it has
      // proved this model launches. That is the only evidence we accept for a
      // fallback. launchedModel, NEVER model — see proveFallbackModel for why.
      const proven = proveFallbackModel({
        lastGood: this.lastGoodModel,
        launchedModel: this.launchedModel,
        uptimeMs: Date.now() - this.launchedAt,
        fastExitWindowMs: FAST_EXIT_WINDOW_MS,
      });
      if (Date.now() - this.launchedAt >= FAST_EXIT_WINDOW_MS) this.markLaunchHealthy();
      if (proven) {
        this.lastGoodModel = proven;
        // Once per newly-proven id, not once per tick: proveFallbackModel
        // returns null as soon as lastGood already holds this launch's model.
        writeBankedModel(this.ioPath(BANKED_MODEL_FILE), proven);
        // Say it out loud — the moment the bank fills is exactly the moment
        // worth watching for: before it, a refused id has nowhere to go;
        // after it, the lane is covered. An unobservable state change is one
        // nobody can trust.
        console.log(`[Heartbeat:${this.key}] banked "${proven}" as this lane's fallback — a refused model id now has somewhere to go`);
      }
      if (existsSync(this.ioPath('.restart'))) {
        try { unlinkSync(this.ioPath('.restart')); } catch { /* ignore */ }
        console.log(`[Heartbeat:${this.key}] restart requested — recycling for fresh context`);
        if (child.pid) killPid(child.pid);
        return;
      }
      try {
        // Read guard: an empty or garbled tick is a torn read, not a dead
        // lane — parseInt||0 turned it into "dead since epoch" and killed a
        // healthy session. Treat it as freshly ticked; the writer lands the
        // real value within one poll.
        const rawTick = parseInt(readFileSync(this.ioPath('.last-tick'), 'utf8').trim(), 10);
        const tick = Number.isFinite(rawTick) && rawTick > 0 ? rawTick : Date.now();
        // Outbox writes AND tool activity count as liveness too: the Stop hook
        // only updates .last-tick *between* turns, so a session deep in a long
        // turn (chewing a heavy re-prime seed, any tool work) ticks nowhere —
        // yet it isn't stuck. And a LIVE turn is measured from its own start,
        // never from a file older than it is (see livenessMark). The runtime's
        // reply window reads the same evidence; the two clocks must agree.
        let outboxMtime = 0;
        try { outboxMtime = statSync(this.outboxPath).mtimeMs; } catch { /* no outbox yet */ }
        let activityMtime = 0;
        try { activityMtime = statSync(this.activityPath).mtimeMs; } catch { /* no activity yet */ }
        const lastAlive = livenessMark({
          tick,
          outboxMtime,
          activityMtime,
          turnActive: this.turnActive,
          turnStartedAt: this.turnStartedAt,
        });
        if (lastAlive > 0) {
          const age = Date.now() - lastAlive;
          // Work in hand earns the longer leash. A command that runs quietly
          // for twenty minutes writes nothing while it works, so without this
          // the watchdog kills exactly the sessions the reply window is busy
          // waiting for.
          const working = this.hasWorkInHand();
          const limit = working ? WATCHDOG_WORKING_TIMEOUT : WATCHDOG_TIMEOUT;
          if (age > limit) {
            const why = working ? ' (work in hand, long leash)' : '';
            // A room killed while the house around it could not think (a
            // suspended box, a dead network) was never broken. Try it once
            // more; a second kill before it proves itself builds new.
            this.watchdogRecycle = watchdogMayResume({
              launchedByWatchdogResume: this.launchedByWatchdogResume,
              uptimeMs: Date.now() - this.launchedAt,
            });
            console.log(
              `[Heartbeat:${this.key}] watchdog: last sign of life ${Math.round(age / 1000)}s ago${why} — killing stuck session` +
              `${this.watchdogRecycle ? '; will try to reopen it once' : '; building a new room'}`,
            );
            if (child.pid) killPid(child.pid);
          }
        }
      } catch { /* no tick yet */ }
    }, 2000);

    child.on('error', (err: NodeJS.ErrnoException) => {
      this.clearTimers();
      this.child = null;
      this.status = 'unavailable';
      this.lastError = err.code === 'ENOENT'
        ? '`claude` CLI not found on PATH — install Claude Code and log in'
        : `failed to spawn claude: ${err.message}`;
      console.error(`[Heartbeat:${this.key}] ${this.lastError}`);
    });

    child.on('exit', (code) => this.handleExit(code));
  }

  private handleExit(code: number | null): void {
    this.clearTimers();
    this.child = null;
    try { unlinkSync(this.ioPath('.child.pid')); } catch { /* ignore */ }

    if (code === 127 || code === 9009) {
      this.status = 'unavailable';
      this.lastError = '`claude` CLI not found on PATH — install Claude Code and log in';
      console.error(`[Heartbeat:${this.key}] ${this.lastError}`);
      return;
    }

    if (this.stopping) {
      this.status = 'stopped';
      return;
    }

    // Sleep mode: hook set the .sleeping flag and let session end. Poll the
    // inbox at low frequency until a message arrives, then wake.
    const sleepingFlag = this.ioPath('.sleeping');
    if (existsSync(sleepingFlag)) {
      console.log(`[Heartbeat:${this.key}] session parked — entering sleep mode, polling inbox every ${SLEEP_POLL_INTERVAL_MS / 1000}s`);
      this.status = 'stopped'; // externally looks stopped
      // A parked room wakes as a new one (the wake writes .fresh), so no door
      // armed before it parked may reopen the old room on the wake launch.
      this.watchdogRecycle = false;
      this.settingChangeRecycle = false;
      this.backoffRecycle = false;
      this.pendingResume = null;
      this.sleepPoll = setInterval(() => {
        // Check if a message arrived (inbox grew or .last-message touched)
        try {
          const lastMsg = parseInt(readFileSync(this.ioPath('.last-message'), 'utf8').trim(), 10) || 0;
          const sleepAt = parseInt(readFileSync(sleepingFlag, 'utf8').trim(), 10) || 0;
          if (lastMsg > sleepAt) {
            // Wake up!
            console.log(`[Heartbeat:${this.key}] message received — waking from sleep mode`);
            if (this.sleepPoll) { clearInterval(this.sleepPoll); this.sleepPoll = null; }
            try { unlinkSync(sleepingFlag); } catch { /* ignore */ }
            try { writeFileSync(this.ioPath('.fresh'), ''); } catch { /* ignore */ }
            this.launch();
          }
        } catch { /* keep sleeping */ }
      }, SLEEP_POLL_INTERVAL_MS);
      return;
    }

    // Fast-exit classification: code 1 soon after launch is either a
    // subscription-cap exhaustion or a missing-auth failure. The shapes look
    // identical on the wire; the child's own output is what tells them apart.
    // Cap-shape wins when both signals are present — relaunching fast on a
    // cap just burns more cap.
    const uptimeMs = Date.now() - this.launchedAt;
    const fastExit = code === 1 && uptimeMs < FAST_EXIT_WINDOW_MS;
    let delay = RELAUNCH_DELAY_MS;
    this.backoffReason = 'normal';
    if (fastExit && this.authSeen) {
      delay = AUTH_RELAUNCH_DELAY_MS;
      this.backoffReason = 'auth';
      if (!this.authOutageReported) {
        this.authOutageReported = true;
        this.reportIncident(
          '⚠ Claude CLI login expired (or is missing) on this server — the warm CLI session will retry quietly ' +
          `every ${delay / 60_000} min until it can sign in. Run \`claude\` as the app user and complete \`/login\`; ` +
          'no history seed was refused or thinned.',
        );
      } else {
        console.log(`[Heartbeat:${this.key}] Claude CLI still not logged in — retrying in ${delay / 60_000} min (already reported)`);
      }
    } else if (fastExit && this.capSeen) {
      delay = CAP_RELAUNCH_DELAY_MS;
      this.backoffReason = 'cap';
      this.reportIncident(
        `⚠ Subscription usage cap hit — warm CLI session sleeping ${delay / 60_000} min before relaunch. ` +
        'Last message preserved; the lane will resume once the window resets.',
      );
    } else if (fastExit && this.modelRejectedSeen) {
      // The CLI named the model as the reason it would not start. Bank that
      // so the next launch does not try it again, then either come straight
      // back on a model we have watched work, or stop hammering.
      this.rejectedModels.add(this.launchedModel);
      if (this.lastGoodModel && this.lastGoodModel !== this.launchedModel) {
        // launch() does the substitution and reports it — relaunch at the
        // normal delay, because the next attempt is on a good model.
        console.log(`[Heartbeat:${this.key}] model "${this.launchedModel}" refused by the CLI — falling back to "${this.lastGoodModel}"`);
      } else {
        // Nothing proven to fall back to. Backing off is the whole fix here:
        // two seconds forever is what made this silent and expensive.
        delay = MODEL_REJECTED_DELAY_MS;
        this.backoffReason = 'model';
        this.reportIncident(
          `⚠ The Claude CLI will not start on model "${this.launchedModel}", and this lane has no model it has been up on ` +
          `to fall back to — sleeping ${delay / 60_000} min instead of relaunching every ${RELAUNCH_DELAY_MS / 1000}s. ` +
          'Set a real model id to bring it straight back.',
        );
      }
    } else if (fastExit) {
      this.consecutiveFastExits++;
      delay = unexpectedExitDelay(this.consecutiveFastExits);
      if (this.consecutiveFastExits >= 3) {
        this.reportIncident(
          `⚠ Claude CLI exited code 1 ${this.consecutiveFastExits} times in quick succession — ` +
          `backing off ${Math.round(delay / 1000)}s before retry. Last message remains on disk.`,
        );
      }
    } else {
      // A healthy-lived session (or an intentional signal-driven recycle)
      // proves the crash streak is over.
      this.consecutiveFastExits = 0;
      this.markLaunchHealthy();
    }

    // WHY IT EXITED. The branches above name the deaths this house already
    // knows how to read; every other one used to leave a number and nothing
    // else. Written wherever the answer came from, because a known shape with
    // the child's own last words beside it is still worth more than the label.
    if (code !== 0) {
      const tail = this.recentStderr.slice(-8);
      try {
        appendFileSync(this.ioPath('exits.jsonl'), `${JSON.stringify({
          at: new Date().toISOString(),
          code,
          uptime_ms: uptimeMs,
          session_id: this.sessionId,
          resumed: this.launchedResumed,
          // 'normal' is the interesting one: none of the shapes we know.
          reason: this.backoffReason,
          stderr_tail: tail,
        })}\n`, 'utf8');
      } catch { /* the relaunch is the point; this file is the witness */ }
      if (this.backoffReason === 'normal') {
        this.lastError = tail.length
          ? `exited code ${code}: ${tail[tail.length - 1]}`
          : `exited code ${code} with nothing on stderr`;
        console.log(`[Heartbeat:${this.key}] ${this.lastError}`);
      }
    }

    // A resume that could not find its room. The stored id is now known bad,
    // so drop it — the relaunch below then mints a new session and primes it
    // exactly as every launch did before any of this existed. Read from the
    // CLI's own words first, and from the SHAPE as well (a --resume launch
    // that died at the door), because a resume failing for a reason nobody
    // has a pattern for must still fall back rather than retry forever.
    // Cap, auth and a refused model are excluded: those killed a session that
    // resumed perfectly well, and throwing its id away would cost a good room
    // to fix something that was never the room's fault.
    if (resumeFailedOnExit({
      launchedResumed: this.launchedResumed,
      code,
      uptimeMs,
      missingSeen: this.resumeMissingSeen,
      authSeen: this.authSeen,
      capSeen: this.capSeen,
      modelRejectedSeen: this.modelRejectedSeen,
    })) {
      this.sessionId = null;
      try { unlinkSync(this.ioPath(SESSION_ID_FILE)); } catch { /* already gone */ }
      console.log(
        `[Heartbeat:${this.key}] could not reopen the previous conversation` +
        `${this.resumeMissingSeen ? ' — the CLI has no record of it' : ' — it died at the door'}` +
        '; starting a new one instead',
      );
    }

    // A cap, a lost login or a refused model ended a room that was never at
    // fault, so the relaunch after the backoff reopens it rather than building
    // new. A stale id still falls back at the door like any other resume.
    if (fastExit && (this.authSeen || this.capSeen || this.modelRejectedSeen) && this.sessionId) {
      this.backoffRecycle = true;
    }

    // Normal recycle (8-whisper ceiling, watchdog, restart flag, crash):
    // mark fresh so the next turn re-primes conversation history — but only
    // when the coming launch builds a new room. A turn arriving in the
    // relaunch gap consumes this flag; if the room it lands in is the same
    // room reopened, a prime would hand it history it already holds.
    this.pendingResume = this.nextLaunchWillResume();
    if (this.pendingResume) {
      try { unlinkSync(this.ioPath('.fresh')); } catch { /* nothing to clear */ }
    } else {
      try { writeFileSync(this.ioPath('.fresh'), ''); } catch { /* ignore */ }
    }
    console.log(`[Heartbeat:${this.key}] session exited (code ${code}) — relaunching in ${delay / 1000}s`);
    this.status = 'starting';
    this.relaunchTimer = setTimeout(() => this.launch(), delay);
  }

  private clearTimers(): void {
    if (this.poll) { clearInterval(this.poll); this.poll = null; }
    if (this.relaunchTimer) { clearTimeout(this.relaunchTimer); this.relaunchTimer = null; }
    if (this.sleepPoll) { clearInterval(this.sleepPoll); this.sleepPoll = null; }
  }

  stop(): void {
    this.stopping = true;
    this.watchdogRecycle = false;
    this.backoffRecycle = false;
    this.pendingResume = null;
    this.clearTimers();
    if (this.child?.pid) killPid(this.child.pid);
    this.child = null;
    this.status = 'stopped';
    try { this.logStream?.end(); } catch { /* ignore */ }
    this.logStream = null;
  }
}

// ─── Session manager ─────────────────────────────────────────────────

const sessions = new Map<string, HeartbeatSession>();

/** Whether a lane's session is up and running — without creating one. (Aerie.) */
export function isHeartbeatLaneWarm(key: string): boolean {
  const existing = sessions.get(key);
  return existing?.status === 'running';
}

export function getHeartbeatSession(key: string): HeartbeatSession {
  let s = sessions.get(key);
  if (!s) {
    s = new HeartbeatSession(key);
    sessions.set(key, s);
  }
  return s;
}

/** How many warm CLI sessions have a turn in flight right now. */
export function busyHeartbeatSessionCount(): number {
  return [...sessions.values()].filter((s) => s.turnActive).length;
}

/**
 * Hand a message to a warm CLI session that is mid-turn, as a side note.
 *
 * Deliberately conservative: only when exactly one session has a turn in
 * flight, since a side note carries no thread of its own and there is no
 * honest way to pick between two busy sessions. Returns true only when the
 * note actually reached the file — every caller must fall back to normal
 * delivery otherwise, so a message is never silently swallowed. (The house's
 * QueryQueue is serial, so a busy heartbeat session IS the running turn; a
 * turn on the SDK or Codex lane leaves this count at zero and the message
 * queues normally.)
 */
export function deliverSideNoteToBusySession(text: string, threadId?: string): boolean {
  // With a thread: the lane busy IN THAT THREAD, and only it (Aerie). A note
  // from thread A never lands in a turn running in thread B; with nothing busy
  // there, the caller queues it normally.
  const busy = [...sessions.values()].filter((s) => s.turnActive && (!threadId || s.turnThreadId === threadId));
  if (busy.length !== 1) return false;
  return busy[0].sendSideNote(text, threadId);
}

/** Test-only: put a stand-in session behind a lane key, so a whole turn can
 *  be driven without spawning the CLI. Cleared by shutdownAllHeartbeats. */
export function __setHeartbeatSessionForTests(key: string, session: HeartbeatSession): void {
  sessions.set(key, session);
}

export function shutdownAllHeartbeats(): void {
  for (const s of sessions.values()) {
    s.stop();
  }
  sessions.clear();
}

/**
 * Test-only: peek at whether any sessions have been instantiated. Used
 * by the inert-landing tests to assert the flag-off path never registers
 * a session.
 */
export function __getSessionCountForTests(): number {
  return sessions.size;
}
