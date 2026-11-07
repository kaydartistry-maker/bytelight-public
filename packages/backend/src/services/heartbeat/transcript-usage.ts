/**
 * Warm-lane context gauge — reads the Claude Code transcript the CLI session
 * is writing and turns it into the same `context_usage` numbers the SDK lane
 * reports, so the existing ContextIndicator lights up for this lane too.
 *
 * Ported whole from the upstream warm lane (session-usage reader + transcript
 * locator), adapted to byte-light's model catalog (`MODEL_VARIANTS`). The
 * transcript is the CLI's own on-disk record (`~/.claude/projects/<key>/
 * <sessionId>.jsonl`); reading it is observation only — nothing here touches
 * the session, the child process, or the delivery path.
 *
 * Compaction detection rides the same read: Claude Code's native
 * auto-compaction writes `isCompactSummary` entries into its own transcript
 * (that is the whole mechanism — it is CLI-authored, on disk, and never
 * appears in the app DB or any the operator-visible thread). Counting those entries
 * lets the lane notice "a compaction happened since last look" and surface a
 * system-labeled banner + a JSONL line in logs/compaction.log.
 */

import { readFile, appendFile, mkdir } from 'fs/promises';
import { existsSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { MODEL_VARIANTS } from '@bytelight/shared';
import { PROJECT_ROOT } from '../../config.js';
import { laneDirName } from './lane-dir.js';

/** Fallback window when the transcript doesn't identify the model. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

/** Totals summed over one transcript file. `contextTokens` is the gauge —
 *  the window occupancy of the LAST assistant turn, not an accumulation. */
export interface SessionUsage {
  replies: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  contextTokens: number;
  /** Compaction summaries Claude Code has written into this transcript. */
  compactions: number;
  model?: string;
}

/**
 * Claude Code stores transcripts under ~/.claude/projects/<key>/<uuid>.jsonl
 * where <key> is the absolute project dir with every non-alphanumeric replaced
 * by '-'. Keys longer than 200 chars get a hash suffix upstream; house paths
 * never get near that, so the plain form is all we need.
 */
export function projectKeyForDir(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200);
}

/**
 * The transcript Claude Code is currently writing for this lane. The slug
 * comes from the session's own working directory, so this works on any
 * install. Newest by mtime is the live one.
 */
export function latestTranscriptFile(sessionKey: string): { path: string; size: number; mtime: number } | null {
  const projectsDir = join(homedir(), '.claude', 'projects');
  const sessionDir = join(PROJECT_ROOT, 'data', 'heartbeat', laneDirName(sessionKey));
  const heartbeatProjectDir = join(projectsDir, projectKeyForDir(sessionDir));
  if (!existsSync(heartbeatProjectDir)) return null;

  let latest: { path: string; size: number; mtime: number } | null = null;
  try {
    for (const file of readdirSync(heartbeatProjectDir)) {
      if (!file.endsWith('.jsonl')) continue;
      const fpath = join(heartbeatProjectDir, file);
      const st = statSync(fpath);
      if (!latest || st.mtimeMs > latest.mtime) latest = { path: fpath, size: st.size, mtime: st.mtimeMs };
    }
  } catch { return null; }
  return latest;
}

// Transcripts carry resolved dated ids (claude-sonnet-4-5-20250929) while the
// catalog keys the plain form, so after an exact miss the longest catalog id
// that prefixes the dated one is the same model wearing its release date.
export function contextWindowFor(modelId: string): number {
  const exact = MODEL_VARIANTS.find(v => v.modelApiId === modelId);
  if (exact) return exact.contextWindow;
  const prefixed = MODEL_VARIANTS
    .filter(v => modelId.startsWith(v.modelApiId))
    .sort((a, b) => b.modelApiId.length - a.modelApiId.length)[0];
  return prefixed?.contextWindow ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
}

// When a session ends on an error rather than a reply — a usage cap, a 529 —
// Claude Code appends one last assistant entry modelled as '<synthetic>' with
// an all-zero usage block. It is a death certificate, not a turn: counting it
// as a reply inflates the count, and letting it be the LAST entry seen makes
// it the one that names the model.
const SYNTHETIC_MODEL = '<synthetic>';

// A finished transcript never changes again, so its totals are computed once
// and kept. Keyed on size+mtime so a file that DOES grow is recounted.
const usageCache = new Map<string, { key: string; usage: SessionUsage }>();

/** Sum a whole transcript. The full read is affordable (measured upstream:
 *  221 MB across 20 sessions in 0.69s) even before the cache takes it to
 *  nothing on repeat looks at an unchanged file. */
export async function readSessionUsage(filePath: string, size: number, mtime: number): Promise<SessionUsage | undefined> {
  const key = `${size}:${mtime}`;
  const hit = usageCache.get(filePath);
  if (hit && hit.key === key) return hit.usage;

  const usage: SessionUsage = {
    replies: 0, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: 0,
    compactions: 0,
  };
  try {
    const raw = await readFile(filePath, 'utf8');
    for (const line of raw.split('\n')) {
      // Compaction marker — Claude Code's own summary entry, flagged in place.
      if (line.includes('"isCompactSummary":true')) usage.compactions += 1;
      // Cheap reject before the parse — most lines are tool traffic.
      if (!line.includes('"usage"')) continue;
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }
      const u = entry?.type === 'assistant' ? entry.message?.usage : undefined;
      if (!u) continue;
      if (entry.message?.model === SYNTHETIC_MODEL) {
        continue; // never a reply, never the model, never the context
      }
      usage.replies += 1;
      usage.inputTokens += u.input_tokens || 0;
      usage.outputTokens += u.output_tokens || 0;
      usage.cacheReadTokens += u.cache_read_input_tokens || 0;
      usage.cacheWriteTokens += u.cache_creation_input_tokens || 0;
      // Overwritten each time, so the last assistant message wins: the size of
      // the window at the end, not an accumulation of every prompt in it.
      usage.contextTokens =
        (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (typeof entry.message?.model === 'string') usage.model = entry.message.model;
    }
  } catch {
    return undefined;
  }
  if (!usage.replies) return undefined;
  usageCache.set(filePath, { key, usage });
  return usage;
}

/**
 * Token totals as of a lane's last recorded turn, so the next one can be
 * filed as a DELTA — the transcript only ever gives running totals; a usage
 * row wants what this turn added. Keyed with the transcript path because a
 * recycle starts a new file and the totals drop to zero.
 */
export interface UsageBaseline {
  path: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * What one turn added, derived from running totals against the previous
 * baseline. Ported from Aerie 18ec6725's inline delta rule verbatim;
 * extracted to a pure function only because byte-light's lane state lives in
 * a per-lane Map inside the runtime, out of a unit test's reach — the
 * fixture tests the acceptance criteria demand run against this function.
 *
 * A recycle starts a new transcript, so totals drop back to zero. Same file
 * and a smaller number means the same thing — treat it as a fresh baseline
 * rather than filing a negative turn.
 */
export function computeUsageDelta(
  prev: UsageBaseline | undefined,
  usage: SessionUsage,
  path: string,
): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } {
  const fresh = !prev || prev.path !== path || prev.outputTokens > usage.outputTokens;
  return {
    inputTokens: fresh ? usage.inputTokens : usage.inputTokens - prev.inputTokens,
    outputTokens: fresh ? usage.outputTokens : usage.outputTokens - prev.outputTokens,
    cacheReadTokens: fresh ? usage.cacheReadTokens : usage.cacheReadTokens - prev.cacheReadTokens,
    cacheWriteTokens: fresh ? usage.cacheWriteTokens : usage.cacheWriteTokens - prev.cacheWriteTokens,
  };
}

/** One line per observed compaction, appended to logs/compaction.log —
 *  the durable record behind the transient banner. Best-effort by design. */
export async function logCompaction(sessionKey: string, preTokens: number, postTokens: number): Promise<void> {
  try {
    const logPath = join(PROJECT_ROOT, 'logs', 'compaction.log');
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, JSON.stringify({
      ts: new Date().toISOString(),
      lane: sessionKey,
      preTokens,
      postTokens,
    }) + '\n', 'utf8');
  } catch { /* the banner is the point; the log is the backup */ }
}

/** Test-only: clear the finished-transcript cache between cases. */
export function __resetUsageCacheForTests(): void {
  usageCache.clear();
}
