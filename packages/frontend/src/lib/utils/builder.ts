/** Builder API shapes and presentation logic. No telemetry or persistent browser storage. */
export const BUILDER_STATUSES = ['queued', 'running', 'stopping', 'succeeded', 'failed', 'stopped', 'orphaned'] as const;
export type BuilderStatus = typeof BUILDER_STATUSES[number];
export type BuilderPhase = 'queued' | 'preparing' | 'coding' | 'stopping' | 'succeeded' | 'failed' | 'stopped' | 'orphaned' | 'cleanup-uncertain' | (string & {});
export interface BuilderJob {
  id: string; task: string; mode: 'edit' | 'inspect'; status: BuilderStatus; branch: string;
  currentPhase: BuilderPhase; command: string | null; changedFiles: string[]; report: string | null; error: string | null;
  deployment?: BuilderDeployment;
  created: string; updated: string; started: string | null; finished: string | null;
}
export interface BuilderEvent { at: string; type: string; message: string; }
export interface BuilderLogs { events: BuilderEvent[]; cursor: number; truncated: boolean; }
export const MAX_BUILDER_EVENTS = 500, MAX_BUILDER_CHARS = 100_000;
export const activeBuilder = (status: BuilderStatus): boolean => ['queued', 'running', 'stopping'].includes(status);
export const statusLabel: Record<BuilderStatus, string> = { queued: 'Queued', running: 'Working', stopping: 'Stopping', succeeded: 'Complete', failed: 'Failed', stopped: 'Stopped', orphaned: 'Needs a look' };
export function isJobId(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value); }
export function safeBuilderText(value: string): string {
  return value.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[redacted private key]')
    .replace(/(\b[A-Z_][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s;]+)/g, '$1[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]+)\b/g, '[redacted]')
    .replace(/((?:authorization|api[_-]?key|password|secret|token)\s*["']?\s*[:=]\s*["']?(?:Bearer\s+)?)[^\s,"';}]+/gi, '$1[redacted]')
    .replace(/\/srv\/virelle-builder-jobs\/[a-f0-9]{32}/g, '[job workspace]')
    .replace(/\/var\/lib\/virelle-builder\/jobs(?:\/[^\s"']*)?/g, '[builder state]');
}
export function parseBuilderJob(raw: unknown): BuilderJob | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isJobId(r.id) || !BUILDER_STATUSES.includes(r.status as BuilderStatus) || typeof r.task !== 'string') return null;
  const text = (key: string) => typeof r[key] === 'string' ? safeBuilderText((r[key] as string).slice(0, 24000)) : null;
  // Deliberately omit worker IDs, owner/session metadata, roots and workspace paths.
  return { id: r.id, status: r.status as BuilderStatus, task: text('task')!, mode: r.mode === 'inspect' ? 'inspect' : 'edit',
    branch: text('branch') || '', currentPhase: text('currentPhase') || 'queued', command: text('command'),
    changedFiles: Array.isArray(r.changedFiles) ? r.changedFiles.filter((s): s is string => typeof s === 'string').slice(0, 1000).map(s => safeBuilderText(s.slice(0, 500))) : [],
    ...(parseBuilderDeployment(r.deployment, r.id) ? { deployment: parseBuilderDeployment(r.deployment, r.id)! } : {}),
    report: text('report'), error: text('error'), created: text('created') || '', updated: text('updated') || '', started: text('started'), finished: text('finished') };
}
export function appendBuilderLogs(previous: BuilderLogs, batch: { events: BuilderEvent[]; cursor: number }): BuilderLogs {
  if (!Number.isSafeInteger(batch.cursor) || batch.cursor < previous.cursor || (batch.events.length && batch.cursor === previous.cursor)) throw new Error('Invalid builder log cursor');
  const events = [...previous.events, ...batch.events.map(e => ({ ...e, message: safeBuilderText(e.message).slice(0, 8000) }))];
  let chars = events.reduce((n, e) => n + e.message.length, 0), trimmed = 0;
  while (events.length > MAX_BUILDER_EVENTS || chars > MAX_BUILDER_CHARS) { chars -= events.shift()!.message.length; trimmed++; }
  return { events, cursor: batch.cursor, truncated: previous.truncated || trimmed > 0 };
}
export function builderPollDelay(open: boolean, jobs: BuilderJob[], unavailable = false): number | null {
  if (unavailable) return null;
  return open ? 1800 : jobs.some(j => activeBuilder(j.status) || activeDeployment(j.deployment?.status)) ? 12000 : null;
}
export function elapsedBuilder(job: BuilderJob, now: number): string {
  const start = Date.parse(job.started || job.created), end = job.finished ? Date.parse(job.finished) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '—';
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
export interface BuilderToolCard { id: string | null; status: BuilderStatus | null; task: string; pending: boolean; error: boolean; deployment?: BuilderDeployment; }
function objectValue(value: unknown): Record<string, unknown> | null {
  try { const r = typeof value === 'string' ? JSON.parse(value) : value; return r && typeof r === 'object' && !Array.isArray(r) ? r : null; } catch { return null; }
}
export function builderToolCard(name: string, input?: unknown, output?: unknown, isError = false): BuilderToolCard | null {
  // Only known tool names and JSON envelopes; never infer jobs from model prose.
  if (!/^(?:mcp__bytelight__|bytelight\/)?builder_(start|status|stop|prepare_deploy|deploy|deploy_status|rollback)$/.test(name)) return null;
  const args = objectValue(input), envelope = objectValue(output);
  let result = envelope;
  for (let depth = 0; result && depth < 5; depth++) {
    if (parseBuilderJob(result) || parseBuilderDeployment(result)) break;
    if ('result' in result) result = objectValue(result.result);
    else if (result.structuredContent) result = objectValue(result.structuredContent);
    else if (Array.isArray(result.content) && result.content.length === 1 && result.content[0]?.type === 'text') result = objectValue(result.content[0].text);
    else break;
  }
  const job = parseBuilderJob(result), deployment = job?.deployment || parseBuilderDeployment(result) || undefined;
  return { ...(deployment ? { deployment } : {}), id: job?.id || deployment?.jobId || (isJobId(args?.id) ? args.id : null), status: job?.status || null,
    task: job?.task || (typeof args?.task === 'string' ? safeBuilderText(args.task).slice(0, 180) : 'Builder release'),
    pending: !output, error: isError || !!result?.error && !job && !deployment || envelope?.ok === false };
}

export const DEPLOYMENT_STATUSES = ['not_prepared', 'preparing', 'prepared', 'deploying', 'deployed', 'rolling_back', 'rolled_back', 'failed', 'recovery_required'] as const;
export type DeploymentStatus = typeof DEPLOYMENT_STATUSES[number];
export type ReleaseAction = 'prepare' | 'deploy' | 'rollback';
export interface BuilderDeployment {
  id: string | null; jobId: string; status: DeploymentStatus; commit: string; base: string; phase: string;
  created: string; updated: string; error: string | null; rollback: string | null; database: string | null; healthy: boolean;
}
export const deploymentLabel: Record<DeploymentStatus, string> = { not_prepared: 'Not prepared', preparing: 'Preparing release', prepared: 'Ready to deploy', deploying: 'Deploying', deployed: 'Deployed', rolling_back: 'Rolling back', rolled_back: 'Previous release restored', failed: 'Release blocked', recovery_required: 'Needs inspection' };
export const activeDeployment = (status?: DeploymentStatus): boolean => !!status && ['preparing', 'deploying', 'rolling_back'].includes(status);
export function parseBuilderDeployment(raw: unknown, jobId?: string): BuilderDeployment | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!DEPLOYMENT_STATUSES.includes(r.status as DeploymentStatus) || !isJobId(r.jobId) || jobId && jobId !== r.jobId) return null;
  if (r.status !== 'not_prepared' && (typeof r.id !== 'string' || !/^[a-f0-9]{64}$/.test(r.id))) return null;
  const text = (key: string): string | null => typeof r[key] === 'string' ? safeReleaseText((r[key] as string).slice(0, 24000)) : null;
  const commit = (key: string) => typeof r[key] === 'string' && /^[a-f0-9]{40,64}$/.test(r[key] as string) ? r[key] as string : '';
  const health = r.health as Record<string, unknown> | undefined;
  // Omit worker/process identities, filesystem roots, tree hashes and provenance.
  return { id: r.status === 'not_prepared' ? null : r.id as string, jobId: r.jobId, status: r.status as DeploymentStatus,
    commit: commit('commit'), base: commit('base'), phase: text('phase') || '', created: text('created') || '', updated: text('updated') || '',
    error: text('error'), rollback: text('rollback'), database: text('database'), healthy: !!health && Number.isSafeInteger(health.pid) && Number.isSafeInteger(health.restarts) };
}
export function safeReleaseText(value: string): string {
  return safeBuilderText(value).replace(/\/(?:root|srv|var\/lib|home|tmp)\/[\w./@+-]+/g, '[private path]').replace(/\b[a-f0-9]{32,64}\b/g, value => value.slice(0, 8));
}
export function releaseActionAllowed(job: BuilderJob | undefined, release: BuilderDeployment | null, action: ReleaseAction): boolean {
  if (job?.status !== 'succeeded' || activeDeployment(release?.status) || release?.status === 'recovery_required') return false;
  if (action === 'prepare') return !release || ['not_prepared', 'failed'].includes(release.status);
  return action === 'deploy' ? release?.status === 'prepared' : release?.status === 'deployed';
}
export function releaseConfirmation(job: BuilderJob, release: BuilderDeployment | null, action: ReleaseAction): { key: string; title: string; message: string } {
  const identity = `job ${job.id.slice(0, 8)}${release?.commit ? ` · commit ${release.commit.slice(0, 8)}` : ''}`;
  const key = `${job.id}:${action}:${release?.id || 'none'}:${release?.status || 'not_prepared'}:${release?.commit || ''}`;
  return { key, title: `${action === 'prepare' ? 'Prepare release' : action === 'deploy' ? 'Deploy release' : 'Restore previous release'}?`,
    message: action === 'prepare' ? `Validate and build ${identity}? Production stays unchanged.` : action === 'deploy' ? `Deploy ${identity}? The app will briefly stop for a backup and promotion. Health checks automatically restore the previous code and dependencies if needed.` : `Roll back ${identity} to ${release?.base ? `commit ${release.base.slice(0, 8)}` : 'its retained predecessor'}? The app will briefly stop. Database writes and additive schema changes are kept.` };
}
export function deploymentElapsed(release: BuilderDeployment, now: number): string {
  return elapsedBuilder({ started: release.created, created: release.created, finished: activeDeployment(release.status) ? null : release.updated } as BuilderJob, now);
}
