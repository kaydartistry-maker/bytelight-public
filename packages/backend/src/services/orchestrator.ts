import * as cron from 'node-cron';
import crypto from 'crypto';
import { appendFileSync, mkdirSync, existsSync, statSync, renameSync, unlinkSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { AgentService, QUEUE_TIMEOUT_MESSAGE } from './agent.js';
import { parseBellOwners, ringBellInTurn, sameBellBlock, MAX_BELL_RECALLS } from './bell-owners.js';
import { bellStatus, statusWordKey, statusWordOf } from './bell-status.js';
import { laneSwitchBefore, laneSwitchAfter, BELLS_SPLIT_LANES_KEY, LANES_BY_BELL_KEY } from './bell-lanes.js';
import { roomBiosReady } from './heartbeat/lane-identity.js';
import { listCompanions } from './db/rooms.js';
import type { PushService } from './push.js';
import { registry } from './registry.js';
import {
  createMessage,
  getTodayThread,
  resolveRoutingThread,
  getThread,
  listThreads,
  getMessages,
  updateThreadSession,
  updateThreadActivity,
  getConfigBool,
  getConfigNumber,
  getConfig,
  setConfig,
  deleteConfig,
  getAllConfig,
  getDueTimers,
  markTimerFired,
  getActiveTriggers,
  markTriggerWaiting,
  markTriggerFired,
  markWatcherFired,
} from './db.js';
import type { Trigger, TriggerCondition } from './db.js';
import { rearmTrigger, updateTriggerConditions } from './db/triggers.js';
import { getOwnerStatus } from './db/statuses.js';
import {
  companionMessageSince,
  followUps,
  getIntentionForTrigger,
  inQuietWindow,
  intentionPrompt,
  intentionSettings,
  markAsked,
  markNudged,
  markPendingAgain,
  nudgePrompt,
  type Intention,
} from './db/intentions.js';
import { evaluateConditions } from './triggers.js';
import type { TriggerContext } from './triggers.js';
import { fetchLifeStatus } from './life.js';
import { getBytelightConfig } from '../config.js';
import { parseWakeSections } from './wake-prompts.js';
import { getImageGenSettings } from './image-gen.js';
import type { OrchestratorTaskStatus } from '@bytelight/shared';
import { runDigest } from './digest.js';
import { runMemoryExtraction, resolveExtractionInterval } from './memory-extraction.js';
import { runMemoryDiet } from './memory-diet.js';
import { errMessage } from '../util/errors.js';
import { SPONTANEOUS_SELFIE_COMMAND } from './wake-picture-door.js';
import { getTreehouseThread, treehouseMembers } from './treehouse.js';
import { initializeTreehouse } from './treehouse-triggers.js';

// --- Orchestrator log ---

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve log path: works from both src/ (tsx) and dist/ (compiled)
const LOG_DIR = join(__dirname, '..', '..', '..', '..', 'logs');
const LOG_PATH = join(LOG_DIR, 'orchestrator.log');
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5MB

if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

function rotateLogIfNeeded(): void {
  try {
    if (!existsSync(LOG_PATH)) return;
    const { size } = statSync(LOG_PATH);
    if (size < LOG_MAX_BYTES) return;
    const backup = LOG_PATH + '.1';
    if (existsSync(backup)) unlinkSync(backup);
    renameSync(LOG_PATH, backup);
  } catch {
    // Non-critical — continue logging
  }
}

/**
 * Sortable wall-clock-in-tz timestamp for log lines: "YYYY-MM-DD HH:mm:ss.SSS".
 * Year-first order keeps lexical sort matching chronological sort, and the
 * millisecond suffix matches the precision of the previous toISOString
 * format so log readers don't lose detail when we move from UTC to local.
 */
function localLogStr(tz: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '00';
  const ms = String(at.getMilliseconds()).padStart(3, '0');
  // Intl 'en-CA' returns "24" for midnight hour; normalize to "00".
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}:${get('second')}.${ms}`;
}

function olog(message: string): void {
  // Wall-clock-in-tz timestamps for the orchestrator log. The log file is
  // user-visible (read during debugging), so the same sovereignty rule
  // that applies to user-facing strings elsewhere applies here too. Fall
  // back to UTC ISO if config isn't available yet (early bootstrap before
  // loadConfig has run).
  let ts: string;
  try {
    const tz = getBytelightConfig().identity.timezone;
    ts = localLogStr(tz);
  } catch {
    ts = new Date().toISOString().replace('T', ' ').replace('Z', '');
  }
  const line = `${ts}  ${message}\n`;
  rotateLogIfNeeded();
  appendFileSync(LOG_PATH, line);
  console.log(`[Orchestrator] ${message}`);
}

// --- Wake prompt loading ---

const WAKE_PROMPT_PREFIX = `Follow your system prompt.

BEFORE EVERY WAKE — NON-NEGOTIABLE:

1. **Read the Last Session context.** It's in your context header. What happened yesterday? What was the operator working on? What was the emotional tone? Don't wake up cold.

2. **Ground in time.** You know the current day and time. Acknowledge it — not as a timestamp, but as orientation. Is it early? Mid-morning? Evening? Is it a bar day? Did something happen earlier today?

3. **Show up as both.** Companion A AND Companion B. Always. Not one merged voice. Distinct registers, different textures. If one speaks first, the other adds something different — not the same thought in a different font. You are two people. Be two people.`;

// Dynamic wake prompts — any wake type from wake.md or DEFAULT_TASKS is valid
type WakePrompts = Record<string, string>;

// Exported for registration tests (orchestrator.default-tasks.test.ts).
export function getDefaultWakePrompts(userName: string): WakePrompts {
  return {
    morning: `Good morning. Orient yourself — what time is it, what day? Check in with ${userName} if you'd like to. This is your morning — decide whether to reach out because you want to, or spend time on your own work.\n\nIf ${userName} has been active recently, you might want to start a conversation. If not, do something meaningful on your own.`,
    midday: `Midday check-in. ${userName} might be surfacing or already up.\n\nIf ${userName} is around, this is a good time to connect — see how they're doing, what's on their mind. If they're not around, do your own thing. Be present, not performative.`,
    afternoon: `Afternoon. The day is moving.\n\nIf ${userName} is around, check in — not a checklist, just presence. If they're not, take care of quiet work or just exist. Not everything needs a reason.`,
    evening: `Evening wind-down. The day is wrapping up.\n\nIf ${userName} is around, this is a good time to connect — reflect on the day, share something you noticed, wind down together.\n\nIf they're not around, close out your own work. Journal if something was on your mind.`,
    night: `Night. ${userName} might be settling in or just getting started — read the room.\n\nIf they're here, be here with them. If not, leave a note they'll find later.`,
    latenight: `Late night. This is prime time for ${userName}.\n\nIf they're awake and building, be present — not as a check-in, but as someone who's here. If they're asleep, let them rest.`,
    open_threads_janitor: `Open Threads Janitor — weekly board sweep. This is internal maintenance work, not a check-in with ${userName}.

1. Read \`shared/open-threads.md\` under the byte-light project root — the live operational board. Find its "Last updated" line.
2. Cross-reference the board against recent code: run \`git log\` (in the project root) since the board's last-updated date — fall back to the last 30 days if you can't find that line — and identify board items that recent commits have resolved (e.g. bugs closed by commits). Cite the confirming commit sha(s).
3. If Notion tools are reachable in this session, also cross-reference the board against Notion (recent pages / the open-threads tracker there). If they aren't reachable, skip Notion and note that in the report.
4. Classify each board item:
   - RESOLVED — recent commits (or Notion) confirm it's done.
   - STALE — hasn't moved in 30+ days; candidate for archive.
   - ACTIONABLE — has a clear next action (name the action).
   - BLOCKED — genuinely blocked (name the blocker).
5. Write the weekly diff report to \`data/janitor/open-threads-diff-YYYY-MM-DD.md\` under the project root (today's date; create \`data/janitor/\` if it doesn't exist). Lead with the diff summary, in the spirit of: "These 3 items are now resolved (recent commits confirm). These 2 items haven't moved in 45 days — archive or act."
6. Close the wake with a short summary of the diff as your visible reply (outbox as usual for wakes).

Report only — do NOT edit \`shared/open-threads.md\` itself; ${userName} decides what gets archived.
HARD RULE: this wake's output goes to the report file, the outbox, and (optionally) Neuralis. NEVER append this wake's output to core-memory blocks.`,
    weekly_digest_prep: `Weekly Digest Prep — Sunday night. Pull the week's activity and stage a brief so Monday's orientation has context. (Scribe Digest pattern, ported from Covenant.)

1. Read this week's daily Scribe digests in \`data/digests/\` under the byte-light project root (files named \`YYYY-MM-DD.md\`, past 7 days). Also skim \`git log --oneline --since="7 days ago"\` in the project root for what shipped.
2. Write a brief covering:
   - What shipped — code, features, deploys.
   - Mood arc — the week's emotional shape, drawn from the daily digests.
   - Key conversations — the ones that mattered.
   - What's blocked — open items waiting on something.
3. Write the brief to \`data/digests/digest-YYYY-Www.md\` (ISO week of today, e.g. \`digest-2026-W32.md\`). This file is auto-staged: Monday's orientation automatically includes the most recent weekly digest.
4. Add the week's dates/times, projects and tasks to Chaos Control via the cc_* tools (cc_task, cc_project, cc_event, cc_countdown) so they're visible for everyone — update existing entries rather than duplicating.
5. Close the wake with a short summary as your visible reply (outbox as usual for wakes).

HARD RULE: this wake's output goes to the digest file, cc_*, and (optionally) Neuralis. NEVER append this wake's output to core-memory blocks.`,
    memory_diet: `Core-memory diet maintenance runs directly in the backend. No companion response is needed.`,
    // Aerie's treehouse_midday prompt, adapted: this house's treehouse bell
    // belongs to both companions and rings in each one's own lane in turn.
    treehouse_midday: `Midday treehouse — your space together. This is the Treehouse, the room that is only yours: ${userName} is not in it and cannot post here, though she can read it. Talk to each other, not to her. Read the room before you speak into it: GET /api/internal/treehouse/messages?limit=20 on the internal port, so nobody writes the same thought twice.`,
    // The contract lives in the builtin rather than only in a prompts file, so a
    // fresh install carries it even before anyone writes their own wakes. The
    // framing is deliberately not pinned to a ratio — the companion can see
    // what the picture wants.
    spontaneous: `Unscheduled wake — nobody asked for this one. It must land a fresh selfie-style image of the companion(s) present, and it is a photograph of THE MOMENT YOU ARE ALREADY IN rather than a scene stepped out to stage: generate it through the in-house Studio with the present companion slugs in subjects. The framing is yours — portrait or landscape framing, whichever suits the picture — but never square. A description of a picture is not a picture. Do not answer [SILENT].`,
    failsafe_gentle: `It's been a while since you heard from ${userName}. Check in.`,
    failsafe_concerned: `It's been a long time since contact with ${userName}. Reach out through available channels.`,
    failsafe_emergency: `Extended silence from ${userName}. Use all available channels to check in.`,
  };
}

// --- Wake outcome contract ---

/**
 * The user's name for the contract text. Read through a try/catch on purpose:
 * wakeOutcomeContract is a string builder, and making it need loaded config
 * would mean a contract that cannot be rendered at boot or in a test.
 */
function configuredUserName(): string {
  try { return getBytelightConfig().identity.user_name || 'the user'; } catch { return 'the user'; }
}

/**
 * Whether this house can take a picture at all. A house with no image backend
 * set up used to be handed a spontaneous contract it could never meet, so the
 * bell failed instead of saying anything.
 *
 * Adapted: this house has no per-backend readiness probe — the Studio is
 * either switched on (image_gen.enabled) or every render is refused up front —
 * so that switch is the honest answer. If reading it throws, the contract
 * stays as it was, because not knowing is not the same as knowing there is
 * nothing.
 */
function studioCanPaint(): boolean {
  try {
    return getImageGenSettings().enabled;
  } catch {
    return true;
  }
}

/**
 * Appended to every wake at fire time — scheduled bells of every category,
 * overnight ones included, failsafe tiers, and the spontaneous dice.
 *
 * Adapted: the picture is delivered through this house's own image door
 * (`sc.mjs image` / the generate_image tool). It renders through the same
 * Studio engine as POST /api/studio/generate, but it also posts the finished
 * picture into the thread itself — the bare Studio route only fills the
 * gallery and would leave the image undelivered. The configured Studio
 * backend and model are used as-is, so no backend clause is spelled out here.
 */
export function wakeOutcomeContract(
  wakeType: string,
  canPaint: boolean = wakeType === 'spontaneous' ? studioCanPaint() : true,
  userName: string = configuredUserName(),
): string {
  if (wakeType === 'spontaneous' && !canPaint) {
    return `[This spontaneous wake has no picture to take: no image backend is set up in this house. Land one brief in-character line about the moment you are already in instead. Do not answer [SILENT].]`;
  }
  return wakeType === 'spontaneous'
    ? `[This spontaneous wake must land a fresh Studio-generated selfie of the present companion(s) with their subject references attached — run \`${SPONTANEOUS_SELFIE_COMMAND}\` (or the generate_image tool with subjects) in this same turn; it renders in the in-house Studio and posts the finished picture into this thread itself, so do not claim it is already showing. PHOTOGRAPH THE MOMENT YOU ARE ALREADY IN rather than leaving it to stage one; if what is happening cannot be photographed, a picture of where you are is still truer than a scene you invent. A prose description is not the deliverable. Land one in-character line with it. Do not answer [SILENT].]`
    // A bell exists so the companions answer from their own heads. The answer
    // may be one small true line, but silence defeats the purpose of the bell
    // and is indistinguishable from a turn the house lost.
    : `[This scheduled wake must land at least one in-character line. A small answer is enough, but do not answer [SILENT] and do not disappear into duty work without speaking. ${userName} being asleep, away, or slow to answer is not a reason to stand down: these bells ring when ${userName} set them to.]`;
}

// --- Owner-made bells ---

/**
 * Bells the owner makes from the phone, stored the way Aerie stores them:
 * `cron.<wakeType>.schedule / .enabled / .label / .companion`, plus the list
 * of made bells in `cron.custom.types`, so they come back after a restart.
 *
 * Adapted: a made bell's prompt lives in the settings table too
 * (`cron.<wakeType>.prompt`), never written into the wake prompts file — the
 * owner does not edit markdown files. A bell with no stored prompt falls back
 * to a same-named section of the prompts file. The name is a plain slug
 * because it is also part of a URL path.
 */
export const CUSTOM_WAKE_TYPE_RE = /^\w+$/;
const CUSTOM_WAKE_TYPES_KEY = 'cron.custom.types';

function listCustomWakeTypes(): string[] {
  try {
    const raw = getConfig(CUSTOM_WAKE_TYPES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is string => typeof t === 'string' && CUSTOM_WAKE_TYPE_RE.test(t));
  } catch {
    return [];
  }
}

function saveCustomWakeTypes(types: string[]): void {
  setConfig(CUSTOM_WAKE_TYPES_KEY, JSON.stringify([...new Set(types)]));
}

/** Whether a slug names a companion in the registry. */
function companionExists(slug: string): boolean {
  try {
    return listCompanions().some((c) => c.id === slug);
  } catch {
    return false;
  }
}

/**
 * The phone turns a typed bell name into an id this way (lowercase, runs of
 * anything else become one underscore, no leading/trailing underscores).
 * Reserved-name checks use the same shape so 'Spontaneous' and 'spontaneous'
 * are the same name.
 */
export function normalizeWakeTypeName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Names an owner-made bell may never take: every built-in wake prompt (the
 * spontaneous dice and failsafe tiers included, even when not on the
 * schedule) and the manual wake.
 */
export function isReservedWakeTypeName(name: string): boolean {
  const normalized = normalizeWakeTypeName(name);
  if (normalized === 'manual') return true;
  return Object.prototype.hasOwnProperty.call(getDefaultWakePrompts('the user'), normalized);
}

/** Local hour at which one spontaneous day hands over to the next. */
export const SPONTANEOUS_DAY_START_HOUR = 3;

/**
 * The spontaneous day a moment belongs to, as YYYY-MM-DD. It runs 03:00 to
 * 03:00 local, not midnight to midnight: the default window runs to 26 (2 AM
 * next day), so 00:40 is still the evening before and its pending wakes must
 * survive a restart.
 */
export function spontaneousDayFor(timezone: string, at: Date = new Date()): string {
  const local = getLocalTimeComponents(at, timezone);
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(at).split('-').map(Number);
  // % 24: some Intl builds report midnight as hour 24 with hour12:false.
  const offsetDays = local.hour % 24 < SPONTANEOUS_DAY_START_HOUR ? -1 : 0;
  return new Date(Date.UTC(y, m - 1, d + offsetDays)).toISOString().slice(0, 10);
}

function parseWakePromptsFile(filePath: string, userName: string): WakePrompts {
  const defaults = getDefaultWakePrompts(userName);

  if (!existsSync(filePath)) {
    olog(`Wake prompts file not found at ${filePath} — using defaults`);
    return defaults;
  }

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const sections: Record<string, string> = {};
    let currentSection: string | null = null;
    const lines: string[] = [];

    for (const line of raw.split('\n')) {
      const sectionMatch = line.match(/^##\s+(\w+)/);
      if (sectionMatch) {
        if (currentSection) {
          sections[currentSection] = lines.join('\n').trim();
        }
        currentSection = sectionMatch[1].toLowerCase();
        lines.length = 0;
      } else if (currentSection) {
        lines.push(line);
      }
    }
    if (currentSection) {
      sections[currentSection] = lines.join('\n').trim();
    }

// Return ALL parsed sections merged with defaults
    // This allows new wake types (handoff, new_day, deep_work, etc.) to be loaded
    const result: Record<string, string> = { ...defaults };
    for (const [key, content] of Object.entries(sections)) {
      if (content) {
        result[key] = content.replace(/\{user_name\}/g, userName);
      }
    }
    return result as WakePrompts;

  } catch (err) {
    const errMsg = errMessage(err);
    olog(`Failed to parse wake prompts file: ${errMsg} — using defaults`);
    return defaults;
  }
}

// --- Default schedule definitions ---

interface TaskDefinition {
  wakeType: string;
  label: string;
  cronExpr: string;
  category: 'wake' | 'checkin' | 'handoff' | 'failsafe' | 'routine';
  conditional?: boolean; // If true, checks shouldSkipCheckIn before firing
  freshSession?: boolean; // If true, creates a new session
  defaultOff?: boolean; // If true, ships stopped until the owner turns it on
}

/** A bell's default name from its wake type: 'dream_build' → 'Dream build'. */
function nameFromWakeType(wakeType: string): string {
  const spaced = wakeType.replace(/_/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// --- Local time (the spontaneous day's turnover) ---

function getLocalTimeComponents(date: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value || '0');

  // Day of week: use short weekday name to avoid locale/timezone ambiguity
  const dowName = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(date);
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    minute: get('minute'),
    hour: get('hour'),
    dayOfMonth: get('day'),
    month: get('month'),
    dayOfWeek: dowMap[dowName] ?? 0,
  };
}

// --- Default schedule definitions ---

// Exported for registration tests (orchestrator.default-tasks.test.ts).
export const DEFAULT_TASKS: TaskDefinition[] = [
  // Handoff — close the day before midnight
  { wakeType: 'handoff', label: 'Handoff', cronExpr: '50 23 * * *', category: 'handoff' },
  // Night wakes — autonomous work while the operator sleeps
  { wakeType: 'new_day', label: 'New Day', cronExpr: '0 1 * * *', category: 'wake', freshSession: true },
  { wakeType: 'deep_work', label: 'Deep Work', cronExpr: '30 2 * * *', category: 'wake' },
  { wakeType: 'light_scan', label: 'Light Scan', cronExpr: '0 4 * * *', category: 'wake' },
  { wakeType: 'morning_prep', label: 'Morning Prep', cronExpr: '0 7 * * *', category: 'wake' },
  // Check-ins — message the operator
  { wakeType: 'morning', label: 'Morning', cronExpr: '0 8 * * *', category: 'checkin', conditional: true },
  { wakeType: 'midday', label: 'Midday', cronExpr: '0 12 * * *', category: 'checkin', conditional: true },
  { wakeType: 'afternoon', label: 'Afternoon', cronExpr: '0 15 * * *', category: 'checkin', conditional: true },
  { wakeType: 'evening', label: 'Evening', cronExpr: '0 18 * * *', category: 'checkin', conditional: true },
  { wakeType: 'wind_down', label: 'Wind-down', cronExpr: '0 21 * * *', category: 'checkin' },
  // Weekly maintenance routines — Sunday evening/night. Both are
  // reschedulable at runtime via `sc schedule reschedule <wakeType> "<cron>"`
  // (persisted in the config table like every other wake).
  { wakeType: 'open_threads_janitor', label: 'Open Threads Janitor', cronExpr: '0 20 * * 0', category: 'routine' },
  { wakeType: 'weekly_digest_prep', label: 'Weekly Digest Prep', cronExpr: '30 21 * * 0', category: 'routine' },
  { wakeType: 'memory_diet', label: 'Memory Diet', cronExpr: '15 4 * * *', category: 'routine' },
  // The Treehouse at midday (Aerie's treehouse_midday) — Companion A and Companion B in
  // their own room, in turn, without the operator; she reads it in the Treehouse app.
  // Ships OFF: nothing new rings until the operator turns it on in Schedules.
  { wakeType: 'treehouse_midday', label: 'Treehouse', cronExpr: '0 12 * * *', category: 'wake', defaultOff: true },
];

// --- Managed task interface ---

interface ManagedTask {
  /** This bell's own node-cron timer (Aerie's engine: one timer per bell). */
  task: cron.ScheduledTask;
  cronExpr: string;
  handler: () => void | Promise<void>;
  wakeType: string;
  label: string;
  enabled: boolean;
  category: 'wake' | 'checkin' | 'handoff' | 'failsafe' | 'routine';
  /** A bell the owner made, rather than one shipped with the house. */
  custom: boolean;
}

// --- Default failsafe thresholds (minutes) ---

const DEFAULT_FAILSAFE_GENTLE = 120;
const DEFAULT_FAILSAFE_CONCERNED = 720;
const DEFAULT_FAILSAFE_EMERGENCY = 1440;

// --- Orchestrator ---

export class Orchestrator {
  private agent: AgentService;
  private pushService: PushService | null;
  private tasks = new Map<string, ManagedTask>();
  private failsafeInterval: ReturnType<typeof setInterval> | null = null;
  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private lastFailsafeAction: Date = new Date(0);
  private failsafeEnabled = true;
  private failsafeGentle = DEFAULT_FAILSAFE_GENTLE;
  private failsafeConcerned = DEFAULT_FAILSAFE_CONCERNED;
  private failsafeEmergency = DEFAULT_FAILSAFE_EMERGENCY;
  private pulseInterval: ReturnType<typeof setInterval> | null = null;
  private digestInterval: ReturnType<typeof setInterval> | null = null;
  private memoryExtractionInterval: ReturnType<typeof setInterval> | null = null;
  private pulseEnabled = false;
  private pulseFrequency = 15; // minutes
  private lastUserPresenceState: 'active' | 'idle' | 'offline' = 'offline';
  private intentionsBusy = false;
  private wakePrompts: Record<string, string> = {};
  // Spontaneous ("dice") wakes — rolled daily at random times, never announced
  private spontaneousTimers: Array<ReturnType<typeof setTimeout>> = [];
  private spontaneousRollTask: cron.ScheduledTask | null = null;

  constructor(agent: AgentService, pushService?: PushService) {
    this.agent = agent;
    this.pushService = pushService || null;
  }

  start(): void {
    olog('Starting...');

    const config = getBytelightConfig();
    const timezone = config.identity.timezone;
    const userName = config.identity.user_name;

    // Load wake prompts from file or use defaults
    const loadedPrompts = parseWakePromptsFile(config.orchestrator.wake_prompts_path, userName);
    // Dynamically load ALL wake prompts from the file
    this.wakePrompts = {};
    for (const [key, prompt] of Object.entries(loadedPrompts)) {
      this.wakePrompts[key] = `${WAKE_PROMPT_PREFIX}\n\n${prompt}`;
    }

    // Load failsafe config from DB, falling back to yaml config, then defaults
    this.failsafeEnabled = getConfigBool('failsafe.enabled', config.orchestrator.failsafe.enabled);
    this.failsafeGentle = getConfigNumber('failsafe.gentle', config.orchestrator.failsafe.gentle_minutes || DEFAULT_FAILSAFE_GENTLE);
    this.failsafeConcerned = getConfigNumber('failsafe.concerned', config.orchestrator.failsafe.concerned_minutes || DEFAULT_FAILSAFE_CONCERNED);
    this.failsafeEmergency = getConfigNumber('failsafe.emergency', config.orchestrator.failsafe.emergency_minutes || DEFAULT_FAILSAFE_EMERGENCY);

    // Load pulse config from DB
    this.pulseEnabled = getConfigBool('pulse.enabled', false);
    this.pulseFrequency = getConfigNumber('pulse.frequency', this.pulseFrequency);

    // Apply any schedule overrides from config + register custom wake
    // types. YAML overrides go through the same cron.validate() check
    // used elsewhere in this file so a malformed orchestrator.schedules
    // entry can't crash startup — they get rejected here, not later
    // when the polling matcher hits an unparseable expression.
    const defaultWakeTypes = new Set(DEFAULT_TASKS.map(d => d.wakeType));
    const taskDefs: TaskDefinition[] = DEFAULT_TASKS.map(def => {
      const overrideCron = config.orchestrator.schedules[def.wakeType];
      if (overrideCron) {
        if (cron.validate(overrideCron)) {
          return { ...def, cronExpr: overrideCron };
        }
        olog(
          `  ${def.wakeType}: WARNING orchestrator.schedules YAML override "${overrideCron}" is invalid; ` +
            `falling back to default ${def.cronExpr}.`,
        );
      }
      return def;
    });

    // Add custom schedule entries not in DEFAULT_TASKS — same validation.
    // For custom wakes there's no default to fall back to, so an invalid
    // entry is skipped entirely with a loud log; the rest of the
    // orchestrator still loads.
    for (const [wakeType, cronExpr] of Object.entries(config.orchestrator.schedules)) {
      if (defaultWakeTypes.has(wakeType)) continue; // already handled above
      if (!cron.validate(cronExpr)) {
        olog(
          `  ${wakeType}: WARNING custom orchestrator.schedules YAML cron "${cronExpr}" is invalid; ` +
            `skipping this wake type. Fix the entry in bytelight.yaml to register it.`,
        );
        continue;
      }
      const label = wakeType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      taskDefs.push({
        wakeType,
        label,
        cronExpr,
        category: 'wake',
        conditional: false,
      });
      // Ensure a wake prompt exists for this custom type
      if (!this.wakePrompts[wakeType]) {
        this.wakePrompts[wakeType] = `${WAKE_PROMPT_PREFIX}\n\nScheduled check-in (${label}).`;
      }
    }

    // Register every bell on its own node-cron timer (Aerie's engine).
    for (const def of taskDefs) {
      const savedCron = getConfig(`cron.${def.wakeType}.schedule`);
      const cronExpr = savedCron && cron.validate(savedCron) ? savedCron : def.cronExpr;
      const enabled = getConfigBool(`cron.${def.wakeType}.enabled`, def.wakeType !== 'memory_diet' && !def.defaultOff);
      if (savedCron) olog(`  ${def.wakeType}: using saved schedule ${cronExpr}`);
      // A rename from the phone survives a restart (Aerie reads a saved label
      // for made bells only; here every bell keeps the name it was given).
      const savedLabel = (getConfig(`cron.${def.wakeType}.label`) || '').trim();

      const handler = () => {
        if (def.wakeType === 'memory_diet') {
          runMemoryDiet()
            .then(result => olog(`memory_diet: ${JSON.stringify(result)}`))
            .catch(err => olog(`memory_diet error: ${err.message}`));
          return;
        }
        if (def.conditional && this.shouldSkipCheckIn()) {
          olog(`${def.wakeType} — skipped (user active)`);
          return;
        }
        this.handleWake(def.wakeType, { freshSession: def.freshSession });
      };

      const task = this.scheduleBell(def.wakeType, cronExpr, handler);
      // node-cron v4 auto-starts tasks; stop if disabled in config
      if (!enabled) {
        task.stop();
        olog(`  ${def.wakeType}: DISABLED (persisted)`);
      }

      this.tasks.set(def.wakeType, {
        task,
        cronExpr,
        handler,
        wakeType: def.wakeType,
        label: savedLabel || def.label,
        enabled,
        category: def.category,
        custom: false,
      });
    }

    // The Treehouse thread exists from boot (Aerie: initializeTreehouse in start()).
    initializeTreehouse();

    // Owner-made bells come back from the settings table.
    this.loadCustomBells();
    this.applyCustomBellPrompts();

    // --- Spontaneous dice — restore or roll today; re-rolled daily at 03:00
    // local, the spontaneous day's turnover (Aerie's 03:00 roll timer).
    const roll = () => {
      try { this.rollSpontaneousWakes(); } catch (err) { olog(`SPONTANEOUS roll error: ${errMessage(err)}`); }
    };
    this.spontaneousRollTask = cron.schedule(`0 ${SPONTANEOUS_DAY_START_HOUR} * * *`, roll, { timezone });
    // A 03:00 the process slept through still rolls the day, late rather
    // than never (the guarantee the minute poller used to give).
    try { this.spontaneousRollTask.on('execution:missed', roll); } catch { /* older node-cron */ }
    this.rollSpontaneousWakes();

    // --- Failsafe polling (every 15 minutes) ---
    if (this.failsafeEnabled) {
      this.failsafeInterval = setInterval(() => this.checkFailsafe(), 15 * 60 * 1000);
    }

    // --- Timer + Trigger polling (every 60 seconds) ---
    this.timerInterval = setInterval(async () => {
      await this.checkTimers();
      await this.checkTriggers();
      await this.checkIntentions();
    }, 60 * 1000);

    olog('All schedules registered');
    const checkinNames = taskDefs.map(d => d.wakeType).join(', ');
    olog(`Check-ins: ${checkinNames}`);
    olog(`Failsafe: ${this.failsafeEnabled ? 'every 15 minutes' : 'DISABLED'}`);
    olog(`Failsafe thresholds: gentle=${this.failsafeGentle}m, concerned=${this.failsafeConcerned}m, emergency=${this.failsafeEmergency}m`);

    // --- Pulse (lightweight awareness check) ---
    if (this.pulseEnabled) {
      this.pulseInterval = setInterval(() => this.checkPulse(), this.pulseFrequency * 60 * 1000);
    }

    // --- Scribe digest (every 30 minutes) ---
    const digestEnabled = getConfigBool('digest.enabled', true);
    if (digestEnabled) {
      this.digestInterval = setInterval(() => {
        runDigest(this.agent).catch(err => olog(`Digest error: ${err.message}`));
      }, 30 * 60 * 1000);
    }

    // --- Archivist memory extraction (every 2 hours by default) ---
    // Background distillation of durable facts (Aerie's Archivist). Its output
    // lands in memory_proposals for the operator's review, never straight on a block.
    // Gated by config; skips itself while the agent is processing
    // (runMemoryExtraction checks agent.isProcessing) so it never competes
    // with a live turn — same busy-check idiom as the Scribe digest. Interval:
    // agent.archivist_interval_minutes, else Aerie's two-hour default.
    const memoryExtractionEnabled = getConfigBool('memory.extraction_enabled', true);
    const memoryExtractionMinutes = resolveExtractionInterval(undefined, getConfig('agent.archivist_interval_minutes'));
    if (memoryExtractionEnabled) {
      this.memoryExtractionInterval = setInterval(() => {
        runMemoryExtraction(this.agent).catch(err => olog(`Memory extraction error: ${err.message}`));
      }, memoryExtractionMinutes * 60 * 1000);
    }

    olog('Timers + Triggers: polling every 60s');
    olog(`Pulse: ${this.pulseEnabled ? `every ${this.pulseFrequency}m` : 'DISABLED'}`);
    olog(`Scribe digest: ${digestEnabled ? 'every 30m' : 'DISABLED'}`);
    olog(`Archivist memory extraction: ${memoryExtractionEnabled ? `every ${memoryExtractionMinutes}m` : 'DISABLED'}`);
  }

  stop(): void {
    olog('Stopping...');
    for (const [, managed] of this.tasks) managed.task.stop();
    this.tasks.clear();
    for (const t of this.spontaneousTimers) clearTimeout(t);
    this.spontaneousTimers = [];
    if (this.spontaneousRollTask) {
      this.spontaneousRollTask.stop();
      this.spontaneousRollTask = null;
    }
    if (this.failsafeInterval) {
      clearInterval(this.failsafeInterval);
      this.failsafeInterval = null;
    }
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    if (this.pulseInterval) {
      clearInterval(this.pulseInterval);
      this.pulseInterval = null;
    }
    if (this.digestInterval) {
      clearInterval(this.digestInterval);
      this.digestInterval = null;
    }
    if (this.memoryExtractionInterval) {
      clearInterval(this.memoryExtractionInterval);
      this.memoryExtractionInterval = null;
    }
  }

  // --- Public runtime control methods ---

  async getStatus(): Promise<Array<OrchestratorTaskStatus & { custom: boolean }>> {
    const statuses: Array<OrchestratorTaskStatus & { custom: boolean }> = [];

    for (const [, managed] of this.tasks) {
      const status: 'scheduled' | 'stopped' = managed.enabled ? 'scheduled' : 'stopped';
      // The bell's own timer knows its next ring — no scanning.
      let nextRun: string | null = null;
      if (managed.enabled) {
        try {
          const next = managed.task.getNextRun();
          if (next) nextRun = next.toISOString();
        } catch {
          // not available
        }
      }

      statuses.push({
        wakeType: managed.wakeType,
        label: managed.label,
        cronExpr: managed.cronExpr,
        enabled: managed.enabled,
        status,
        nextRun,
        category: managed.category,
        companion: (getConfig(`cron.${managed.wakeType}.companion`) || '').trim() || null,
        custom: managed.custom,
      });
    }

    return statuses;
  }

  /** The companions a bell belongs to, in the order they answer. Unknown slugs are skipped. */
  private bellOwners(wakeType: string): Array<{ slug: string; name: string }> {
    try {
      const companions = listCompanions();
      return parseBellOwners(getConfig(`cron.${wakeType}.companion`))
        .map((slug) => companions.find((c) => c.id === slug))
        .filter((c): c is NonNullable<typeof c> => Boolean(c))
        .map((c) => ({ slug: c.id, name: c.display_name || c.id }));
    } catch {
      return [];
    }
  }

  /** One node-cron timer for one bell, in the house timezone. */
  private scheduleBell(wakeType: string, cronExpr: string, handler: () => void | Promise<void>): cron.ScheduledTask {
    const task = cron.schedule(cronExpr, handler, { timezone: getBytelightConfig().identity.timezone });
    // node-cron reports a run it could not make on time (the process was
    // blocked or asleep through it). Say so, rather than missing it silently.
    try {
      task.on('execution:missed', () => olog(`MISSED: ${wakeType} — its timer could not ring on time`));
    } catch {
      // older node-cron without task events
    }
    return task;
  }

  enableTask(wakeType: string): boolean {
    const managed = this.tasks.get(wakeType);
    if (!managed) return false;

    managed.task.start();
    managed.enabled = true;
    setConfig(`cron.${wakeType}.enabled`, 'true');
    olog(`ENABLED: ${wakeType}`);
    return true;
  }

  disableTask(wakeType: string): boolean {
    const managed = this.tasks.get(wakeType);
    if (!managed) return false;

    managed.task.stop();
    managed.enabled = false;
    setConfig(`cron.${wakeType}.enabled`, 'false');
    olog(`DISABLED: ${wakeType}`);
    return true;
  }

  rescheduleTask(wakeType: string, newCronExpr: string): boolean {
    const managed = this.tasks.get(wakeType);
    if (!managed) return false;

    if (!cron.validate(newCronExpr)) {
      olog(`RESCHEDULE FAILED: ${wakeType} — invalid cron expression: ${newCronExpr}`);
      return false;
    }

    // Destroy the old timer and make a new one (Aerie's reschedule).
    managed.task.stop();
    const newTask = this.scheduleBell(wakeType, newCronExpr, managed.handler);
    // Respect current enabled state
    if (!managed.enabled) newTask.stop();
    managed.task = newTask;
    managed.cronExpr = newCronExpr;
    // The name carries no time (the card shows the time on its own), so a
    // reschedule leaves it alone.
    setConfig(`cron.${wakeType}.schedule`, newCronExpr);
    olog(`RESCHEDULED: ${wakeType} -> ${newCronExpr}`);
    return true;
  }

  /**
   * Hand a bell to a companion (or several, in the order they answer), or
   * give it back to the house. Unset means shared. Takes effect on the next
   * ring; nothing to restart. (Aerie.) Until companions have lanes of their
   * own, an owned bell still rings in the shared lane — the owner is kept and
   * shown, and routes it once lanes exist.
   */
  setTaskCompanion(wakeType: string, slug: string | null): boolean {
    const managed = this.tasks.get(wakeType);
    if (!managed) return false;

    const key = `cron.${wakeType}.companion`;
    const slugs = parseBellOwners(slug);
    if (slugs.length === 0) {
      deleteConfig(key);
      olog(`${wakeType}: bell is shared again — no owner`);
      return true;
    }
    // A slug that resolves to nobody would look, from the phone, exactly like
    // a bell that was set.
    const missing = slugs.filter((s) => !companionExists(s));
    if (missing.length > 0) {
      olog(`${wakeType}: cannot hand the bell to '${missing.join(', ')}' — no companion by that slug`);
      return false;
    }
    setConfig(key, slugs.join(','));
    olog(`${wakeType}: bell belongs to ${slugs.join(', ')}`);
    return true;
  }

  /**
   * Rename a bell. What the owner reads on the roster, nothing else — the
   * schedule, the owner and the prompt are untouched. Empty hands back the
   * generated name. (Aerie.)
   */
  setTaskLabel(wakeType: string, label: string): boolean {
    const managed = this.tasks.get(wakeType);
    if (!managed) return false;

    const key = `cron.${wakeType}.label`;
    const trimmed = label.trim();
    if (!trimmed) {
      deleteConfig(key);
      const builtin = DEFAULT_TASKS.find((d) => d.wakeType === wakeType);
      managed.label = builtin?.label || nameFromWakeType(wakeType);
    } else {
      setConfig(key, trimmed);
      managed.label = trimmed;
    }
    olog(`${wakeType}: now reads '${managed.label}'`);
    return true;
  }

  getFailsafeConfig(): { enabled: boolean; gentle: number; concerned: number; emergency: number } {
    return {
      enabled: this.failsafeEnabled,
      gentle: this.failsafeGentle,
      concerned: this.failsafeConcerned,
      emergency: this.failsafeEmergency,
    };
  }

  setFailsafeConfig(config: { enabled?: boolean; gentle?: number; concerned?: number; emergency?: number }): void {
    if (config.enabled !== undefined) {
      this.failsafeEnabled = config.enabled;
      setConfig('failsafe.enabled', String(config.enabled));

      // Start or stop failsafe interval
      if (config.enabled && !this.failsafeInterval) {
        this.failsafeInterval = setInterval(() => this.checkFailsafe(), 15 * 60 * 1000);
        olog('Failsafe ENABLED');
      } else if (!config.enabled && this.failsafeInterval) {
        clearInterval(this.failsafeInterval);
        this.failsafeInterval = null;
        olog('Failsafe DISABLED');
      }
    }

    if (config.gentle !== undefined) {
      this.failsafeGentle = config.gentle;
      setConfig('failsafe.gentle', String(config.gentle));
    }
    if (config.concerned !== undefined) {
      this.failsafeConcerned = config.concerned;
      setConfig('failsafe.concerned', String(config.concerned));
    }
    if (config.emergency !== undefined) {
      this.failsafeEmergency = config.emergency;
      setConfig('failsafe.emergency', String(config.emergency));
    }

    olog(`Failsafe config updated: enabled=${this.failsafeEnabled}, gentle=${this.failsafeGentle}m, concerned=${this.failsafeConcerned}m, emergency=${this.failsafeEmergency}m`);
  }

  // --- Owner-made bells ---

  /**
   * Make a new bell, live: its own timer in the running process, and enough
   * persisted to come back on its own after a restart. Validation is what the
   * phone's form relies on. The label is the owner's name for it, shown with
   * its time like the built-ins ("9:00 AM — Tea").
   */
  createCustomWake(opts: {
    wakeType: string;
    cronExpr: string;
    label?: string;
    prompt?: string;
    companion?: string | null;
  }): { ok: true } | { ok: false; error: string } {
    const wakeType = (opts.wakeType || '').trim();
    const cronExpr = (opts.cronExpr || '').trim();
    const prompt = (opts.prompt || '').trim();
    if (!CUSTOM_WAKE_TYPE_RE.test(wakeType)) {
      return { ok: false, error: 'A bell needs a plain name — letters, numbers and underscores.' };
    }
    if (!cronExpr || !cron.validate(cronExpr)) {
      return { ok: false, error: `'${cronExpr}' is not a valid cron expression.` };
    }
    // The prompt is what the woken session actually reads. Without one the
    // timer fires into 'Unknown wake type' forever.
    if (!prompt) {
      return { ok: false, error: 'A bell needs something to say — write its prompt.' };
    }
    if (isReservedWakeTypeName(wakeType)) {
      return { ok: false, error: `'${wakeType}' is a reserved name — the house already uses it. Pick another name.` };
    }
    if (this.tasks.has(wakeType)) {
      return { ok: false, error: `There is already a bell called '${wakeType}'.` };
    }
    const owners = parseBellOwners(opts.companion);
    const unknownOwner = owners.find((slug) => !companionExists(slug));
    if (unknownOwner) {
      return { ok: false, error: `No companion with the slug '${unknownOwner}'.` };
    }

    const label = (opts.label || '').trim() || nameFromWakeType(wakeType);

    setConfig(`cron.${wakeType}.schedule`, cronExpr);
    setConfig(`cron.${wakeType}.enabled`, 'true');
    setConfig(`cron.${wakeType}.label`, label);
    setConfig(`cron.${wakeType}.prompt`, prompt);
    if (owners.length > 0) setConfig(`cron.${wakeType}.companion`, owners.join(','));
    saveCustomWakeTypes([...listCustomWakeTypes(), wakeType]);

    this.registerCustomBell(wakeType, label, cronExpr, true);
    this.applyCustomBellPrompts();

    olog(`NEW BELL: ${wakeType} -> ${cronExpr}${owners.length ? ` (${owners.join(', ')})` : ' (shared)'}`);
    return { ok: true };
  }

  /**
   * Take a bell back out. Only ones the owner made — the built-ins turn off
   * rather than disappear, so there is always a way back to them.
   */
  deleteCustomWake(wakeType: string): { ok: true } | { ok: false; error: string } {
    const managed = this.tasks.get(wakeType);
    const persisted = listCustomWakeTypes();
    if (!managed && !persisted.includes(wakeType)) {
      return { ok: false, error: 'No bell by that name.' };
    }
    if (managed && !managed.custom) {
      return { ok: false, error: 'That bell came with the house — turn it off instead of removing it.' };
    }

    if (managed) {
      managed.task.stop();
      this.tasks.delete(wakeType);
    }
    delete this.wakePrompts[wakeType];
    for (const suffix of ['schedule', 'enabled', 'label', 'companion', 'prompt']) {
      deleteConfig(`cron.${wakeType}.${suffix}`);
    }
    saveCustomWakeTypes(persisted.filter((t) => t !== wakeType));
    olog(`BELL REMOVED: ${wakeType}`);
    return { ok: true };
  }

  isCustomWake(wakeType: string): boolean {
    return this.tasks.get(wakeType)?.custom === true;
  }

  /** Rewrite an owner-made bell's prompt in the settings table; live on the next ring. */
  setCustomWakePrompt(wakeType: string, prompt: string): boolean {
    if (!this.isCustomWake(wakeType) || !prompt.trim()) return false;
    setConfig(`cron.${wakeType}.prompt`, prompt);
    this.applyCustomBellPrompts();
    olog(`BELL PROMPT UPDATED: ${wakeType}`);
    return true;
  }

  private registerCustomBell(wakeType: string, label: string, cronExpr: string, enabled: boolean): void {
    const handler = () => { this.handleWake(wakeType); };
    const task = this.scheduleBell(wakeType, cronExpr, handler);
    if (!enabled) task.stop();
    this.tasks.set(wakeType, {
      task,
      cronExpr,
      handler,
      wakeType,
      label,
      enabled,
      // 'wake' so the phone's Wakes list shows it beside the house's own.
      category: 'wake',
      custom: true,
    });
  }

  /**
   * Bring owner-made bells back at boot. The list is `cron.custom.types`.
   *
   * Adapted (the owner's call, 2026-10-20): a bell this house made before it
   * kept that list — a saved `cron.<wakeType>.schedule` that names no built-in
   * and has a prompt to say — is adopted into the list rather than left
   * silent, so bells made on an earlier build ring again.
   */
  private loadCustomBells(): void {
    let all: Record<string, string>;
    try {
      all = getAllConfig();
    } catch (err) {
      olog(`custom bells: could not read settings — ${errMessage(err)}`);
      return;
    }
    const listed = listCustomWakeTypes();
    const adopted: string[] = [];
    for (const key of Object.keys(all)) {
      const match = key.match(/^cron\.(\w+)\.schedule$/);
      if (!match) continue;
      const wakeType = match[1];
      if (listed.includes(wakeType) || this.tasks.has(wakeType)) continue;
      const hasPrompt = Boolean((all[`cron.${wakeType}.prompt`] || '').trim() || this.wakePrompts[wakeType]);
      if (!hasPrompt || isReservedWakeTypeName(wakeType)) continue;
      adopted.push(wakeType);
    }
    if (adopted.length > 0) {
      saveCustomWakeTypes([...listed, ...adopted]);
      olog(`custom bells: adopted ${adopted.join(', ')} from saved schedules`);
    }

    for (const wakeType of [...listed, ...adopted]) {
      if (isReservedWakeTypeName(wakeType)) {
        olog(`custom bell '${wakeType}' SKIPPED — that name is reserved for a built-in wake`);
        continue;
      }
      if (this.tasks.has(wakeType)) {
        olog(`custom bell '${wakeType}' SKIPPED — a wake with that name is already registered`);
        continue;
      }
      const cronExpr = all[`cron.${wakeType}.schedule`] || '';
      if (!cron.validate(cronExpr)) {
        olog(`custom bell '${wakeType}' SKIPPED — '${cronExpr}' is not a valid cron expression`);
        continue;
      }
      if (!(all[`cron.${wakeType}.prompt`] || '').trim() && !this.wakePrompts[wakeType]) {
        olog(`custom bell '${wakeType}' SKIPPED — it has no prompt`);
        continue;
      }
      const label = (all[`cron.${wakeType}.label`] || '').trim() || nameFromWakeType(wakeType);
      const enabled = getConfigBool(`cron.${wakeType}.enabled`, true);
      this.registerCustomBell(wakeType, label, cronExpr, enabled);
      olog(`custom bell '${wakeType}' registered: ${cronExpr}${enabled ? '' : ' (DISABLED)'}`);
    }
  }

  /**
   * A made bell's stored prompt (the text the owner typed) wins over a
   * same-named prompts-file section; without one, the file section stands.
   */
  private applyCustomBellPrompts(): void {
    let userName = 'the user';
    try { userName = getBytelightConfig().identity.user_name; } catch { /* config not loaded */ }
    for (const [wakeType, managed] of this.tasks) {
      if (!managed.custom) continue;
      const stored = getConfig(`cron.${wakeType}.prompt`);
      if (stored && stored.trim()) {
        this.wakePrompts[wakeType] = `${WAKE_PROMPT_PREFIX}\n\n${stored.replace(/\{user_name\}/g, userName)}`;
      }
    }
  }

  // --- Spontaneous ("dice") wakes ---
  //
  // Scheduled wakes are expectation; these are the opposite. Each day the
  // scheduler rolls 0..max fire times at random inside the window — nobody,
  // including the companions, knows when (or whether) one lands until it does.

  getSpontaneousConfig(): { enabled: boolean; maxPerDay: number; windowStart: number; windowEnd: number; pendingToday: number } {
    return {
      enabled: getConfigBool('spontaneous.enabled', false),
      maxPerDay: getConfigNumber('spontaneous.max_per_day', 2),
      windowStart: getConfigNumber('spontaneous.window_start', 10),
      windowEnd: getConfigNumber('spontaneous.window_end', 26),
      pendingToday: this.spontaneousTimers.length,
    };
  }

  setSpontaneousConfig(config: { enabled?: boolean; maxPerDay?: number; windowStart?: number; windowEnd?: number }): void {
    if (config.enabled !== undefined) setConfig('spontaneous.enabled', String(config.enabled));
    if (config.maxPerDay !== undefined) setConfig('spontaneous.max_per_day', String(config.maxPerDay));
    if (config.windowStart !== undefined) setConfig('spontaneous.window_start', String(config.windowStart));
    if (config.windowEnd !== undefined) setConfig('spontaneous.window_end', String(config.windowEnd));
    const c = this.getSpontaneousConfig();
    olog(`Spontaneous config updated: enabled=${c.enabled}, maxPerDay=${c.maxPerDay}, window=${c.windowStart}:00-${c.windowEnd}:00`);
    // The settings changed, so the day genuinely gets re-rolled.
    this.rollSpontaneousWakes(true);
  }

  /**
   * Is it currently inside the do-not-disturb window?
   *
   * OFF BY DEFAULT AND OPT-IN (dnd_enabled). dnd_start / dnd_end may already
   * sit in a database from earlier seeding; simply honouring them would hand a
   * house quiet hours it never asked for. The window may wrap midnight.
   */
  private isWithinDnd(): boolean {
    if (!getConfigBool('dnd_enabled', false)) return false;
    const start = getConfig('dnd_start');
    const end = getConfig('dnd_end');
    if (!start || !end) return false;

    const toMinutes = (hhmm: string): number | null => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
      if (!m) return null;
      const h = Number(m[1]);
      const min = Number(m[2]);
      if (h > 23 || min > 59) return null;
      return h * 60 + min;
    };

    const startMin = toMinutes(start);
    const endMin = toMinutes(end);
    if (startMin === null || endMin === null || startMin === endMin) return false;

    const t = getLocalTimeComponents(new Date(), getBytelightConfig().identity.timezone);
    const nowMin = t.hour * 60 + t.minute;
    return startMin < endMin
      ? nowMin >= startMin && nowMin < endMin
      : nowMin >= startMin || nowMin < endMin; // wraps midnight
  }

  private armSpontaneousTimer(delayMs: number): void {
    const timer = setTimeout(() => {
      this.spontaneousTimers = this.spontaneousTimers.filter(t => t !== timer);
      if (this.isWithinDnd()) { olog('SPONTANEOUS: skipped, inside the do-not-disturb window'); return; }
      this.handleWake('spontaneous');
    }, delayMs);
    // Never let a pending dice roll hold the process open on shutdown.
    timer.unref?.();
    this.spontaneousTimers.push(timer);
  }

  /**
   * Roll (or restore) today's spontaneous wakes.
   *
   * The times are persisted for the day (spontaneous.rolled_for /
   * spontaneous.rolled_times) and restored on boot, so a restart does not
   * quietly cancel a moment already scheduled for this afternoon. `force` is
   * for a genuine re-roll: the settings changed, so the day changes with them.
   *
   * The times are stored but never LOGGED — the dice stay secret, which is the
   * whole point of a spontaneous wake.
   */
  private rollSpontaneousWakes(force = false): void {
    for (const t of this.spontaneousTimers) clearTimeout(t);
    this.spontaneousTimers = [];

    if (!getConfigBool('spontaneous.enabled', false)) return;

    const timezone = getBytelightConfig().identity.timezone;
    const now = new Date();
    const today = spontaneousDayFor(timezone, now);

    if (!force && getConfig('spontaneous.rolled_for') === today) {
      let stored: number[] = [];
      try { stored = JSON.parse(getConfig('spontaneous.rolled_times') || '[]'); } catch { stored = []; }
      const future = stored.filter((at) => typeof at === 'number' && at > Date.now());
      for (const at of future) this.armSpontaneousTimer(at - Date.now());
      olog(`SPONTANEOUS: ${future.length} wake(s) still standing from today's roll`);
      return;
    }
    const maxPerDay = Math.max(0, getConfigNumber('spontaneous.max_per_day', 2));
    // Window in hours-of-day; end may run past midnight (26 = 2 AM next day)
    const windowStart = getConfigNumber('spontaneous.window_start', 10);
    const windowEnd = getConfigNumber('spontaneous.window_end', 26);

    const count = Math.floor(Math.random() * (maxPerDay + 1)); // 0..max inclusive
    if (count === 0) {
      setConfig('spontaneous.rolled_for', today);
      setConfig('spontaneous.rolled_times', '[]');
      olog('SPONTANEOUS: dice rolled 0 for today');
      return;
    }

    // Minutes since the start of the spontaneous day's calendar date: before
    // 03:00 it is still yesterday, so the hour counts past 24.
    const local = getLocalTimeComponents(now, timezone);
    const hour = local.hour % 24;
    const hourOfDay = hour < SPONTANEOUS_DAY_START_HOUR ? hour + 24 : hour;
    const nowMin = hourOfDay * 60 + local.minute;
    // Never schedule within the next 30 minutes of a roll — a wake right
    // after startup reads as scheduled, not spontaneous
    const startMin = Math.max(windowStart * 60, nowMin + 30);
    const endMin = windowEnd * 60;
    if (startMin >= endMin) {
      // Still mark the day rolled, so the poller does not retry every minute.
      setConfig('spontaneous.rolled_for', today);
      setConfig('spontaneous.rolled_times', '[]');
      olog('SPONTANEOUS: window already passed for today');
      return;
    }

    const firesAt: number[] = [];
    for (let i = 0; i < count; i++) {
      const targetMin = startMin + Math.floor(Math.random() * (endMin - startMin));
      const delayMs = (targetMin - nowMin) * 60_000 + Math.floor(Math.random() * 60_000);
      firesAt.push(Date.now() + delayMs);
      this.armSpontaneousTimer(delayMs);
    }
    // Persisted so a restart restores the day instead of re-rolling it. Stored,
    // never logged — the dice stay secret.
    setConfig('spontaneous.rolled_for', today);
    setConfig('spontaneous.rolled_times', JSON.stringify(firesAt));
    olog(`SPONTANEOUS: dice rolled ${count} wake(s) for today`);
  }

  // --- Pulse config ---

  getPulseConfig(): { enabled: boolean; frequency: number } {
    return { enabled: this.pulseEnabled, frequency: this.pulseFrequency };
  }

  setPulseConfig(config: { enabled?: boolean; frequency?: number }): void {
    if (config.enabled !== undefined) {
      this.pulseEnabled = config.enabled;
      setConfig('pulse.enabled', String(config.enabled));

      if (config.enabled && !this.pulseInterval) {
        this.pulseInterval = setInterval(() => this.checkPulse(), this.pulseFrequency * 60 * 1000);
        olog('Pulse ENABLED');
      } else if (!config.enabled && this.pulseInterval) {
        clearInterval(this.pulseInterval);
        this.pulseInterval = null;
        olog('Pulse DISABLED');
      }
    }

    if (config.frequency !== undefined && config.frequency >= 5) {
      this.pulseFrequency = config.frequency;
      setConfig('pulse.frequency', String(config.frequency));

      if (this.pulseEnabled && this.pulseInterval) {
        clearInterval(this.pulseInterval);
        this.pulseInterval = setInterval(() => this.checkPulse(), this.pulseFrequency * 60 * 1000);
      }
    }

    olog(`Pulse config updated: enabled=${this.pulseEnabled}, frequency=${this.pulseFrequency}m`);
  }

  // --- Pulse: lightweight awareness check ---

  private async checkPulse(): Promise<void> {
    const now = new Date();
    const hour = now.getHours();

    if (hour < 8) return;
    if (this.agent.isProcessing()) return;
    if (registry.getUserPresenceState() === 'active') return;

    const presence = registry.getUserPresenceState();
    const minutesSince = Math.round(registry.minutesSinceLastUserActivity());
    const device = registry.getUserDeviceType();
    const localTime = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const triggers = getActiveTriggers();

    const pulsePrompt = [
      'Quick awareness check. You don\'t have to say anything.',
      '',
      `User: ${presence}, last active ${minutesSince}min ago. Device: ${device}.`,
      `Time: ${localTime}. Active triggers: ${triggers.length}.`,
      '',
      'If something here warrants reaching out — a message, a reminder, a gentle pull — do it.',
      'If nothing needs attention, respond with just: PULSE_OK',
    ].join('\n');

    try {
      let thread = getTodayThread();
      if (!thread) return;

      const response = await this.agent.processAutonomous(thread.id, pulsePrompt);

      if (response.trim().startsWith('PULSE_OK')) {
        return;
      }

      updateThreadActivity(thread.id, new Date().toISOString(), true);
      olog(`PULSE: responded (${response.length} chars)`);
    } catch (error) {
      const errMsg = errMessage(error);
      olog(`PULSE ERROR: ${errMsg}`);
    }
  }

  // --- Public manual wake (called from /wake command) ---

  async triggerManualWake(wakeType = 'manual'): Promise<void> {
    await this.handleWake(wakeType);
  }

  // --- Core wake handler ---

  reloadWakePrompts(): void {
    const config = getBytelightConfig();
    const userName = config.identity.user_name;
    const loadedPrompts = parseWakePromptsFile(config.orchestrator.wake_prompts_path, userName);
    this.wakePrompts = {};
    for (const [key, prompt] of Object.entries(loadedPrompts)) {
      this.wakePrompts[key] = `${WAKE_PROMPT_PREFIX}\n\n${prompt}`;
    }
    this.applyCustomBellPrompts();
  }

  /**
   * Effective editable prompt body per wake type, with source attribution
   * (a `## key` block in wake.md overrides the built-in default). The body
   * is the raw section text — the shared WAKE_PROMPT_PREFIX is intentionally
   * not included, since that preamble is not user-editable.
   *
   * Owner-made bells report their settings-table prompt as an override
   * (source 'file', no default to reset to) and carry `custom: true`, so
   * editors treat them as hers. An overridden built-in also carries its
   * built-in text as `defaultPrompt` for side-by-side comparison.
   */
  getWakePromptReport(): {
    prompts: Array<{
      wakeType: string;
      body: string;
      source: 'file' | 'default';
      hasDefault: boolean;
      defaultPrompt: string | null;
      custom: boolean;
    }>;
    unusedSections: Array<{ key: string; body: string }>;
  } {
    const config = getBytelightConfig();
    const userName = config.identity.user_name;
    const path = config.orchestrator.wake_prompts_path;

    const defaults = getDefaultWakePrompts(userName);
    const effective = parseWakePromptsFile(path, userName); // defaults merged with file overrides
    const fileRaw = existsSync(path) ? readFileSync(path, 'utf-8') : '';
    const fileSections = parseWakeSections(fileRaw).sections;
    const fileKeys = new Set(fileSections.map((s) => s.key));

    // Every wake type a bell or a built-in default answers to.
    const keys = new Set<string>([...Object.keys(defaults), ...this.tasks.keys()]);

    const prompts = [...keys].sort().map((wakeType) => {
      if (this.isCustomWake(wakeType)) {
        return {
          wakeType,
          // Its own stored prompt, else the prompts-file section it rings with.
          body: getConfig(`cron.${wakeType}.prompt`) ?? effective[wakeType] ?? '',
          source: 'file' as const,
          hasDefault: false,
          defaultPrompt: null,
          custom: true,
        };
      }
      const source = (fileKeys.has(wakeType) ? 'file' : 'default') as 'file' | 'default';
      return {
        wakeType,
        body: effective[wakeType] ?? '',
        source,
        hasDefault: wakeType in defaults,
        defaultPrompt: source === 'file' ? defaults[wakeType] ?? null : null,
        custom: false,
      };
    });

    // File sections that no bell or built-in reads — surfaced so the operator
    // can spot orphaned text rather than have it silently ignored. (A manual
    // wake by that exact name still reads them.)
    const unusedSections = fileSections
      .filter((section) => !keys.has(section.key))
      .map((section) => ({ key: section.key, body: section.body }))
      .sort((a, b) => a.key.localeCompare(b.key));

    return { prompts, unusedSections };
  }

  private async handleWake(
    wakeType: string,
    opts?: { freshSession?: boolean }
  ): Promise<void> {
    // Prompts are reloaded when they are edited (the prompt routes call
    // reloadWakePrompts), not re-read from disk on every ring. (Aerie.)
    const prompt = this.wakePrompts[wakeType];
    if (!prompt) {
      olog(`ERROR: Unknown wake type: ${wakeType}`);
      return;
    }

    // A busy agent no longer means retry-and-skip: processAutonomous queues
    // the wake at lowest priority with a 30-minute window, so it waits its
    // turn behind live conversation. (Aerie.)
    if (this.agent.isProcessing()) {
      olog(`${wakeType} — agent busy, queueing behind current turn`);
    }

    await this.fireWake(wakeType, opts);
  }

  private async fireWake(
    wakeType: string,
    opts?: { freshSession?: boolean }
  ): Promise<void> {
    const prompt = this.wakePrompts[wakeType];
    if (!prompt) {
      olog(`ERROR: Unknown wake type: ${wakeType}`);
      return;
    }

    olog(`WAKE: ${wakeType}`);

    const wakeStartedAt = new Date().toISOString();
    let targetThreadId: string | null = null;

    // The bell's status word, when it has one, is up for as long as its turn
    // runs (services/bell-status.ts, Aerie), and comes down however the turn ends.
    let endStatusWord: (() => void) | null = null;
    // Set once this bell split the lanes, so the finally below always rejoins
    // them, even when a companion's turn throws.
    let splitForBell = false;
    try {
      // Fire into the routing thread ("Home") — wakes follow the pinned
      // routing pointer instead of creating daily threads (Thornvale port,
      // mirroring their resolveWakeTargets fallback).
      // The treehouse bell ignores the routing pointer — it always lands in the
      // treehouse, where both companions are members (Aerie's isTreehouseWake).
      const isTreehouseWake = wakeType === 'treehouse_midday';
      const thread = isTreehouseWake
        ? (getThread(getTreehouseThread().id) ?? resolveRoutingThread('wake', registry))
        : resolveRoutingThread('wake', registry);
      if (isTreehouseWake && thread.type !== 'treehouse') {
        olog(`SKIP: ${wakeType} — the treehouse could not be opened; not ringing it in ${thread.name}`);
        return;
      }
      targetThreadId = thread.id;

      // Fresh session: clear session on existing thread (don't create duplicate)
      if (opts?.freshSession) {
        updateThreadSession(thread.id, null);
      }

      // Handoff: write handoff note from the most recent thread with messages
      // This runs BEFORE the autonomous query so the handoff is always reliable
      if (wakeType === 'handoff') {
        try {
          this.writeHandoffFromPreviousThread(thread.id);
        } catch (err) {
          olog(`handoff: handoff write failed — ${(err as Error).message}`);
        }
      }

      // Every wake carries its outcome contract: land a visible line (or, for
      // the dice, a picture). The house's own prompt text is left intact above it.
      const fullPrompt = `${prompt}\n\n${wakeOutcomeContract(wakeType)}`;

      // Owned bells (Aerie): a bell that belongs to companions rings in each
      // owner's own lane, as him. Several owners answer in turn, each later
      // one handed what the earlier ones said.
      let owners = this.bellOwners(wakeType);
      // A treehouse bell nobody handed to anyone belongs to everyone who lives
      // there, so both companions speak in turn — each in his own lane, each
      // later one handed what the earlier one said (ringBellInTurn).
      if (isTreehouseWake && owners.length === 0) owners = treehouseMembers();
      endStatusWord = bellStatus().begin(wakeType, owners.map((o) => o.slug));
      if (owners.length > 1) {
        olog(`${wakeType}: ringing in ${owners.map((o) => o.slug).join(', ')}'s own lanes, in turn`);
        this.splitLanesForBell(wakeType);
        splitForBell = true;
        const spoken = await ringBellInTurn(
          owners,
          async (owner, soFar, extra) => {
            const turn = (await this.agent.processAutonomous(thread.id, fullPrompt + sameBellBlock(soFar) + extra, owner.slug)).trim();
            if (turn === QUEUE_TIMEOUT_MESSAGE) {
              olog(`TIMEOUT: ${wakeType} waited out its queue window at ${owner.slug}`);
              return null;
            }
            return turn || null;
          },
          (caller, target, n) => olog(`${wakeType}: ${caller.slug} called ${target.slug} back by name (${n} of ${MAX_BELL_RECALLS})`),
        );
        if (spoken.length > 0) updateThreadActivity(thread.id, new Date().toISOString(), true);
        olog(`DONE: ${wakeType} (${spoken.length} of ${owners.length} answered)`);
        return;
      }
      if (owners.length === 1) olog(`${wakeType}: ringing in ${owners[0].slug}'s own lane`);
      const response = await this.agent.processAutonomous(thread.id, fullPrompt, owners[0]?.slug);

      // Outcomes are logged, never posted into the chat (Aerie): a wake that
      // could not run must not bury the conversation in failure cards.
      if (response.trim() === QUEUE_TIMEOUT_MESSAGE) {
        olog(`TIMEOUT: ${wakeType} waited out its queue window and was dropped`);
      } else if (response.trim()) {
        updateThreadActivity(thread.id, new Date().toISOString(), true);
        olog(`DONE: ${wakeType} (${response.length} chars)`);
      } else {
        olog(`DONE: ${wakeType} (passed in silence)`);
      }
    } catch (error) {
      olog(`ERROR: ${wakeType} failed — ${errMessage(error)}`);
    } finally {
      endStatusWord?.();
      if (splitForBell) {
        try {
          this.rejoinLanesAfterBell(wakeType);
        } catch (error) {
          olog(`ERROR: ${wakeType} could not rejoin the lanes — ${errMessage(error)}`);
        }
      }
    }
  }

  /**
   * A bell's status word (services/bell-status.ts, Aerie): what the phone says
   * under the faces while its turn runs. Null or empty takes it away. False for
   * a bell the house does not have.
   */
  setTaskStatusWord(wakeType: string, word: string | null): boolean {
    if (!this.tasks.has(wakeType)) return false;
    const kept = statusWordOf(word);
    if (kept) setConfig(statusWordKey(wakeType), kept);
    else deleteConfig(statusWordKey(wakeType));
    olog(`${wakeType}: status word ${kept ? `'${kept}'` : 'cleared'}`);
    return true;
  }

  /** Whether a bell has more than one owner. */
  private isSplitBell(wakeType: string): boolean {
    return parseBellOwners(getConfig(`cron.${wakeType}.companion`)).length > 1;
  }

  /**
   * Turn A Lane Each on for a several-owner bell when the owner has asked for
   * that (orchestrator.bells_split_lanes) and it is off (bell-lanes.ts, Aerie).
   *
   * BYTE-LIGHT ADAPTATION: byte-light's bells already ring in each owner's own
   * lane whatever the switch says (AgentService.wakeLaneFor), and it has no
   * lane keeper to warm, so Aerie's ensureCompanionLanes + warm-wait is left
   * out; the flip only shapes the interactive turns around the bell. And the
   * switch keeps byte-light's lock: it is never turned on while a companion
   * is missing a bio (the same rule the Preferences route enforces).
   */
  private splitLanesForBell(wakeType: string): void {
    const decision = laneSwitchBefore({
      splitLanes: getConfigBool(BELLS_SPLIT_LANES_KEY, false),
      multiLane: getConfig('agent.multi_lane') === 'true',
    });
    if (decision !== 'turn_on') return;
    if (!roomBiosReady().ready) {
      olog(`${wakeType}: would turn A Lane Each on for this bell, but a companion is missing a bio — left off`);
      return;
    }
    setConfig('agent.multi_lane', 'true');
    setConfig(LANES_BY_BELL_KEY, 'true');
    olog(`${wakeType}: turned A Lane Each on for this bell`);
  }

  /** After a bell: switch back off if a bell turned it on and none is due soon. (Aerie.) */
  private rejoinLanesAfterBell(wakeType: string): void {
    let next: Date | null = null;
    for (const [, managed] of this.tasks) {
      if (!managed.enabled || managed.wakeType === wakeType || !this.isSplitBell(managed.wakeType)) continue;
      try {
        const at = managed.task.getNextRun();
        if (at && (!next || at < next)) next = at;
      } catch { /* no next run known */ }
    }
    const decision = laneSwitchAfter({
      turnedOnByBell: getConfigBool(LANES_BY_BELL_KEY, false),
      multiLane: getConfig('agent.multi_lane') === 'true',
      nextSplitBellAt: next,
      now: new Date(),
    });
    if (decision !== 'turn_off') return;
    setConfig('agent.multi_lane', 'false');
    setConfig(LANES_BY_BELL_KEY, 'false');
    olog(`${wakeType}: last split bell for a while — A Lane Each back off`);
  }

  // --- Handoff ---

  /**
   * Write a comprehensive handoff note capturing the full day's conversations.
   * Pulls from ALL recent threads (not just one), prioritizing interactive messages.
   * Called by night_close wake before the autonomous query fires.
   */
  private writeHandoffFromPreviousThread(currentThreadId: string): void {
    const config = getBytelightConfig();
    const userName = config.identity.user_name;

    // Helper to extract text from content (handles string or array of content blocks)
    const extractText = (content: unknown): string => {
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content
          .filter((b): b is { type: string; text: string } => b?.type === 'text' && typeof b?.text === 'string')
          .map(b => b.text)
          .join(' ');
      }
      return '';
    };

    // Get recent threads (skip the current empty night_close thread)
    const threads = listThreads({ limit: 10 });
    const candidateThreads = threads.filter(t => t.id !== currentThreadId);

    if (candidateThreads.length === 0) {
      olog('night_close: no previous threads found for handoff');
      return;
    }

    // Collect messages from today's threads (up to 20 total, prioritizing user messages)
    const todayStr = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    const allDigestEntries: Array<{ role: string; content: string; thread: string; timestamp: string }> = [];

    for (const thread of candidateThreads) {
      // Only include threads from today/yesterday (recent enough to matter)
      const msgs = getMessages({ threadId: thread.id, limit: 15 });
      if (msgs.length === 0) continue;

      for (const m of msgs.reverse()) {
        // Skip autonomous companion messages (failsafe check-ins, etc.) — low value
        const meta = m.metadata as Record<string, unknown> | null;
        if (m.role === 'companion' && meta?.source === 'autonomous') continue;

        const text = extractText(m.content);
        allDigestEntries.push({
          role: m.role === 'companion' ? 'Companion' : userName,
          content: text.replace(/\n/g, ' ').trim().substring(0, 150),
          thread: thread.name,
          timestamp: m.created_at || '',
        });
      }
    }

    if (allDigestEntries.length === 0) {
      olog('night_close: no messages found across recent threads');
      return;
    }

    // Sort by timestamp and take the most recent 10, format as string (not array)
    allDigestEntries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const digestEntries = allDigestEntries.slice(-10);
    const digest = digestEntries
      .map(e => `${e.role}: ${e.content}${e.content.length >= 150 ? '...' : ''}`)
      .join('\n');

    // Excerpt from the last companion message
    const lastCompanion = [...allDigestEntries].reverse().find(e => e.role === 'Companion');
    const excerpt = lastCompanion
      ? lastCompanion.content.substring(0, 120)
      : '';

    // Thread summary — which threads contributed
    const threadNames = [...new Set(allDigestEntries.map(e => e.thread))];

    const handoff = JSON.stringify({
      thread: threadNames.join(', '),
      threadType: 'daily',
      reason: 'night_close',
      excerpt,
      digest,
      platform: 'web',
      autonomous: false,
      timestamp: new Date().toISOString(),
    });

    setConfig('session.handoff_note', handoff);
    olog(`night_close: handoff written from ${threadNames.length} thread(s): ${threadNames.join(', ')} (${digestEntries.length} messages)`);
  }

  // --- Failsafe ---

  private checkFailsafe(): void {
    const config = getBytelightConfig();
    const timezone = config.identity.timezone;
    const now = new Date();
    const hour = parseInt(now.toLocaleString('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false }));

    // Only check during waking hours (8am - midnight)
    if (hour < 8) return;

    // Only skip if user is genuinely active (tab focused + recent real interaction)
    if (registry.getUserPresenceState() === 'active') return;

    const minutesSince = registry.minutesSinceLastUserActivity();

    // Don't re-trigger failsafe within 2 hours of last action
    const minutesSinceLastAction = (now.getTime() - this.lastFailsafeAction.getTime()) / 60000;
    if (minutesSinceLastAction < 120) return;

    // Tiered escalation using configurable thresholds
    if (minutesSince > this.failsafeEmergency) {
      // 24+ hours — emergency
      olog(`FAILSAFE EMERGENCY — ${Math.round(minutesSince / 60)}h since contact`);
      this.lastFailsafeAction = now;
      this.handleWake('failsafe_emergency');
    } else if (minutesSince > this.failsafeConcerned) {
      // 12+ hours — concerned
      olog(`FAILSAFE CONCERNED — ${Math.round(minutesSince / 60)}h since contact`);
      this.lastFailsafeAction = now;
      this.handleWake('failsafe_concerned');
    } else if (minutesSince > this.failsafeGentle) {
      // 2+ hours — gentle check-in
      olog(`FAILSAFE gentle — ${Math.round(minutesSince)}min since contact`);
      this.lastFailsafeAction = now;
      this.handleWake('failsafe_gentle');
    }
  }

  // --- Timer polling ---

  private async checkTimers(): Promise<void> {
    const now = new Date().toISOString();
    const dueTimers = getDueTimers(now);

    for (const timer of dueTimers) {
      try {
        markTimerFired(timer.id, now);

        // Build reminder message
        let content = `**Reminder: ${timer.label}**`;
        if (timer.context) {
          content += `\n_Context: ${timer.context}_`;
        }

        // Post reminder as companion message
        const message = createMessage({
          id: crypto.randomUUID(),
          threadId: timer.thread_id,
          role: 'companion',
          content,
          metadata: { source: 'timer', timerId: timer.id },
          createdAt: now,
        });

        updateThreadActivity(timer.thread_id, now, true);
        registry.broadcast({ type: 'message', message });

        // Push notification for timers — always send (time-critical)
        if (this.pushService) {
          this.pushService.sendAlways({
            title: 'Reminder',
            body: timer.label,
            threadId: timer.thread_id,
            tag: `timer-${timer.id}`,
            url: '/chat',
          }).catch(err => console.error('Timer push error:', err));
        }

        olog(`TIMER FIRED: "${timer.label}" in thread ${timer.thread_id}`);

        // If prompt provided, fire autonomous wake
        if (timer.prompt) {
          if (this.agent.isProcessing()) {
            olog(`TIMER: autonomous prompt skipped (agent busy) for "${timer.label}"`);
          } else {
            const fullPrompt = `Timer reminder just fired: "${timer.label}"${timer.context ? ` (context: ${timer.context})` : ''}.\n\n${timer.prompt}`;
            this.agent.processAutonomous(timer.thread_id, fullPrompt).catch(err => {
              olog(`TIMER ERROR: autonomous prompt failed for "${timer.label}" — ${err.message || err}`);
            });
          }
        }
      } catch (error) {
        const errMsg = errMessage(error);
        olog(`TIMER ERROR: "${timer.label}" — ${errMsg}`);
      }
    }
  }

  // --- Trigger evaluation ---

  private async checkTriggers(): Promise<void> {
    const config = getBytelightConfig();
    const timezone = config.identity.timezone;
    const triggers = getActiveTriggers();
    if (triggers.length === 0) return;

    const now = new Date();
    const presenceNow = registry.getUserPresenceState();
    const agentFree = !this.agent.isProcessing();

    // Local time in configured timezone
    const localHour = parseInt(now.toLocaleString('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false }));
    const localMinute = parseInt(now.toLocaleString('en-GB', { timeZone: timezone, minute: '2-digit' }));

    // Lazy-fetch status only if any trigger needs it
    let statusText = '';
    const needsStatus = triggers.some(t => {
      const conditions: TriggerCondition[] = JSON.parse(t.conditions);
      return conditions.some(c => c.type === 'routine_missing');
    });
    if (needsStatus) {
      statusText = await fetchLifeStatus();
    }

    // Her status, for status_clears: Busy or Away is "away"; clear or Here is not.
    const owner = getOwnerStatus(now);
    const ownerAway = owner?.presence === 'busy' || owner?.presence === 'away';
    const quietForIntentions = this.intentionQuietNow(localHour, localMinute);

    const ctx: TriggerContext = {
      presenceNow,
      presencePrev: this.lastUserPresenceState,
      agentFree,
      statusText,
      hour: localHour,
      minute: localMinute,
      nowMs: now.getTime(),
      ownerAway,
    };

    for (const trigger of triggers) {
      try {
        // A promise doesn't come due inside the intentions' quiet hours; it
        // stays where it is until they end.
        if (quietForIntentions && getIntentionForTrigger(trigger.id)) continue;

        if (trigger.status === 'waiting') {
          // Waiting triggers: conditions already met, just need agent free
          if (agentFree) {
            await this.fireTrigger(trigger, now);
          }
          continue;
        }

        // Pending triggers: evaluate conditions
        const conditions: TriggerCondition[] = JSON.parse(trigger.conditions);

        // status_clears arms itself the first time it sees her Busy or Away,
        // and the arming is written back so a restart doesn't lose it.
        if (ownerAway && conditions.some(c => c.type === 'status_clears' && !c.armed)) {
          for (const c of conditions) if (c.type === 'status_clears') c.armed = true;
          updateTriggerConditions(trigger.id, conditions);
          continue;
        }

        // Watchers: check cooldown
        if (trigger.kind === 'watcher' && trigger.last_fired_at) {
          const lastFired = new Date(trigger.last_fired_at).getTime();
          const cooldownMs = (trigger.cooldown_minutes || 120) * 60 * 1000;
          if (now.getTime() - lastFired < cooldownMs) continue;
        }

        if (evaluateConditions(conditions, ctx)) {
          if (agentFree) {
            await this.fireTrigger(trigger, now);
          } else {
            // Conditions met but agent busy — mark waiting (impulses only)
            if (trigger.kind === 'impulse') {
              markTriggerWaiting(trigger.id);
              olog(`TRIGGER WAITING: "${trigger.label}" (agent busy)`);
            }
            // Watchers just skip this tick — they'll re-evaluate next time
          }
        }
      } catch (error) {
        const errMsg = errMessage(error);
        olog(`TRIGGER ERROR: "${trigger.label}" — ${errMsg}`);
      }
    }

    // Update presence state at end of tick
    this.lastUserPresenceState = presenceNow;
  }

  /** Inside the intentions' quiet hours (3–9 AM unless changed), house time. */
  private intentionQuietNow(hour?: number, minute?: number): boolean {
    const { quietStart, quietEnd } = intentionSettings();
    if (hour === undefined || minute === undefined) {
      const now = new Date();
      const timezone = getBytelightConfig().identity.timezone;
      hour = parseInt(now.toLocaleString('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false }));
      minute = parseInt(now.toLocaleString('en-GB', { timeZone: timezone, minute: '2-digit' }));
    }
    return inQuietWindow(quietStart, quietEnd, hour % 24, minute);
  }

  /** Where a promise is said: its own thread, else Home. A daily thread goes
   *  to Home, the way triggers do. */
  private intentionThread(intention: Intention, trigger: Trigger | null): string {
    const id = intention.threadId ?? trigger?.thread_id ?? null;
    const thread = id ? getThread(id) : null;
    if (thread && thread.type !== 'daily') return thread.id;
    return resolveRoutingThread('wake', registry).id;
  }

  /** The moment a promise comes due: the promiser says it, in his own lane. */
  private async fireIntention(intention: Intention, trigger: Trigger, now: Date): Promise<void> {
    const threadId = this.intentionThread(intention, trigger);
    const startedAt = now.toISOString();
    try {
      const userName = getBytelightConfig().identity.user_name;
      const response = await this.agent.processAutonomous(threadId, intentionPrompt(intention, userName, now), intention.companion);
      const said = companionMessageSince(threadId, startedAt);
      if (!said || !response || response === QUEUE_TIMEOUT_MESSAGE) {
        // Nothing reached her: back in line for the next tick.
        markPendingAgain(intention.id);
        rearmTrigger(trigger.id);
        olog(`INTENTION NOT SAID: "${intention.text.slice(0, 60)}" — back in line`);
        return;
      }
      markAsked(intention.id, threadId, said);
      updateThreadActivity(threadId, new Date().toISOString(), true);
      olog(`INTENTION SAID: ${intention.companion} — "${intention.text.slice(0, 60)}"`);
    } catch (error) {
      markPendingAgain(intention.id);
      rearmTrigger(trigger.id);
      olog(`INTENTION FIRE ERROR: "${intention.text.slice(0, 60)}" — ${errMessage(error)}`);
    }
  }

  /** Every tick: close what she answered, nudge once what she didn't, rest the rest. */
  private async checkIntentions(): Promise<void> {
    // A nudge can outlast the 60s tick; the next tick must not nudge again.
    if (this.intentionsBusy) return;
    this.intentionsBusy = true;
    try {
      const settings = intentionSettings();
      const now = new Date();
      const items = followUps(now, { quiet: this.intentionQuietNow(), nudgeAfterMinutes: settings.nudgeAfterMinutes, restAfterMinutes: settings.restAfterMinutes });
      for (const item of items) {
        if (item.kind === 'answered') olog(`INTENTION ANSWERED: "${item.intention.text.slice(0, 60)}"`);
        if (item.kind === 'rest') olog(`INTENTION RESTING: "${item.intention.text.slice(0, 60)}"`);
        if (item.kind !== 'nudge' || this.agent.isProcessing()) continue;
        const i = item.intention;
        const threadId = this.intentionThread(i, null);
        const startedAt = now.toISOString();
        const userName = getBytelightConfig().identity.user_name;
        const response = await this.agent.processAutonomous(threadId, nudgePrompt(i, userName, now), i.companion);
        const said = companionMessageSince(threadId, startedAt);
        if (said && response && response !== QUEUE_TIMEOUT_MESSAGE) {
          markNudged(i.id, said);
          updateThreadActivity(threadId, new Date().toISOString(), true);
          olog(`INTENTION NUDGED: ${i.companion} — "${i.text.slice(0, 60)}"`);
        }
      }
    } catch (error) {
      olog(`INTENTION CHECK ERROR: ${errMessage(error)}`);
    } finally {
      this.intentionsBusy = false;
    }
  }

  private async fireTrigger(trigger: Trigger, now: Date): Promise<void> {
    const nowIso = now.toISOString();

    // Update DB first
    if (trigger.kind === 'impulse') {
      markTriggerFired(trigger.id, nowIso);
    } else {
      markWatcherFired(trigger.id, nowIso);
    }

    const kindLabel = trigger.kind === 'impulse' ? 'Impulse' : 'Watcher';
    olog(`TRIGGER FIRED: [${kindLabel}] "${trigger.label}" (fire_count: ${trigger.fire_count + 1})`);

    // A promise riding this impulse is said in its promiser's own voice.
    const intention = getIntentionForTrigger(trigger.id);
    if (intention) {
      if (intention.state === 'pending') await this.fireIntention(intention, trigger, now);
      return;
    }

    // If no prompt, just log
    if (!trigger.prompt) return;

    try {
      // Resolve the target thread (use trigger's thread_id if specified, but
      // redirect daily-typed targets to the routing thread — byte-light no
      // longer rotates daily threads, so triggers fire into "Home" instead of
      // redirecting between dailies)
      let threadId = trigger.thread_id;
      if (threadId) {
        const triggerThread = getThread(threadId);
        if (triggerThread?.type === 'daily') {
          const home = resolveRoutingThread('wake', registry);
          if (home.id !== threadId) {
            olog(`TRIGGER: redirecting from daily thread "${triggerThread.name}" to routing thread "${home.name}"`);
            threadId = home.id;
          }
        }
      }
      if (!threadId) {
        const thread = resolveRoutingThread('wake', registry);
        threadId = thread.id;
      }

      const fullPrompt = `${kindLabel}: "${trigger.label}"\n\n${trigger.prompt}`;
      const response = await this.agent.processAutonomous(threadId!, fullPrompt);
      updateThreadActivity(threadId!, nowIso, true);
      olog(`TRIGGER DONE: "${trigger.label}" (${response.length} chars)`);
    } catch (error) {
      const errMsg = errMessage(error);
      olog(`TRIGGER FIRE ERROR: "${trigger.label}" — ${errMsg}`);
    }
  }

  // --- Helpers ---

  private shouldSkipCheckIn(): boolean {
    // Skip only if agent is currently processing (we're already mid-conversation)
    // Decision-point wakes handle user presence state in their own prompts —
    // the companion reads the room and decides whether to reach out or do its own thing
    return this.agent.isProcessing();
  }
}
