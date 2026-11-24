import { apiFetch } from '../utils/api.js';
import { appendBuilderLogs, builderPollDelay, isJobId, parseBuilderJob, activeBuilder, type BuilderJob, type BuilderLogs, type BuilderEvent, parseBuilderDeployment, activeDeployment, releaseActionAllowed, releaseConfirmation, safeReleaseText, type BuilderDeployment, type ReleaseAction } from '../utils/builder.js';
export type BuilderAvailability = 'loading' | 'ready' | 'disabled' | 'denied' | 'offline';
export class BuilderApiError extends Error { constructor(readonly kind: 'disabled' | 'denied' | 'offline' | 'blocked', message: string = kind) { super(message); } }
export interface BuilderApi {
  list(signal: AbortSignal): Promise<BuilderJob[]>;
  get(id: string, signal: AbortSignal): Promise<BuilderJob>;
  logs(id: string, cursor: number, signal: AbortSignal): Promise<{ events: BuilderEvent[]; cursor: number }>;
  stop(id: string, signal: AbortSignal): Promise<BuilderJob>;
  deployment(id: string, signal: AbortSignal): Promise<BuilderDeployment>;
  deploymentLogs(id: string, cursor: number, signal: AbortSignal): Promise<{ events: BuilderEvent[]; cursor: number }>;
  prepare(id: string, signal: AbortSignal, expected?: BuilderDeployment | null): Promise<BuilderDeployment>;
  deploy(id: string, signal: AbortSignal, expected?: BuilderDeployment | null): Promise<BuilderDeployment>;
  rollback(id: string, signal: AbortSignal, expected?: BuilderDeployment | null): Promise<BuilderDeployment>;
}
export function createBuilderApi(fetcher = apiFetch): BuilderApi {
  async function request(path = '', signal: AbortSignal, stop = false, expected?: BuilderDeployment | null): Promise<Record<string, unknown>> {
    const response = await fetcher(`/api/builder/jobs${path}`, { signal, method: stop ? 'POST' : 'GET', ...(stop ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(expected === undefined ? {} : { expected: { id: expected?.id || null, status: expected?.status || 'not_prepared', commit: expected?.id ? expected.commit : '', base: expected?.id ? expected.base : '' } }) } : {}) });
    if (response.status === 401 || response.status === 403) throw new BuilderApiError('denied');
    const data = await response.json();
    if (!response.ok || data.ok === false) {
      const release = /\/(?:prepare-deploy|deploy|rollback)(?:[/?]|$)/.test(path);
      const message = typeof data.error === 'string' ? safeReleaseText(data.error).slice(0, 1000) : 'Request could not be completed.';
      throw new BuilderApiError(/Builder (?:deployment )?is disabled/i.test(message) ? 'disabled' : response.status >= 500 ? 'offline' : release ? 'blocked' : 'offline', message);
    }
    return data;
  }
  function idPath(id: string): string { if (!isJobId(id)) throw new Error('Invalid job'); return `/${id}`; }
  function job(data: unknown): BuilderJob { const result = parseBuilderJob(data); if (!result) throw new Error('Invalid job response'); return result; }
  function release(data: unknown, id: string): BuilderDeployment { const result = parseBuilderDeployment(data, id); if (!result) throw new Error('Invalid release response'); return result; }
  async function logs(path: string, signal: AbortSignal) {
    const data = await request(path, signal);
    if (!Array.isArray(data.events) || !Number.isSafeInteger(data.cursor)) throw new Error('Invalid logs response');
    return { cursor: data.cursor as number, events: data.events.filter((e): e is BuilderEvent => !!e && typeof e === 'object' && typeof e.at === 'string' && typeof e.type === 'string' && typeof e.message === 'string') };
  }
  return {
    async deployment(id, signal) { return release(await request(`${idPath(id)}/deploy`, signal), id); },
    async deploymentLogs(id, cursor, signal) { return logs(`${idPath(id)}/deploy/logs?cursor=${cursor}`, signal); },
    async prepare(id, signal, expected) { return release(await request(`${idPath(id)}/prepare-deploy`, signal, true, expected), id); },
    async deploy(id, signal, expected) { return release(await request(`${idPath(id)}/deploy`, signal, true, expected), id); },
    async rollback(id, signal, expected) { return release(await request(`${idPath(id)}/rollback`, signal, true, expected), id); },
    async list(signal) { const data = await request('', signal); if (!Array.isArray(data.jobs)) throw new Error('Invalid jobs response'); return data.jobs.map(parseBuilderJob).filter((j): j is BuilderJob => !!j); },
    async get(id, signal) { return job(await request(idPath(id), signal)); },
  async stop(id, signal) { return job(await request(`${idPath(id)}/stop`, signal, true)); },
    async logs(id, cursor, signal) {
      const data = await request(`${idPath(id)}/logs?cursor=${cursor}`, signal);
      if (!Array.isArray(data.events) || !Number.isSafeInteger(data.cursor)) throw new Error('Invalid logs response');
      return { cursor: data.cursor as number, events: data.events.filter((e): e is BuilderEvent => !!e && typeof e === 'object' && typeof e.at === 'string' && typeof e.type === 'string' && typeof e.message === 'string') };
    },
  };
}
export type DeploymentAvailability = 'loading' | 'ready' | 'disabled' | 'blocked' | 'offline';
export interface BuilderState { deployment: BuilderDeployment | null; deploymentLogs: BuilderLogs; deploymentAvailability: DeploymentAvailability; deploymentError: string; releaseError: string; releasePending: { id: string; action: ReleaseAction } | null; jobs: BuilderJob[]; selectedId: string | null; logs: BuilderLogs; availability: BuilderAvailability; error: string; stoppingId: string | null; updatedAt: number; }
const emptyLogs = (): BuilderLogs => ({ events: [], cursor: 0, truncated: false });
/** Serialized polling with generation checks: stale selection/destroy responses cannot win. */
export class BuilderController {
  state: BuilderState = { deployment: null, deploymentLogs: emptyLogs(), deploymentAvailability: 'loading', deploymentError: '', releaseError: '', releasePending: null, jobs: [], selectedId: null, logs: emptyLogs(), availability: 'loading', error: '', stoppingId: null, updatedAt: 0 };
  private listeners = new Set<(state: BuilderState) => void>();
  private cache = new Map<string, BuilderLogs>();
  private releaseCache = new Map<string, { id: string | null; logs: BuilderLogs }>();
  private releaseTimer: ReturnType<typeof setTimeout> | undefined;
  private releaseBusy = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controllers = new Set<AbortController>();
  private lifecycle = 0; private generation = 0; private mounted = false; private open = false; private busy = false; private rerun = false;
  constructor(private api: BuilderApi) {}
  subscribe = (listener: (state: BuilderState) => void) => { this.listeners.add(listener); listener(this.state); return () => this.listeners.delete(listener); };
  private emit(patch: Partial<BuilderState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(this.state); }
  start() { this.mounted = true; void this.refresh(); }
  destroy() { this.mounted = false; this.generation++; clearTimeout(this.timer); clearTimeout(this.releaseTimer); for (const c of this.controllers) c.abort(); this.controllers.clear(); this.lifecycle++; this.busy = false; this.rerun = false; this.releaseBusy = false; this.emit({ stoppingId: null, releasePending: null }); }
  setOpen(open: boolean) { if (this.open === open) return; this.open = open; if (open) { void this.refresh(); void this.refreshRelease(); } else this.schedule(); this.scheduleRelease(); }
  select(id: string) {
    if (!isJobId(id)) return;
    this.generation++; this.emit({ selectedId: id, logs: this.cache.get(id) || emptyLogs(), deployment: this.state.jobs.find(j => j.id === id)?.deployment || null, deploymentLogs: this.releaseCache.get(id)?.logs || emptyLogs(), deploymentAvailability: 'loading', deploymentError: '', releaseError: '', error: '' }); void this.refresh(); void this.refreshRelease();
  }
  private schedule() {
    clearTimeout(this.timer);
    const delay = builderPollDelay(this.open, this.state.jobs, ['disabled', 'denied'].includes(this.state.availability));
    if (this.mounted && delay !== null) this.timer = setTimeout(() => void this.refresh(), delay);
  }
  async refresh(): Promise<void> {
    if (!this.mounted) return;
    if (this.state.stoppingId || this.state.releasePending) { this.rerun = true; return; }
    if (this.busy) { this.rerun = true; return; }
    clearTimeout(this.timer); this.busy = true;
    const lifecycle = this.lifecycle, generation = this.generation, controller = new AbortController(); this.controllers.add(controller);
    let timedOut = false; const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 12000);
    const valid = () => this.mounted && lifecycle === this.lifecycle && generation === this.generation;
    try {
      const keepStopping = (incoming: BuilderJob): BuilderJob => this.state.jobs.some(j => j.id === incoming.id && j.status === 'stopping') && ['queued', 'running'].includes(incoming.status) ? { ...incoming, status: 'stopping' } : incoming;
      let jobs = (await this.api.list(controller.signal)).map(keepStopping); if (!valid()) return;
      const selectedId = this.state.selectedId || jobs.find(j => activeBuilder(j.status))?.id || jobs[0]?.id || null;
      this.emit({ jobs, selectedId, availability: 'ready', error: '', updatedAt: Date.now() });
      void this.refreshRelease();
      if (this.open && selectedId) {
        const selected = keepStopping(await this.api.get(selectedId, controller.signal)); if (!valid()) return;
        jobs = jobs.some(j => j.id === selectedId) ? jobs.map(j => j.id === selectedId ? selected : j) : [selected, ...jobs].slice(0, 100);
        this.emit({ jobs });
        const previous = this.cache.get(selectedId) || emptyLogs();
        const batch = await this.api.logs(selectedId, previous.cursor, controller.signal); if (!valid()) return;
        const logs = appendBuilderLogs(previous, batch); this.cache.delete(selectedId); this.cache.set(selectedId, logs);
        while (this.cache.size > 5) this.cache.delete(this.cache.keys().next().value!);
        this.emit({ logs });
      }
    } catch (error) {
      if (valid() && (!controller.signal.aborted || timedOut)) {
        const availability: BuilderAvailability = error instanceof BuilderApiError && error.kind !== 'blocked' ? error.kind : 'offline';
        if (availability === 'denied' || availability === 'disabled') { this.cache.clear(); this.releaseCache.clear(); this.generation++; clearTimeout(this.releaseTimer); this.emit({ jobs: [], selectedId: null, logs: emptyLogs(), deployment: null, deploymentLogs: emptyLogs(), deploymentError: '', releaseError: '' }); }
        this.emit({ availability, error: availability === 'offline' ? 'Connection interrupted. Retrying shortly; your job keeps working.' : '' });
      }
    } finally {
      clearTimeout(timeout); this.controllers.delete(controller); if (lifecycle !== this.lifecycle) return; this.busy = false;
      if (this.rerun && this.mounted) { this.rerun = false; void this.refresh(); } else this.schedule();
    }
  }
  private scheduleRelease() {
    clearTimeout(this.releaseTimer);
    const selected = this.state.jobs.find(j => j.id === this.state.selectedId);
    const enabled = !['disabled', 'denied'].includes(this.state.availability);
    if (this.mounted && enabled && selected && (this.open && (selected.status === 'succeeded' || selected.deployment) || activeDeployment(this.state.deployment?.status)))
      this.releaseTimer = setTimeout(() => void this.refreshRelease(), this.open ? 1800 : 12000);
  }
  async refreshRelease(): Promise<void> {
    const id = this.state.selectedId, job = this.state.jobs.find(j => j.id === id);
    if (!this.mounted || !id || !job || !['ready', 'offline'].includes(this.state.availability) || job.status !== 'succeeded' && !job.deployment) return;
    if (this.releaseBusy || this.state.releasePending) return;
    if (!this.open && !activeDeployment(this.state.deployment?.status || job.deployment?.status)) return;
    clearTimeout(this.releaseTimer); this.releaseBusy = true;
    const lifecycle = this.lifecycle, generation = this.generation, controller = new AbortController(); this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 12000);
    const valid = () => this.mounted && lifecycle === this.lifecycle && generation === this.generation && id === this.state.selectedId;
    try {
      const release = await this.api.deployment(id, controller.signal); if (!valid()) return;
      const cached = this.releaseCache.get(id), previous = cached?.id === release.id ? cached.logs : emptyLogs();
      this.emit({ deployment: release, deploymentLogs: previous, deploymentAvailability: 'ready', deploymentError: '', jobs: this.state.jobs.map(j => j.id === id ? { ...j, deployment: release } : j) });
      if (this.open && release.id) {
        const batch = await this.api.deploymentLogs(id, previous.cursor, controller.signal); if (!valid()) return;
        const logs = appendBuilderLogs(previous, { ...batch, events: batch.events.map(e => ({ ...e, message: safeReleaseText(e.message) })) });
        this.releaseCache.delete(id); this.releaseCache.set(id, { id: release.id, logs });
        while (this.releaseCache.size > 5) this.releaseCache.delete(this.releaseCache.keys().next().value!);
        this.emit({ deploymentLogs: logs });
      }
    } catch (error) {
      if (valid()) {
        if (error instanceof BuilderApiError && error.kind === 'denied') {
          this.cache.clear(); this.releaseCache.clear(); this.generation++; this.emit({ availability: 'denied', jobs: [], selectedId: null, logs: emptyLogs(), deployment: null, deploymentLogs: emptyLogs(), deploymentError: '', releaseError: '' });
        } else this.emit({ deploymentAvailability: error instanceof BuilderApiError ? error.kind as DeploymentAvailability : 'offline', deploymentError: error instanceof BuilderApiError && error.kind === 'blocked' ? error.message : 'Release status is unavailable. Reconnecting…' });
      }
    } finally { clearTimeout(timeout); this.controllers.delete(controller); if (lifecycle === this.lifecycle) { this.releaseBusy = false; this.scheduleRelease(); } }
  }
  async release(action: ReleaseAction, id: string, confirmationKey: string): Promise<void> {
    const job = this.state.jobs.find(j => j.id === id), release = this.state.deployment;
    if (!job || id !== this.state.selectedId || this.state.releasePending || this.state.deploymentAvailability !== 'ready' || !releaseActionAllowed(job, release, action) || releaseConfirmation(job, release, action).key !== confirmationKey) return;
    const lifecycle = this.lifecycle; this.generation++; const controller = new AbortController(); this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 12000);
    this.emit({ releasePending: { id, action }, deploymentError: '', releaseError: '' });
    try {
      const result = await this.api[action](id, controller.signal, release);
      if (this.mounted && lifecycle === this.lifecycle) {
        this.generation++;
        this.emit({ jobs: this.state.jobs.map(j => j.id === id ? { ...j, deployment: result } : j), ...(this.state.selectedId === id ? { deployment: result, deploymentAvailability: 'ready' as const, deploymentLogs: result.id === release?.id ? this.state.deploymentLogs : emptyLogs() } : {}) });
      }
    } catch (error) {
      if (this.mounted && lifecycle === this.lifecycle && this.state.selectedId === id) {
        if (error instanceof BuilderApiError && error.kind === 'denied') { this.generation++; this.cache.clear(); this.releaseCache.clear(); this.emit({ availability: 'denied', jobs: [], selectedId: null, logs: emptyLogs(), deployment: null, deploymentLogs: emptyLogs() }); }
        else this.emit({ deploymentAvailability: error instanceof BuilderApiError && error.kind === 'disabled' ? 'disabled' : error instanceof BuilderApiError && error.kind === 'blocked' ? 'ready' : 'offline', releaseError: error instanceof BuilderApiError && error.kind === 'blocked' ? error.message : 'Request outcome is not confirmed. Checking status before another action.' });
      }
    } finally {
      clearTimeout(timeout); this.controllers.delete(controller);
      if (this.mounted && lifecycle === this.lifecycle) { this.emit({ releasePending: null }); void this.refreshRelease(); void this.refresh(); }
    }
  }
  async stop(id: string): Promise<void> {
    const job = this.state.jobs.find(j => j.id === id);
    if (!job || !activeBuilder(job.status) || job.status === 'stopping' || this.state.stoppingId) return;
    const lifecycle = this.lifecycle;
    const controller = new AbortController(); this.controllers.add(controller); this.emit({ stoppingId: id, error: '' });
    // Invalidate an older poll so it cannot overwrite the stop acknowledgement.
    this.generation++;
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const stopped = await this.api.stop(id, controller.signal);
      if (this.mounted && lifecycle === this.lifecycle) { this.generation++; this.emit({ jobs: this.state.jobs.map(j => j.id === id ? stopped : j) }); }
    } catch {
      if (this.mounted && lifecycle === this.lifecycle) this.emit({ error: 'Could not confirm the stop request. Refresh status before trying again.' });
    } finally {
      clearTimeout(timeout); this.controllers.delete(controller); if (this.mounted && lifecycle === this.lifecycle) { this.emit({ stoppingId: null }); void this.refresh(); }
    }
  }
}
