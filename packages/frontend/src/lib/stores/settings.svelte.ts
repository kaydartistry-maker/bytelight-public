import type { SystemStatus, OrchestratorTaskStatus, TriggerStatus } from '@bytelight/shared';
import { apiFetch } from '../utils/api.js';

// State
let systemStatus = $state<SystemStatus | null>(null);
let config = $state<Record<string, string>>({});
let failsafe = $state<{ enabled: boolean; gentle: number; concerned: number; emergency: number }>({
  enabled: true, gentle: 120, concerned: 720, emergency: 1440,
});
let triggers = $state<TriggerStatus[]>([]);
let orchestratorTasks = $state<OrchestratorTaskStatus[]>([]);
let loading = $state(false);

// Runtime health — populated lazily on Settings → Runtime Health mount via
// loadRuntimeHealth(). Null until first fetch. (Ported from reference implementation/reference implementation.)
interface RuntimeHealth {
  activeRuntimeVersion: string | null;
  installedRuntimeVersion: string | null;
  systemCcVersion: string | null;
  minRequired: { version: string; reason: string } | null;
  restartRequired: boolean;
}
let runtimeHealth = $state<RuntimeHealth | null>(null);

// Load settings + orchestrator status + failsafe via REST
export async function loadSettings(): Promise<void> {
  loading = true;
  try {
    // Cap each initial fetch so a transit stall can never pend forever — on
    // timeout the fetch rejects, Promise.all rejects, and the existing catch
    // below handles it exactly like any other network failure (no rethrow).
    const initTimeout = () => ({ signal: AbortSignal.timeout(10000) });
    const [configRes, orchRes, failsafeRes, triggersRes, prefsRes, wakePromptsRes] = await Promise.all([
      apiFetch('/api/settings', initTimeout()),
      apiFetch('/api/orchestrator/status', initTimeout()),
      apiFetch('/api/orchestrator/failsafe', initTimeout()),
      apiFetch('/api/orchestrator/triggers', initTimeout()),
      apiFetch('/api/preferences', initTimeout()),
      apiFetch('/api/orchestrator/wake-prompts', initTimeout()),
    ]);

    // Parse preferences first so we can seed agent.model into config below
    // (preferences resolves DB → YAML → env → default on the backend)
    let prefs: { agent?: { model?: string } } | null = null;
    if (prefsRes.ok) {
      try {
        prefs = await prefsRes.json();
      } catch (err) {
        console.warn('Failed to parse /api/preferences response:', err);
      }
    } else {
      console.warn('Failed to fetch /api/preferences:', prefsRes.status);
    }

    if (configRes.ok) {
      const data = await configRes.json();
      config = data.config || {};
      // If DB config doesn't have agent.model, seed from preferences so the
      // ModelSelector header pill reflects the real active model on load.
      if (!config['agent.model'] && prefs?.agent?.model) {
        config = { ...config, 'agent.model': prefs.agent.model };
      }
    }

    if (orchRes.ok) {
      const data = await orchRes.json();
      orchestratorTasks = data.tasks || [];
      if (systemStatus) {
        systemStatus = { ...systemStatus, orchestratorTasks: data.tasks };
      }
    }

    if (failsafeRes.ok) {
      const data = await failsafeRes.json();
      failsafe = data;
    }

    if (triggersRes.ok) {
      const data = await triggersRes.json();
      triggers = data.triggers || [];
    }

    // Wake prompts ride the same proven mount-load as the siblings above,
    // so the map is hydrated before the Orchestrator tab is ever opened.
    if (wakePromptsRes.ok) {
      ingestWakePromptReport(await wakePromptsRes.json());
    } else {
      console.warn('[wake-prompts] load failed:', wakePromptsRes.status);
    }
  } catch (err) {
    console.error('Failed to load settings:', err);
  } finally {
    loading = false;
  }
}

// Update a single config value
export async function updateSetting(key: string, value: string): Promise<boolean> {
  try {
    const res = await apiFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    });
    if (res.ok) {
      config = { ...config, [key]: value };
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Set a config value locally without API call (for syncing from preferences)
export function setConfigLocal(key: string, value: string): void {
  config = { ...config, [key]: value };
}

// Toggle orchestrator task
export async function toggleTask(wakeType: string, enabled: boolean): Promise<boolean> {
  try {
    const res = await apiFetch(`/api/orchestrator/tasks/${wakeType}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.tasks) {
        orchestratorTasks = data.tasks;
        if (systemStatus) {
          systemStatus = { ...systemStatus, orchestratorTasks: data.tasks };
        }
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Reschedule orchestrator task
export async function rescheduleTask(wakeType: string, cronExpr: string): Promise<boolean> {
  try {
    const res = await apiFetch(`/api/orchestrator/tasks/${wakeType}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cronExpr }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.tasks) {
        orchestratorTasks = data.tasks;
        if (systemStatus) {
          systemStatus = { ...systemStatus, orchestratorTasks: data.tasks };
        }
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// --- Per-wake prompt view/edit ---

export interface WakePromptEntry {
  body: string;
  source: 'file' | 'default';
  hasDefault: boolean;
}

let wakePrompts = $state<Record<string, WakePromptEntry>>({});

export function getWakePrompt(wakeType: string): WakePromptEntry | undefined {
  return wakePrompts[wakeType];
}

function ingestWakePromptReport(data: unknown): void {
  const prompts = (data as { prompts?: Array<WakePromptEntry & { wakeType: string }> })?.prompts;
  if (!Array.isArray(prompts)) return;
  const map: Record<string, WakePromptEntry> = {};
  for (const p of prompts) {
    map[p.wakeType] = { body: p.body, source: p.source, hasDefault: p.hasDefault };
  }
  wakePrompts = map;
}

export async function loadWakePrompts(): Promise<void> {
  try {
    const res = await apiFetch('/api/orchestrator/wake-prompts');
    if (!res.ok) {
      console.warn('[wake-prompts] refresh failed:', res.status);
      return;
    }
    ingestWakePromptReport(await res.json());
  } catch (err) {
    console.error('[wake-prompts] refresh threw:', err);
  }
}

export async function saveWakePrompt(wakeType: string, content: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`/api/orchestrator/wake-prompts/${wakeType}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    const data = await res.json().catch(() => null);
    if (res.ok) {
      ingestWakePromptReport(data);
      return { ok: true };
    }
    return { ok: false, error: (data as { error?: string })?.error || 'Failed to save prompt' };
  } catch {
    return { ok: false, error: 'Failed to save prompt' };
  }
}

export async function resetWakePrompt(wakeType: string): Promise<boolean> {
  try {
    const res = await apiFetch(`/api/orchestrator/wake-prompts/${wakeType}`, { method: 'DELETE' });
    if (!res.ok) return false;
    ingestWakePromptReport(await res.json());
    return true;
  } catch {
    return false;
  }
}

// Update failsafe thresholds
export async function updateFailsafe(update: { enabled?: boolean; gentle?: number; concerned?: number; emergency?: number }): Promise<boolean> {
  try {
    const res = await apiFetch('/api/orchestrator/failsafe', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
    });
    if (res.ok) {
      const data = await res.json();
      failsafe = { enabled: data.enabled, gentle: data.gentle, concerned: data.concerned, emergency: data.emergency };
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Called from websocket store when system_status message arrives
// mcpServers param allows partial update from mcp_status_updated events
export function setSystemStatus(status: SystemStatus | null, mcpServers?: import('@bytelight/shared').McpServerInfo[]): void {
  if (status) {
    systemStatus = status;
  }
  if (mcpServers && systemStatus) {
    systemStatus = { ...systemStatus, mcpServers };
  }
}

// Create a trigger (impulse or watcher)
export async function createTriggerApi(payload: {
  kind: 'impulse' | 'watcher';
  label: string;
  conditions: Array<Record<string, unknown>>;
  prompt?: string;
  cooldownMinutes?: number;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch('/api/orchestrator/triggers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.trigger) {
      triggers = [data.trigger, ...triggers];
      return { ok: true };
    }
    return { ok: false, error: data?.error || 'Failed to create trigger' };
  } catch {
    return { ok: false, error: 'Failed to create trigger' };
  }
}

// Cancel a trigger
export async function cancelTriggerById(id: string): Promise<boolean> {
  try {
    const res = await apiFetch(`/api/orchestrator/triggers/${id}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      triggers = triggers.filter(t => t.id !== id);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Runtime health (ported from reference implementation/reference implementation). Fetched lazily on the
// Settings → Runtime Health tab mount, and again after a successful SDK
// update so the installed version reflects the new on-disk value.
export async function loadRuntimeHealth(): Promise<void> {
  try {
    const res = await apiFetch('/api/runtime/health');
    if (res.ok) {
      runtimeHealth = await res.json();
    }
  } catch (err) {
    console.error('Failed to load runtime health:', err);
  }
}

// Trigger an SDK update. Destructive — modifies package-lock.json and
// requires a backend restart for the new bundled runtime to load.
// Returns the parsed response (success + new versions) or an error
// object with stderr/stdout tails on failure.
export interface SdkUpdateResult {
  success: boolean;
  newInstalledVersion?: string | null;
  activeVersion?: string | null;
  restartRequired?: boolean;
  message?: string;
  error?: string;
  stderrTail?: string;
  stdoutTail?: string;
}

export async function updateSdk(): Promise<SdkUpdateResult> {
  try {
    const res = await apiFetch('/api/runtime/update-sdk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    return await res.json();
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Getters
export function getRuntimeHealth() { return runtimeHealth; }
export function getSystemStatus() { return systemStatus; }
export function getConfig() { return config; }
export function getFailsafe() { return failsafe; }
export function getTriggers() { return triggers; }
export function getOrchestratorTasks() { return orchestratorTasks; }
export function isLoading() { return loading; }
export function getCompanionName(): string {
  if (typeof localStorage !== 'undefined') {
    return localStorage.getItem('bytelight-companion-name') ?? 'Companion';
  }
  return 'Companion';
}
