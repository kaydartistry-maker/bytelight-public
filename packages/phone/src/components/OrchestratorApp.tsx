import React, { useEffect, useState } from 'react';
import { CalendarClock, RefreshCw, Loader2, X, Plus } from 'lucide-react';
import { AppShell } from './AppShell';
import { Toggle } from './Toggle';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import { apiFetch } from '../bytelight';
import { normalizeCompanionRows } from '../lib/companion-row';

interface OrchestratorAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  embedded?: boolean;
}

interface TaskStatus {
  wakeType: string;
  label: string;
  cronExpr: string;
  enabled: boolean;
  status: 'scheduled' | 'stopped' | 'running';
  nextRun: string | null;
  category: 'wake' | 'checkin' | 'handoff' | 'failsafe' | 'routine';
  /** A bell the owner made — those are the ones that can be removed. */
  custom?: boolean;
  /** Who the bell belongs to: comma-separated companion slugs, null when shared. */
  companion?: string | null;
}

interface FailsafeConfig {
  enabled: boolean;
  gentle: number;
  concerned: number;
  emergency: number;
}

interface SpontaneousConfig {
  enabled: boolean;
  maxPerDay: number;
  windowStart: number;
  windowEnd: number;
  /** How many rolled wakes are still waiting today — a count, never the times. */
  pendingToday?: number;
}

interface TriggerStatus {
  id: string;
  kind: 'impulse' | 'watcher';
  label: string;
  conditions: string;
  status: string;
  fire_count: number;
  last_fired_at: string | null;
  cooldown_minutes: number;
}

interface WakePromptEntry {
  wakeType: string;
  label: string | null;
  category: string;
  scheduled: boolean;
  enabled: boolean | null;
  cronExpr: string | null;
  source: 'file' | 'default';
  prompt: string;
  defaultPrompt: string | null;
  contract: string;
  /** Main: a built-in default exists to fall back to (reset is meaningful). */
  hasDefault?: boolean;
}

interface WakeOutcome {
  at: string;
  result: 'delivered' | 'silent' | 'timeout' | 'error';
  detail?: string;
}

interface WakePromptReport {
  path: string;
  wakes: WakePromptEntry[];
  unusedSections: Array<{ key: string; body: string }>;
  outcomes: Record<string, WakeOutcome>;
}

// Main's GET/PUT/DELETE /orchestrator/wake-prompts answer
// { prompts: [{ wakeType, body, source, hasDefault }], unusedSections: string[] }
// (routes/orchestrator-routes.ts). The screen was built on an earlier, richer
// report; map main's shape onto it. Main has no per-wake outcomes, so those
// stay empty; an overridden built-in carries its default text for comparison.
function toPromptReport(data: unknown, tasks: TaskStatus[]): WakePromptReport | null {
  const d = data as { prompts?: unknown; unusedSections?: unknown; wakes?: unknown } | null;
  if (d && Array.isArray(d.wakes)) return d as unknown as WakePromptReport; // fork shape
  if (!d || !Array.isArray(d.prompts)) return null;
  const scheduled = new Set(tasks.map((t) => t.wakeType));
  return {
    path: '',
    wakes: (d.prompts as Array<{ wakeType: string; body: string; source: 'file' | 'default'; hasDefault: boolean; defaultPrompt?: string | null }>).map((p) => {
      const task = tasks.find((t) => t.wakeType === p.wakeType);
      return {
        wakeType: p.wakeType,
        label: task?.label ?? null,
        category: task?.category ?? 'wake',
        scheduled: scheduled.has(p.wakeType),
        enabled: task?.enabled ?? null,
        cronExpr: task?.cronExpr ?? null,
        source: p.source,
        prompt: p.body,
        defaultPrompt: p.defaultPrompt ?? null,
        contract: '',
        hasDefault: p.hasDefault,
      };
    }),
    unusedSections: Array.isArray(d.unusedSections)
      ? (d.unusedSections as unknown[]).map((k) => (typeof k === 'string' ? { key: k, body: '' } : (k as { key: string; body: string })))
      : [],
    outcomes: {},
  };
}

const OUTCOME_LABELS: Record<WakeOutcome['result'], string> = {
  delivered: 'delivered',
  silent: 'passed in silence',
  timeout: 'timed out in queue',
  error: 'errored',
};

function outcomeAge(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function cronToTime(cron: string): string {
  const parts = cron.split(' ');
  if (parts.length >= 2) {
    return `${parts[1].padStart(2, '0')}:${parts[0].padStart(2, '0')}`;
  }
  return cron;
}

function timeToCron(time: string): string {
  const [hour, min] = time.split(':');
  return `${parseInt(min, 10)} ${parseInt(hour, 10)} * * *`;
}

function renderConditions(json: string): string {
  try {
    const conditions = JSON.parse(json) as Record<string, unknown>[];
    return conditions
      .map((c) => {
        switch (c.type) {
          case 'presence_state':
            return `User is ${c.state}`;
          case 'presence_transition':
            return `User goes ${c.from} → ${c.to}`;
          case 'agent_free':
            return 'Companion is free';
          case 'time_window':
            return c.before ? `${c.after}–${c.before}` : `After ${c.after}`;
          case 'routine_missing':
            return `${String(c.routine)} missing after ${c.after_hour}:00`;
          default:
            return JSON.stringify(c);
        }
      })
      .join(' + ');
  } catch {
    return json;
  }
}

export function OrchestratorApp({ onClose, themeConfig, themeMode, embedded }: OrchestratorAppProps) {
  const colors = themeConfig[themeMode];
  const [tasks, setTasks] = useState<TaskStatus[]>([]);
  const [failsafe, setFailsafe] = useState<FailsafeConfig | null>(null);
  const [spontaneous, setSpontaneous] = useState<SpontaneousConfig | null>(null);
  const [triggers, setTriggers] = useState<TriggerStatus[]>([]);
  const [promptReport, setPromptReport] = useState<WakePromptReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [editTime, setEditTime] = useState('');
  const [expandedPrompt, setExpandedPrompt] = useState<string | null>(null);
  const [editingPrompt, setEditingPrompt] = useState<string | null>(null);
  const [promptDraft, setPromptDraft] = useState('');
  const [savingPrompt, setSavingPrompt] = useState(false);
  // Who a bell can belong to — the resident companions. An owned bell rings in
  // the shared lane until companions have lanes of their own; the owner is
  // kept and shown either way.
  const [companions, setCompanions] = useState<Array<{ slug: string; name: string }>>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  // Bells the owner makes herself.
  const [newBellOpen, setNewBellOpen] = useState(false);
  const [newBellOwner, setNewBellOwner] = useState('');
  const [newBellName, setNewBellName] = useState('');
  const [newBellTime, setNewBellTime] = useState('09:00');
  const [newBellPrompt, setNewBellPrompt] = useState('');
  const [newBellError, setNewBellError] = useState<string | null>(null);
  const [newBellSaving, setNewBellSaving] = useState(false);
  async function load() {
    setLoading(true);
    try {
      // Each read stands alone: one failing route must not blank the whole screen.
      const json = (r: Response) => (r.ok ? r.json().catch(() => null) : null);
      const [statusRes, failsafeRes, spontaneousRes, triggerRes, promptRes, companionsRes] = await Promise.all([
        apiFetch('/api/orchestrator/status').then(json).catch(() => null),
        apiFetch('/api/orchestrator/failsafe').then(json).catch(() => null),
        apiFetch('/api/orchestrator/spontaneous').then(json).catch(() => null),
        apiFetch('/api/orchestrator/triggers').then(json).catch(() => null),
        apiFetch('/api/orchestrator/wake-prompts').then(json).catch(() => null),
        apiFetch('/api/companions').then(json).catch(() => null),
      ]);
      // The residents of this house (the shared brain), in picker order.
      setCompanions(
        Array.isArray(companionsRes?.companions)
          ? normalizeCompanionRows(companionsRes.companions)
              .filter((c) => !c.brain || c.brain === 'companion-a-b')
              .map((c) => ({ slug: c.slug, name: c.display_name || c.slug }))
          : [],
      );
      const nextTasks: TaskStatus[] = statusRes?.tasks || [];
      setTasks(nextTasks);
      setFailsafe(failsafeRes && typeof failsafeRes.enabled === 'boolean' ? failsafeRes : null);
      setSpontaneous(spontaneousRes && typeof spontaneousRes.enabled === 'boolean' ? spontaneousRes : null);
      setTriggers(triggerRes?.triggers || []);
      setPromptReport(toPromptReport(promptRes, nextTasks));
    } catch (err) {
      console.error('Failed to load orchestrator:', err);
    } finally {
      setLoading(false);
    }
  }

  async function savePromptOverride(wakeType: string) {
    setSavingPrompt(true);
    try {
      const res = await apiFetch(`/api/orchestrator/wake-prompts/${wakeType}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: promptDraft }),
      });
      if (res.ok) {
        const data = await res.json();
        const report = toPromptReport(data, tasks);
        if (report) setPromptReport(report);
        setEditingPrompt(null);
      }
    } catch (err) {
      console.error('Failed to save wake prompt:', err);
    } finally {
      setSavingPrompt(false);
    }
  }

  async function removePromptOverride(wakeType: string, confirmText: string) {
    if (!window.confirm(confirmText)) return;
    setSavingPrompt(true);
    try {
      const res = await apiFetch(`/api/orchestrator/wake-prompts/${wakeType}`, { method: 'DELETE' });
      if (res.ok) {
        const data = await res.json();
        const report = toPromptReport(data, tasks);
        if (report) setPromptReport(report);
        setEditingPrompt(null);
      }
    } catch (err) {
      console.error('Failed to remove wake prompt override:', err);
    } finally {
      setSavingPrompt(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function patchTask(wakeType: string, body: Record<string, unknown>) {
    try {
      const res = await apiFetch(`/api/orchestrator/tasks/${wakeType}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.tasks) setTasks(data.tasks);
      }
    } catch (err) {
      console.error('Failed to update task:', err);
    }
  }

  async function patchFailsafe(partial: Partial<FailsafeConfig>) {
    try {
      const res = await apiFetch('/api/orchestrator/failsafe', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial),
      });
      if (res.ok) {
        const data = await res.json();
        setFailsafe({
          enabled: data.enabled,
          gentle: data.gentle,
          concerned: data.concerned,
          emergency: data.emergency,
        });
      }
    } catch (err) {
      console.error('Failed to update failsafe:', err);
    }
  }

  async function patchSpontaneous(partial: Partial<SpontaneousConfig>) {
    try {
      const res = await apiFetch('/api/orchestrator/spontaneous', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial),
      });
      if (res.ok) {
        const data = await res.json();
        setSpontaneous({
          enabled: data.enabled,
          maxPerDay: data.maxPerDay,
          windowStart: data.windowStart,
          windowEnd: data.windowEnd,
          pendingToday: data.pendingToday,
        });
      }
    } catch (err) {
      console.error('Failed to update spontaneous config:', err);
    }
  }

  async function createBell() {
    const wakeType = newBellName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!wakeType) {
      setNewBellError('Give the bell a name.');
      return;
    }
    if (!newBellPrompt.trim()) {
      setNewBellError('Write what the bell should say when it wakes them.');
      return;
    }
    setNewBellSaving(true);
    setNewBellError(null);
    try {
      const res = await apiFetch('/api/orchestrator/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wakeType,
          cronExpr: timeToCron(newBellTime),
          label: newBellName.trim(),
          prompt: newBellPrompt.trim(),
          companion: newBellOwner || null,
        }),
      });
      const data = await res.json().catch(() => null);
      // An older backend has no route here, so the SPA fallback answers with
      // 200 and an HTML page. res.ok would say yes to a bell that was never
      // hung — the shape of the answer is the only honest check.
      if (!res.ok || !data?.success) {
        setNewBellError(
          data?.error || (res.ok ? 'The house is still running older code — restart it first.' : 'Could not make that bell.'),
        );
        return;
      }
      if (data.tasks) setTasks(data.tasks);
      setNewBellOpen(false);
      setNewBellName('');
      setNewBellPrompt('');
      setNewBellOwner('');
      void load();
    } catch (err) {
      console.error('Failed to create wake:', err);
      setNewBellError('Could not reach the house.');
    } finally {
      setNewBellSaving(false);
    }
  }

  async function deleteBell(wakeType: string, label: string) {
    if (!window.confirm(`Remove the "${label}" bell and its prompt?`)) return;
    try {
      const res = await apiFetch(`/api/orchestrator/tasks/${wakeType}`, { method: 'DELETE' });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        window.alert(data?.error || 'Could not remove that bell — the house may still be running older code.');
        return;
      }
      if (data.tasks) setTasks(data.tasks);
      void load();
    } catch (err) {
      console.error('Failed to delete wake:', err);
    }
  }

  // New-trigger form state. Kept inline (not its own component) because
  // it's small and shares the load() refresh path. The form supports the
  // two most-used condition types — presence_state and time_window —
  // which cover the vast majority of triggers you'd want to author by
  // hand. Anything more exotic (presence_transition, routine_missing)
  // is still createable via the API directly.
  const [showNewTrigger, setShowNewTrigger] = useState(false);
  const [newTrigger, setNewTrigger] = useState({
    kind: 'impulse' as 'impulse' | 'watcher',
    label: '',
    prompt: '',
    conditionType: 'presence_state' as 'presence_state' | 'time_window' | 'agent_free',
    presenceState: 'active' as 'active' | 'idle' | 'offline',
    timeAfter: '09:00',
    timeBefore: '',
    cooldownMinutes: 120,
  });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function createTrigger() {
    if (!newTrigger.label.trim()) {
      setCreateError('Label is required');
      return;
    }
    let conditions: Record<string, unknown>[] = [];
    if (newTrigger.conditionType === 'presence_state') {
      conditions = [{ type: 'presence_state', state: newTrigger.presenceState }];
    } else if (newTrigger.conditionType === 'time_window') {
      conditions = [{
        type: 'time_window',
        after: newTrigger.timeAfter,
        ...(newTrigger.timeBefore ? { before: newTrigger.timeBefore } : {}),
      }];
    } else {
      conditions = [{ type: 'agent_free' }];
    }
    setCreating(true);
    setCreateError(null);
    try {
      const res = await apiFetch('/api/orchestrator/triggers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: newTrigger.kind,
          label: newTrigger.label.trim(),
          conditions,
          prompt: newTrigger.prompt.trim() || undefined,
          cooldownMinutes: newTrigger.cooldownMinutes,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed (${res.status})`);
      }
      setShowNewTrigger(false);
      setNewTrigger((s) => ({ ...s, label: '', prompt: '' }));
      await load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create');
    } finally {
      setCreating(false);
    }
  }

  async function cancelTrigger(id: string) {
    try {
      const res = await apiFetch(`/api/orchestrator/triggers/${id}`, { method: 'DELETE' });
      if (res.ok) setTriggers((prev) => prev.filter((t) => t.id !== id));
    } catch (err) {
      console.error('Failed to cancel trigger:', err);
    }
  }

  const sectionTitle = cn('text-[11px] font-bold uppercase tracking-[0.12em] mb-2 mt-4', colors.textMuted);

  function toggle(on: boolean, onClick: () => void) {
    return <Toggle on={on} onClick={onClick} colors={colors} />;
  }

  function promptEntry(wakeType: string): WakePromptEntry | null {
    return promptReport?.wakes.find((w) => w.wakeType === wakeType) ?? null;
  }

  // Effective-prompt panel: the exact text the orchestrator sends for this
  // wake, where it comes from, and the last real outcome from the log.
  function promptPanel(wakeType: string) {
    const entry = promptEntry(wakeType);
    if (!entry) return null;
    const outcome = promptReport?.outcomes[wakeType];
    const open = expandedPrompt === wakeType;
    const isEditing = editingPrompt === wakeType;

    return (
      <div className="mt-1.5">
        <button
          onClick={() => { setExpandedPrompt(open ? null : wakeType); setEditingPrompt(null); }}
          className="flex w-full items-center gap-1.5"
        >
          <span
            className="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider"
            style={entry.source === 'file'
              ? { background: colors.accent, color: 'var(--bytelight-on-accent)' }
              : { background: 'rgba(127,127,127,0.15)', color: 'var(--bytelight-text)' }}
          >
            {entry.source === 'file' ? 'Custom' : 'Default'}
          </span>
          {outcome && (
            <span className={cn('text-[10px]', colors.textMuted)}>
              Last: {OUTCOME_LABELS[outcome.result]} · {outcomeAge(outcome.at)}
            </span>
          )}
          <span className={cn('text-[10px] ml-auto', colors.textMuted)}>{open ? 'Hide prompt' : 'Prompt'}</span>
        </button>
        {open && (
          <div className="mt-1.5">
            {isEditing ? (
              <>
                <textarea
                  value={promptDraft}
                  onChange={(e) => setPromptDraft(e.target.value)}
                  rows={8}
                  className={cn('w-full rounded-xl border p-2 text-[11px] font-mono bg-transparent', colors.panelBorder, colors.textMain)}
                />
                <div className="flex gap-2 mt-1.5">
                  <button
                    onClick={() => savePromptOverride(wakeType)}
                    disabled={savingPrompt || !promptDraft.trim()}
                    className="rounded-md px-2.5 py-1 text-[11px] font-semibold bytelight-on-accent disabled:opacity-50"
                    style={{ background: colors.accent }}
                  >
                    {savingPrompt ? 'Saving…' : 'Save (live, no restart)'}
                  </button>
                  <button onClick={() => setEditingPrompt(null)} className={cn('px-1.5 py-1 text-[11px]', colors.textMuted)}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <pre className={cn('rounded-xl border p-2 text-[10px] font-mono whitespace-pre-wrap break-words max-h-48 overflow-y-auto', colors.panelBorder, colors.textMuted)}>
                  {entry.prompt}
                </pre>
                <div className="flex gap-2 mt-1.5">
                  <button
                    onClick={() => { setEditingPrompt(wakeType); setPromptDraft(entry.prompt); }}
                    className="rounded-md px-2.5 py-1 text-[11px] font-semibold bytelight-on-accent"
                    style={{ background: colors.accent }}
                  >
                    Edit
                  </button>
                  {entry.source === 'file' && entry.hasDefault !== false && (
                    <button
                      onClick={() => removePromptOverride(
                        wakeType,
                        'Remove the custom override and return this wake to its built-in default prompt?',
                      )}
                      disabled={savingPrompt}
                      className={cn('rounded-md border px-2.5 py-1 text-[11px]', colors.panelBorder, colors.textMuted)}
                    >
                      Reset to default
                    </button>
                  )}
                </div>
                {entry.source === 'file' && entry.defaultPrompt && (
                  <details className="mt-1.5">
                    <summary className={cn('text-[10px] cursor-pointer', colors.textMuted)}>Built-in default for comparison</summary>
                    <pre className={cn('mt-1 rounded-xl border p-2 text-[10px] font-mono whitespace-pre-wrap break-words max-h-40 overflow-y-auto', colors.panelBorder, colors.textMuted)}>
                      {entry.defaultPrompt}
                    </pre>
                  </details>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  /**
   * Who the bell belongs to. Shared is a real choice — some bells belong to
   * everyone. Tapping a companion hands the bell to them alone.
   */
  function ownerRow(task: TaskStatus) {
    if (companions.length === 0) return null;
    const owners = (task.companion || '').split(',').map((s) => s.trim()).filter(Boolean);
    const chip = (label: string, active: boolean, onClick: () => void) => (
      <button
        key={label}
        onClick={onClick}
        className={cn('rounded-full border px-2 py-0.5 text-[11px] transition-colors', colors.panelBorder)}
        style={active ? { background: colors.accent, borderColor: colors.accent } : undefined}
      >
        <span className={active ? 'bytelight-on-accent' : colors.textMuted}>{label}</span>
      </button>
    );
    return (
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {chip('Shared', owners.length === 0, () => patchTask(task.wakeType, { companion: null }))}
        {companions.map((c) => chip(c.name, owners.includes(c.slug), () => patchTask(task.wakeType, { companion: c.slug })))}
      </div>
    );
  }

  function taskRow(task: TaskStatus) {
    return (
      <div
        key={task.wakeType}
        className={cn('rounded-xl border p-3 mb-1.5', colors.panelBg, colors.panelBorder)}
        style={{ opacity: task.enabled ? 1 : 0.55 }}
      >
        <div className="flex items-center justify-between">
          <div className="min-w-0 flex-1">
            {renaming === task.wakeType ? (
              <div className="flex items-center gap-1.5">
                <input
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  maxLength={120}
                  autoFocus
                  className={cn('min-w-0 flex-1 rounded-md border px-2 py-0.5 text-sm bg-transparent', colors.panelBorder, colors.textMain)}
                />
                <button
                  onClick={() => { patchTask(task.wakeType, { label: renameDraft }); setRenaming(null); }}
                  className="rounded-md px-2 py-0.5 text-[11px] font-semibold bytelight-on-accent"
                  style={{ background: colors.accent }}
                >
                  Save
                </button>
                <button onClick={() => setRenaming(null)} className={cn('px-1.5 py-0.5 text-[11px]', colors.textMuted)}>
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => { setRenaming(task.wakeType); setRenameDraft(task.label); }}
                className={cn('text-left text-sm', colors.textMain)}
                title="Rename"
              >
                {task.label}
              </button>
            )}
            {editing === task.wakeType ? (
              <div className="flex items-center gap-1.5 mt-1">
                <input
                  type="time"
                  value={editTime}
                  onChange={(e) => setEditTime(e.target.value)}
                  className={cn('rounded-md border px-1.5 py-0.5 text-xs bg-transparent', colors.panelBorder, colors.textMain)}
                />
                <button
                  onClick={() => { patchTask(task.wakeType, { cronExpr: timeToCron(editTime) }); setEditing(null); }}
                  className="rounded-md px-2 py-0.5 text-[11px] font-semibold bytelight-on-accent"
                  style={{ background: colors.accent }}
                >
                  Save
                </button>
                <button onClick={() => setEditing(null)} className={cn('px-1.5 py-0.5 text-[11px]', colors.textMuted)}>
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => { setEditing(task.wakeType); setEditTime(cronToTime(task.cronExpr)); }}
                className="text-xs font-mono mt-0.5"
                style={{ color: colors.accent }}
              >
                {cronToTime(task.cronExpr)}
              </button>
            )}
          </div>
          {toggle(task.enabled, () => patchTask(task.wakeType, { enabled: !task.enabled }))}
        </div>
        {ownerRow(task)}
        {promptPanel(task.wakeType)}
        {task.custom && (
          <div className="mt-1.5 flex justify-end">
            <button
              onClick={() => deleteBell(task.wakeType, task.label)}
              className={cn('px-1.5 py-0.5 text-[11px]', colors.textMuted)}
            >
              Remove
            </button>
          </div>
        )}
      </div>
    );
  }

  const wake = tasks.filter((t) => t.category === 'wake');
  // This house's own bells beyond 'wake' — the check-ins, and the handoff and
  // routines — each get a section, so every bell is on the screen.
  const checkins = tasks.filter((t) => t.category === 'checkin');
  const routines = tasks.filter((t) => (t.category === 'handoff' || t.category === 'routine') && t.wakeType !== 'weekly_reflection');
  const weekly = tasks.filter((t) => t.wakeType === 'weekly_reflection');
  const impulses = triggers.filter((t) => t.kind === 'impulse');
  const watchers = triggers.filter((t) => t.kind === 'watcher');

  return (
    <AppShell
      embedded={embedded}
      title="Orchestrator"
      icon={CalendarClock}
      onClose={onClose}
      themeConfig={themeConfig}
      themeMode={themeMode}
      headerRight={
        <button
          onClick={() => load()}
          className={cn('rounded-full p-2 transition-colors hover:bg-black/10 dark:hover:bg-white/10', colors.textMuted)}
          title="Refresh"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
        </button>
      }
    >
      {loading && tasks.length === 0 ? (
        <div className={cn('text-xs py-6 text-center', colors.textMuted)}>Loading…</div>
      ) : (
        <>
          <div className={sectionTitle} style={{ marginTop: 0 }}>Wakes</div>
          {wake.map(taskRow)}
          {newBellOpen ? (
            <div className={cn('rounded-xl border p-3 mb-1.5', colors.panelBg, colors.panelBorder)}>
              <input
                value={newBellName}
                onChange={(e) => setNewBellName(e.target.value)}
                placeholder="What to call it"
                className={cn('w-full rounded-md border px-2 py-1 text-sm bg-transparent', colors.panelBorder, colors.textMain)}
              />
              <div className="flex items-center gap-1.5 mt-2">
                <input
                  type="time"
                  value={newBellTime}
                  onChange={(e) => setNewBellTime(e.target.value)}
                  className={cn('rounded-md border px-1.5 py-0.5 text-xs bg-transparent', colors.panelBorder, colors.textMain)}
                />
                {companions.length > 0 && (
                  <select
                    value={newBellOwner}
                    onChange={(e) => setNewBellOwner(e.target.value)}
                    className={cn('rounded-md border px-1.5 py-1 text-xs bg-transparent', colors.panelBorder, colors.textMain)}
                  >
                    <option value="">Shared</option>
                    {companions.map((c) => (
                      <option key={c.slug} value={c.slug}>{c.name}</option>
                    ))}
                  </select>
                )}
              </div>
              <textarea
                value={newBellPrompt}
                onChange={(e) => setNewBellPrompt(e.target.value)}
                rows={4}
                placeholder="What the bell says when it wakes them — written to them, not about them."
                className={cn('w-full rounded-md border px-2 py-1 text-xs mt-2 bg-transparent', colors.panelBorder, colors.textMain)}
              />
              {newBellError && (
                <div className="text-[11px] mt-1" style={{ color: '#e85d04' }}>{newBellError}</div>
              )}
              <div className="flex items-center gap-2 mt-2">
                <button
                  onClick={createBell}
                  disabled={newBellSaving}
                  className="rounded-md px-2.5 py-1 text-[11px] font-semibold bytelight-on-accent"
                  style={{ background: colors.accent, opacity: newBellSaving ? 0.6 : 1 }}
                >
                  {newBellSaving ? 'Hanging it…' : 'Hang the bell'}
                </button>
                <button
                  onClick={() => { setNewBellOpen(false); setNewBellError(null); }}
                  className={cn('px-1.5 py-1 text-[11px]', colors.textMuted)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => { setNewBellOpen(true); setNewBellError(null); }}
              className={cn('w-full rounded-xl border border-dashed p-2.5 mb-1.5 text-xs', colors.panelBorder, colors.textMuted)}
            >
              + New bell
            </button>
          )}
          {checkins.length > 0 && (
            <>
              <div className={sectionTitle}>Check-ins</div>
              {checkins.map(taskRow)}
            </>
          )}
          {routines.length > 0 && (
            <>
              <div className={sectionTitle}>Routines</div>
              {routines.map(taskRow)}
            </>
          )}
          {weekly.length > 0 && (
            <>
              <div className={sectionTitle}>Weekly</div>
              {weekly.map(taskRow)}
            </>
          )}

          {/* Spontaneous — the dice. Times are rolled daily and never shown. */}
          {spontaneous && (
            <div className={cn('rounded-2xl border p-3 mt-3 backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
              <div className="flex items-center justify-between mb-2">
                <span className={cn('text-[11px] font-bold uppercase tracking-[0.12em]', colors.textMuted)}>Spontaneous</span>
                {toggle(spontaneous.enabled, () => patchSpontaneous({ enabled: !spontaneous.enabled }))}
              </div>
              {spontaneous.enabled && (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    <label className="flex flex-col gap-1">
                      <span className={cn('text-[10px] uppercase tracking-wide', colors.textMuted)}>Max / day</span>
                      <input
                        type="number"
                        defaultValue={spontaneous.maxPerDay}
                        min={0}
                        max={6}
                        onBlur={(e) => {
                          const num = parseInt(e.target.value, 10);
                          if (!isNaN(num) && num >= 0 && num !== spontaneous.maxPerDay) {
                            patchSpontaneous({ maxPerDay: num });
                          }
                        }}
                        className={cn('rounded-md border px-1.5 py-1 text-xs bg-transparent w-full', colors.panelBorder, colors.textMain)}
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className={cn('text-[10px] uppercase tracking-wide', colors.textMuted)}>From (hr)</span>
                      <input
                        type="number"
                        defaultValue={spontaneous.windowStart}
                        min={0}
                        max={23}
                        onBlur={(e) => {
                          const num = parseInt(e.target.value, 10);
                          if (!isNaN(num) && num !== spontaneous.windowStart) {
                            patchSpontaneous({ windowStart: num });
                          }
                        }}
                        className={cn('rounded-md border px-1.5 py-1 text-xs bg-transparent w-full', colors.panelBorder, colors.textMain)}
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className={cn('text-[10px] uppercase tracking-wide', colors.textMuted)}>To (hr)</span>
                      <input
                        type="number"
                        defaultValue={spontaneous.windowEnd}
                        min={1}
                        max={30}
                        onBlur={(e) => {
                          const num = parseInt(e.target.value, 10);
                          if (!isNaN(num) && num !== spontaneous.windowEnd) {
                            patchSpontaneous({ windowEnd: num });
                          }
                        }}
                        className={cn('rounded-md border px-1.5 py-1 text-xs bg-transparent w-full', colors.panelBorder, colors.textMain)}
                      />
                    </label>
                  </div>
                  <p className={cn('text-[10px] mt-2', colors.textMuted)}>
                    0 to Max wakes land at random times in the window (hours past 24 = after midnight). The dice roll daily; nobody sees the times.
                  </p>
                  {typeof spontaneous.pendingToday === 'number' && (
                    <p className={cn('text-[10px] mt-1', colors.textMuted)}>
                      {spontaneous.pendingToday === 0
                        ? 'Nothing left waiting today.'
                        : `${spontaneous.pendingToday} still waiting today.`}
                    </p>
                  )}
                </>
              )}
              {promptPanel('spontaneous')}
            </div>
          )}

          {/* Home thread: main's routing thread, set from the thread list's
              house marker; wakes can be aimed elsewhere in Integrations →
              Routing. (The old orchestrator.wake_thread_id card is gone —
              main never reads that setting.) */}

          {/* Failsafe */}
          {failsafe && (
            <div className={cn('rounded-2xl border p-3 mt-3 backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
              <div className="flex items-center justify-between mb-2">
                <span className={cn('text-[11px] font-bold uppercase tracking-[0.12em]', colors.textMuted)}>Failsafe</span>
                {toggle(failsafe.enabled, () => patchFailsafe({ enabled: !failsafe.enabled }))}
              </div>
              {failsafe.enabled && (
                <div className="grid grid-cols-3 gap-2">
                  {(['gentle', 'concerned', 'emergency'] as const).map((field) => (
                    <label key={field} className="flex flex-col gap-1">
                      <span className={cn('text-[10px] uppercase tracking-wide capitalize', colors.textMuted)}>{field}</span>
                      <input
                        type="number"
                        defaultValue={failsafe[field]}
                        min={1}
                        onBlur={(e) => {
                          const num = parseInt(e.target.value, 10);
                          if (!isNaN(num) && num > 0 && num !== failsafe[field]) {
                            patchFailsafe({ [field]: num });
                          }
                        }}
                        className={cn('rounded-md border px-1.5 py-1 text-xs bg-transparent w-full', colors.panelBorder, colors.textMain)}
                      />
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Triggers */}
          <div className={cn('rounded-2xl border p-3 mt-3 backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
            <div className="flex items-center justify-between mb-2">
              <span className={cn('text-[11px] font-bold uppercase tracking-[0.12em]', colors.textMuted)}>Triggers</span>
              <button
                onClick={() => setShowNewTrigger((s) => !s)}
                className={cn('flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-semibold uppercase tracking-wider', colors.panelBorder)}
                style={{ color: colors.accent, borderColor: colors.accent }}
              >
                <Plus size={11} />
                {showNewTrigger ? 'Cancel' : 'New'}
              </button>
            </div>

          {showNewTrigger && (
            <div className="space-y-2 mb-3">
              <div className="grid grid-cols-2 gap-2">
                {(['impulse', 'watcher'] as const).map((k) => (
                  <button
                    key={k}
                    onClick={() => setNewTrigger((s) => ({ ...s, kind: k }))}
                    className="rounded-md border px-2 py-1 text-xs"
                    style={newTrigger.kind === k
                      ? { background: colors.accent, color: 'var(--bytelight-on-accent)', borderColor: colors.accent }
                      : { color: 'var(--bytelight-text)' }}
                  >
                    {k === 'impulse' ? 'Impulse (one-shot)' : 'Watcher (recurring)'}
                  </button>
                ))}
              </div>
              <input
                type="text"
                value={newTrigger.label}
                onChange={(e) => setNewTrigger((s) => ({ ...s, label: e.target.value }))}
                placeholder="Label (e.g. Morning nudge)"
                className={cn('w-full rounded-md border px-2 py-1.5 text-xs bg-transparent', colors.panelBorder, colors.textMain)}
              />
              <textarea
                value={newTrigger.prompt}
                onChange={(e) => setNewTrigger((s) => ({ ...s, prompt: e.target.value }))}
                placeholder="Prompt the companion gets when this fires (optional)"
                rows={2}
                className={cn('w-full rounded-md border px-2 py-1.5 text-xs bg-transparent resize-none', colors.panelBorder, colors.textMain)}
              />
              <div className="grid grid-cols-3 gap-1.5">
                {(['presence_state', 'time_window', 'agent_free'] as const).map((c) => (
                  <button
                    key={c}
                    onClick={() => setNewTrigger((s) => ({ ...s, conditionType: c }))}
                    className="rounded-md border px-1 py-1 text-[10px]"
                    style={newTrigger.conditionType === c
                      ? { background: colors.accent, color: 'var(--bytelight-on-accent)', borderColor: colors.accent }
                      : { color: 'var(--bytelight-text)' }}
                  >
                    {c === 'presence_state' ? 'Presence' : c === 'time_window' ? 'Time' : 'Free'}
                  </button>
                ))}
              </div>
              {newTrigger.conditionType === 'presence_state' && (
                <div className="grid grid-cols-3 gap-1.5">
                  {(['active', 'idle', 'offline'] as const).map((p) => (
                    <button
                      key={p}
                      onClick={() => setNewTrigger((s) => ({ ...s, presenceState: p }))}
                      className="rounded-md border px-1 py-1 text-[10px] capitalize"
                      style={newTrigger.presenceState === p
                        ? { background: colors.accent, color: 'var(--bytelight-on-accent)', borderColor: colors.accent }
                        : { color: 'var(--bytelight-text)' }}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              )}
              {newTrigger.conditionType === 'time_window' && (
                <div className="flex items-center gap-2">
                  <input
                    type="time"
                    value={newTrigger.timeAfter}
                    onChange={(e) => setNewTrigger((s) => ({ ...s, timeAfter: e.target.value }))}
                    className={cn('flex-1 rounded-md border px-2 py-1 text-xs bg-transparent', colors.panelBorder, colors.textMain)}
                  />
                  <span className={cn('text-[10px]', colors.textMuted)}>to</span>
                  <input
                    type="time"
                    value={newTrigger.timeBefore}
                    onChange={(e) => setNewTrigger((s) => ({ ...s, timeBefore: e.target.value }))}
                    placeholder="optional"
                    className={cn('flex-1 rounded-md border px-2 py-1 text-xs bg-transparent', colors.panelBorder, colors.textMain)}
                  />
                </div>
              )}
              {newTrigger.kind === 'watcher' && (
                <div className="flex items-center gap-2">
                  <span className={cn('text-[10px]', colors.textMuted)}>Cooldown (min):</span>
                  <input
                    type="number"
                    min={1}
                    value={newTrigger.cooldownMinutes}
                    onChange={(e) => setNewTrigger((s) => ({ ...s, cooldownMinutes: parseInt(e.target.value, 10) || 120 }))}
                    className={cn('w-20 rounded-md border px-2 py-1 text-xs bg-transparent', colors.panelBorder, colors.textMain)}
                  />
                </div>
              )}
              {createError && <p className="text-[10px]" style={{ color: colors.accent, opacity: 0.8 }}>{createError}</p>}
              <button
                onClick={createTrigger}
                disabled={creating || !newTrigger.label.trim()}
                className="w-full rounded-md px-3 py-1.5 text-[11px] font-semibold disabled:opacity-50"
                style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}
              >
                {creating ? <Loader2 size={11} className="animate-spin inline" /> : 'Create trigger'}
              </button>
            </div>
          )}

          {impulses.length === 0 && watchers.length === 0 ? (
            <div className={cn('text-xs py-2', colors.textMuted)}>No active triggers</div>
          ) : (
            <div className="space-y-1.5">
            {[...impulses, ...watchers].map((trigger) => (
              <div
                key={trigger.id}
                className={cn('flex items-start justify-between gap-2 rounded-xl border p-3', colors.panelBorder)}
              >
                <div className="min-w-0 flex-1">
                  <div className={cn('text-sm', colors.textMain)}>{trigger.label}</div>
                  <div className={cn('text-[11px] mt-0.5', colors.textMuted)}>{renderConditions(trigger.conditions)}</div>
                  {trigger.kind === 'watcher' && (
                    <div className={cn('text-[10px] font-mono mt-0.5', colors.textMuted)}>
                      Fired {trigger.fire_count}× · Cooldown {trigger.cooldown_minutes}min
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] uppercase', colors.textMuted)} style={{ background: 'rgba(127,127,127,0.15)' }}>
                    {trigger.status}
                  </span>
                  {(trigger.status === 'pending' || trigger.status === 'waiting') && (
                    <button
                      onClick={() => cancelTrigger(trigger.id)}
                      className={cn('rounded-md p-1 hover:opacity-70', colors.textMuted)}
                      title="Cancel"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
              </div>
            ))}
            </div>
          )}
          </div>

          {/* Other wake prompts — failsafe tiers and the manual wake */}
          {promptReport && (
            <div className={cn('rounded-2xl border p-3 mt-3 backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
              <div className={cn('text-[11px] font-bold uppercase tracking-[0.12em] mb-1', colors.textMuted)}>Other prompts</div>
              {promptReport.wakes
                .filter((w) => !w.scheduled && w.wakeType !== 'spontaneous')
                .sort((a, b) => a.wakeType.localeCompare(b.wakeType))
                .map((w) => (
                  <div key={w.wakeType} className="py-1">
                    <div className={cn('text-xs font-mono', colors.textMain)}>{w.wakeType}</div>
                    {promptPanel(w.wakeType)}
                  </div>
                ))}
            </div>
          )}

          {/* Leftover file sections no wake actually reads */}
          {promptReport && promptReport.unusedSections.length > 0 && (
            <div className={cn('rounded-2xl border p-3 mt-3 backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
              <div className={cn('text-[11px] font-bold uppercase tracking-[0.12em] mb-1', colors.textMuted)}>Unused sections</div>
              <p className={cn('text-[10px] mb-2', colors.textMuted)}>
                These sections exist in the wake prompts file but no bell reads them. Shown for reference only — nothing here edits the file.
              </p>
              <div className="space-y-1.5">
                {promptReport.unusedSections.map((s) => (
                  <div key={s.key} className={cn('rounded-xl border p-2.5', colors.panelBorder)}>
                    <div className="flex items-center justify-between gap-2">
                      <span className={cn('text-xs font-mono', colors.textMain)}>{s.key}</span>
                    </div>
                    <pre className={cn('mt-1 text-[10px] font-mono whitespace-pre-wrap break-words max-h-24 overflow-y-auto', colors.textMuted)}>
                      {s.body}
                    </pre>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </AppShell>
  );
}
