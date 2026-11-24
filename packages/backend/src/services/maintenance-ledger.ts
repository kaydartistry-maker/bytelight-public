import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import crypto from 'crypto';

export type MaintenanceStage = 'found' | 'fixed' | 'built' | 'waiting_for_restart' | 'verified_live' | 'blocked';
export type MaintenanceKind = 'night_watch' | 'deep_work' | 'house_health' | 'startup';

export interface MaintenanceEntry {
  id: string;
  kind: MaintenanceKind;
  title: string;
  summary: string;
  stage: MaintenanceStage;
  checks: string[];
  restartRequired: boolean;
  commit: string | null;
  builtAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type NewMaintenanceEntry = Pick<MaintenanceEntry, 'kind' | 'title' | 'summary' | 'stage'> & Partial<Pick<MaintenanceEntry, 'checks' | 'restartRequired' | 'commit' | 'builtAt'>>;

const STAGES = new Set<MaintenanceStage>(['found', 'fixed', 'built', 'waiting_for_restart', 'verified_live', 'blocked']);
const KINDS = new Set<MaintenanceKind>(['night_watch', 'deep_work', 'house_health', 'startup']);
const MAX_ENTRIES = 100;

function file(root: string): string { return join(root, 'maintenance', 'ledger.json'); }
function clean(value: unknown, max: number): string { return String(value ?? '').trim().slice(0, max); }

function read(root: string): MaintenanceEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(file(root), 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((entry): entry is MaintenanceEntry => !!entry && typeof entry.id === 'string') : [];
  } catch { return []; }
}

function write(root: string, entries: MaintenanceEntry[]): void {
  const target = file(root); mkdirSync(join(root, 'maintenance'), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(entries.slice(0, MAX_ENTRIES), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, target);
}

export function listMaintenanceEntries(root: string): MaintenanceEntry[] { return read(root).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_ENTRIES); }

export function appendMaintenanceEntry(root: string, input: NewMaintenanceEntry): MaintenanceEntry {
  if (!KINDS.has(input.kind)) throw new Error('Invalid maintenance kind');
  if (!STAGES.has(input.stage)) throw new Error('Invalid maintenance stage');
  const title = clean(input.title, 120), summary = clean(input.summary, 1200);
  if (!title || !summary) throw new Error('Maintenance title and summary are required');
  const now = new Date().toISOString();
  const entry: MaintenanceEntry = {
    id: crypto.randomUUID(), kind: input.kind, title, summary, stage: input.stage,
    checks: (Array.isArray(input.checks) ? input.checks : []).map((v) => clean(v, 240)).filter(Boolean).slice(0, 12),
    restartRequired: input.restartRequired === true,
    commit: input.commit ? clean(input.commit, 64) : null,
    builtAt: input.builtAt && !Number.isNaN(Date.parse(input.builtAt)) ? new Date(input.builtAt).toISOString() : null,
    createdAt: now, updatedAt: now,
  };
  write(root, [entry, ...read(root)]);
  return entry;
}

export interface StartupVerificationOptions {
  compiledAt: Date;
  phoneBuildPath: string | null;
  databaseCheck: () => string;
  scheduleCheck: () => Promise<number>;
}

export async function verifyMaintenanceStartup(root: string, options: StartupVerificationOptions): Promise<MaintenanceEntry> {
  const checks: string[] = [];
  let ok = true;
  try { const result = options.databaseCheck(); ok = ok && result === 'ok'; checks.push(`database: ${result}`); }
  catch (error) { ok = false; checks.push(`database: ${error instanceof Error ? error.message : 'failed'}`); }
  const phoneOk = !!options.phoneBuildPath && existsSync(join(options.phoneBuildPath, 'index.html'));
  ok = ok && phoneOk; checks.push(`phone build: ${phoneOk ? 'present' : 'missing'}`);
  try { const count = await options.scheduleCheck(); ok = ok && count > 0; checks.push(`scheduled tasks: ${count}`); }
  catch (error) { ok = false; checks.push(`scheduled tasks: ${error instanceof Error ? error.message : 'failed'}`); }

  if (ok) {
    const compiledAt = options.compiledAt.getTime();
    const entries = read(root).map((entry) => {
      const builtAt = entry.builtAt ? Date.parse(entry.builtAt) : Number.NaN;
      if (entry.stage === 'waiting_for_restart' && Number.isFinite(builtAt) && builtAt <= compiledAt) {
        return { ...entry, stage: 'verified_live' as const, restartRequired: false, updatedAt: new Date().toISOString(), checks: [...entry.checks, 'startup smoke: verified live'].slice(-12) };
      }
      return entry;
    });
    write(root, entries);
  }

  return appendMaintenanceEntry(root, {
    kind: 'startup', title: ok ? 'Startup verified' : 'Startup needs attention',
    summary: ok ? 'The backend loaded, the database answered, the phone build is present, and scheduled work registered.' : 'One or more startup checks failed; waiting maintenance was not promoted to live.',
    stage: ok ? 'verified_live' : 'blocked', checks, restartRequired: false,
  });
}
