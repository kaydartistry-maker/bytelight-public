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
import { join } from 'path';
import { PROJECT_ROOT } from '../../config.js';
import { neuralisMcpArgs, provisionSessionDir } from './provision.js';
import { BUSY_FRESH_MS } from './constants.js';
import { laneDirName } from './lane-dir.js';
import { baselineFrom, BASELINE_FILE } from './block-drift.js';
import { getAllBlocks } from '../memory-blocks.js';

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
  private launchedAt = 0;
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
  }

  private ioPath(name: string): string {
    return join(this.dir, 'io', name);
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
  ensure(model: string): boolean {
    const { templateChanged } = provisionSessionDir(this.dir, laneIdentityFor(this.key));

    if (!this.reaped) {
      this.reaped = true;
      this.reapOrphan();
    }

    const modelChanged = this.model !== '' && this.model !== model;
    this.model = model;

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
      if (modelChanged) {
        console.log(`[Heartbeat:${this.key}] model changed — recycling session`);
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

  private reapOrphan(): void {
    try {
      const pidFile = this.ioPath('.child.pid');
      if (!existsSync(pidFile)) return;
      const oldPid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
      if (oldPid && pidIsRunning(oldPid)) {
        console.log(`[Heartbeat:${this.key}] reaping orphaned session pid ${oldPid}`);
        killPid(oldPid);
      }
      unlinkSync(pidFile);
    } catch { /* ignore */ }
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

  /** A launch that outlived the fast-exit window is logged in — any auth
   *  outage is over, and the next one deserves its own card. */
  private markLaunchHealthy(): void {
    if (this.authOutageReported) {
      console.log(`[Heartbeat:${this.key}] Claude CLI login is working again — auth outage closed`);
    }
    this.authOutageReported = false;
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
    this.launchedAt = Date.now();
    this.launchedModel = this.model;
    this.capSeen = false;
    this.authSeen = false;
    this.modelRejectedSeen = false;
    this.scanCarry = '';
    console.log(`[Heartbeat:${this.key}] launching interactive claude --model ${this.model}`);

    // Session output goes to a log file, not the backend's stdio.
    mkdirSync(join(this.dir, 'io'), { recursive: true });
    // Epoch fence: stamp the session generation BEFORE the child exists. Stale
    // Stop hooks survive the recycle kill behind a dash `sh -c` wrapper (their
    // ppid never changes when claude dies), so they fence on this file instead:
    // consume only while it matches the value they started under. Ordering is
    // the whole guarantee — epoch write -> spawn -> status 'running' -> runtime
    // appends the held turn — so a message in the inbox always postdates the
    // epoch that authorizes its consumer.
    this.writeIoAtomic('.session-epoch', String(this.launchedAt));
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
    // taken HERE, the one moment that really is the start of the room.
    try {
      this.writeIoAtomic(BASELINE_FILE, JSON.stringify(baselineFrom(getAllBlocks())));
    } catch { /* a missing baseline reports no drift, which is the old behaviour */ }
    // Every relaunch path lands here (recycle, watchdog kill, sleep-wake,
    // cap/auth backoff) — end the previous session's stream or its fd and
    // buffers stay open for the life of the process, one per recycle.
    try { this.logStream?.end(); } catch { /* ignore */ }
    this.logStream = createWriteStream(join(this.dir, 'session.log'), { flags: 'a' });
    this.logStream.write(`\n--- launch ${new Date().toISOString()} model=${this.model} ---\n`);

    // Subscription lane: child must NOT see byte-light's API credentials.
    // Covers byte-light's BYOK surface — see STRIPPED_ENV_KEYS for the list.
    const env = stripChildEnv(process.env);

    const args = ['--model', this.model, '--dangerously-skip-permissions', INITIAL_PROMPT, ...neuralisMcpArgs(this.dir)];
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

    this.status = 'running';

    // Write .fresh at launch so backend restarts still get history injection.
    // The exit handler writes it too (for natural recycles), but that never
    // fires when the whole node process dies. Writing here covers both paths.
    try { writeFileSync(this.ioPath('.fresh'), ''); } catch { /* ignore */ }

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
            console.log(`[Heartbeat:${this.key}] watchdog: last sign of life ${Math.round(age / 1000)}s ago${why} — killing stuck session`);
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

    // Normal recycle (8-whisper ceiling, watchdog, restart flag, crash):
    // mark fresh so the next turn re-primes conversation history.
    try { writeFileSync(this.ioPath('.fresh'), ''); } catch { /* ignore */ }
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
