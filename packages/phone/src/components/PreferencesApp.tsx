import React, { useEffect, useState } from 'react';
import { SlidersHorizontal, Loader2 } from 'lucide-react';
import { MODEL_VARIANTS, type ProviderId } from '@bytelight/shared';
import { AppShell } from './AppShell';
import { Toggle } from './Toggle';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import { apiFetch } from '../bytelight';
import {
  DEFAULT_BRAIN,
  PROVIDER_ROWS,
  defaultEngineBodies,
  effortChoices,
  effortConfig,
  engineFromEffective,
  initialSplit,
  isStaticProvider,
  modelsForProvider,
  normalizeCatalog,
  providerEnabled,
  saveBlocker,
  switchProvider,
  type Catalogs,
  type HouseTier,
  type ProviderStatus,
  type TierEngine,
} from '../lib/house-engine';

interface PreferencesAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  embedded?: boolean;
}

// Only bites on threads holding more than one companion; a solo thread has
// always had its own lane either way.
const ROOM_MODES = [
  { id: 'false', label: 'One Shared Lane' },
  { id: 'true', label: 'A Lane Each' },
];

const TIMEZONES = [
  'UTC',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin',
  'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Kolkata',
  'Australia/Sydney', 'Pacific/Auckland',
];

// Lanes whose models are discovered rather than shipped with the app.
const FETCHED_PROVIDERS = PROVIDER_ROWS.map((r) => r.id).filter((p) => !isStaticProvider(p));

const BLANK_ENGINE: TierEngine = { provider: 'claude-cli', model: '', effort: 'auto' };

export function PreferencesApp({ onClose, themeConfig, themeMode, embedded }: PreferencesAppProps) {
  const colors = themeConfig[themeMode];
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [companionName, setCompanionName] = useState('');
  const [userName, setUserName] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  // 'false' = every companion in a thread answers out of one shared warm lane.
  // 'true'  = each gets his own lane and the turn is passed between them.
  const [multiLane, setMultiLane] = useState('false');
  // The Room unlocks once every resident companion has a bio — his lane reads it.
  const [multiLaneWaitingOn, setMultiLaneWaitingOn] = useState<string[] | null>(null);

  // The house default engine, per tier. Unified (split off) means the chat
  // engine runs autonomous wakes too and is mirrored onto that row on save.
  const [chat, setChat] = useState<TierEngine>(BLANK_ENGINE);
  const [auto, setAuto] = useState<TierEngine>(BLANK_ENGINE);
  const [split, setSplit] = useState(false);
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [catalogs, setCatalogs] = useState<Catalogs>({});

  async function readTier(tier: HouseTier): Promise<TierEngine | null> {
    try {
      const qs = new URLSearchParams({ companionId: DEFAULT_BRAIN, tier });
      const res = await apiFetch(`/api/companion-settings/effective?${qs.toString()}`);
      if (!res.ok) return null;
      return engineFromEffective(await res.json());
    } catch {
      return null;
    }
  }

  // What each tier resolves to today, with no thread in play. Even with no
  // companion row this answers (system fallback), so the picker always shows
  // the engine that would actually run.
  async function loadEngines(): Promise<void> {
    const [inter, wake] = await Promise.all([readTier('interactive'), readTier('autonomous')]);
    if (inter) setChat(inter);
    if (wake) setAuto(wake);
    setSplit(initialSplit(inter, wake));
  }

  async function loadCatalog(provider: ProviderId): Promise<void> {
    try {
      const res = await apiFetch(`/api/models?provider=${provider}`);
      if (!res.ok) throw new Error(String(res.status));
      const list = normalizeCatalog(await res.json());
      setCatalogs((prev) => ({ ...prev, [provider]: list }));
    } catch {
      setCatalogs((prev) => ({ ...prev, [provider]: 'error' }));
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch('/api/preferences');
        if (!res.ok) throw new Error('load failed');
        const p = await res.json();
        setCompanionName(p.identity?.companion_name || '');
        setUserName(p.identity?.user_name || '');
        setTimezone(p.identity?.timezone || 'UTC');
        setMultiLane(p.agent?.multi_lane === true ? 'true' : 'false');
        setMultiLaneWaitingOn(p.agent?.multi_lane_ready === false ? (p.agent?.multi_lane_waiting_on || []) : null);
        await loadEngines();
      } catch {
        setError('Failed to load preferences');
      } finally {
        setLoading(false);
      }
    })();
    // Availability and catalogs fill in behind the screen; a lane with no
    // status yet shows as checking, a lane still loading shows a spinner.
    void apiFetch('/api/models/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => setStatus(s))
      .catch(() => setStatus(null));
    for (const p of FETCHED_PROVIDERS) void loadCatalog(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // An engine picked before its catalog arrived lands on its first model.
  useEffect(() => {
    for (const [engine, setEngine] of [[chat, setChat], [auto, setAuto]] as const) {
      if (engine.model) continue;
      const models = modelsForProvider(engine.provider, catalogs);
      if (Array.isArray(models) && models[0]) setEngine({ ...engine, model: models[0].id });
    }
  }, [catalogs, chat, auto]);

  async function save() {
    setMessage(null);
    setError(null);
    const blocked = saveBlocker(chat, auto, split);
    if (blocked) { setError(blocked); return; }
    setSaving(true);
    try {
      const effort = effortConfig(chat, auto, split);
      // /api/preferences owns identity, the Room and the effort config. The
      // engine itself lives in the companion default rows written below.
      const updates: Record<string, unknown> = {
        identity: { companion_name: companionName, user_name: userName, timezone },
        agent: {
          ...effort.preferences,
          multi_lane: multiLane === 'true',
        },
      };
      const res = await apiFetch('/api/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Failed to save');
        return;
      }
      for (const body of defaultEngineBodies(chat, auto, split)) {
        const r = await apiFetch('/api/companion-settings/default', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          throw new Error(e.error || `Failed to save the ${body.tier === 'interactive' ? 'chat' : 'autonomous'} engine (${r.status})`);
        }
      }
      // Keep the live effort config in step with the rows (a row's 'auto'
      // falls through to it).
      for (const s of effort.settings) {
        await apiFetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(s),
        }).catch(() => undefined);
      }
      await loadEngines();
      setMessage(data.message || 'Saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save preferences');
    } finally {
      setSaving(false);
    }
  }

  const card = cn('rounded-2xl border p-3 mb-3', colors.panelBg, colors.panelBorder);
  const title = cn('text-[11px] font-bold uppercase tracking-[0.12em] mb-2', colors.textMuted);
  const label = cn('text-[11px] mb-1', colors.textMuted);
  const input = cn('w-full rounded-lg border px-2.5 py-2 text-sm bg-transparent', colors.panelBorder, colors.textMain);
  const selected = { background: colors.accent, color: 'var(--bytelight-on-accent)', borderColor: colors.accent };

  function chips(options: { id: string; label: string }[], value: string, onChange: (v: string) => void) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button
            key={o.id}
            onClick={() => onChange(o.id)}
            className={cn('rounded-lg border px-2.5 py-1.5 text-xs', colors.panelBorder)}
            style={value === o.id ? { background: colors.accent, color: 'var(--bytelight-on-accent)' } : { color: 'var(--bytelight-text)' }}
          >
            {o.label}
          </button>
        ))}
      </div>
    );
  }

  // The picked model's name, or its raw id when no list knows it (getVariant
  // would quietly answer with the default variant instead).
  function modelName(engine: TierEngine): string {
    const list = modelsForProvider(engine.provider, catalogs);
    const listed = Array.isArray(list) && list.find((m) => m.id === engine.model)?.name;
    if (listed) return listed;
    if (isStaticProvider(engine.provider)) {
      const variant = MODEL_VARIANTS.find((v) => v.id === engine.model || v.modelApiId === engine.model);
      if (variant) return variant.label;
    }
    return engine.model;
  }

  // One tier: engine, then that engine's models, then its effort vocabulary.
  function tierPicker(tierLabel: string, caption: string, engine: TierEngine, setEngine: (e: TierEngine) => void) {
    const models = modelsForProvider(engine.provider, catalogs);
    const hasModel = Array.isArray(models) && models.some((m) => m.id === engine.model);
    return (
      <div className={cn('rounded-xl border p-2.5', colors.panelBorder)}>
        <div className="flex items-baseline justify-between gap-2 mb-2">
          <span className={cn('text-sm font-semibold', colors.textMain)}>{tierLabel}</span>
          <span className={cn('text-[10px] truncate', colors.textMuted)}>{caption}</span>
        </div>

        <div className={label}>Engine</div>
        <div className="flex gap-1.5 overflow-x-auto scrollbar-hide pb-0.5 -mx-0.5 px-0.5">
          {PROVIDER_ROWS.map((row) => {
            const { enabled, hint } = providerEnabled(row.id, status);
            const active = engine.provider === row.id;
            return (
              <button
                key={row.id}
                disabled={!enabled && !active}
                onClick={() => { if (!active) setEngine(switchProvider(engine, row.id, modelsForProvider(row.id, catalogs))); }}
                className={cn(
                  'shrink-0 flex flex-col items-center rounded-lg border px-3 py-1.5 text-[11px] font-medium whitespace-nowrap disabled:opacity-40',
                  colors.panelBorder,
                  colors.textMain,
                )}
                style={active ? selected : undefined}
              >
                <span>{row.label}</span>
                {!enabled && hint && <span className="text-[9px] font-normal opacity-80">{hint}</span>}
              </button>
            );
          })}
        </div>

        <div className={cn(label, 'mt-2.5')}>Model</div>
        {models === undefined ? (
          <div className={cn('flex items-center gap-2 py-2 text-xs', colors.textMuted)}>
            <Loader2 size={13} className="animate-spin" /> Loading models…
          </div>
        ) : models === 'error' ? (
          <button onClick={() => void loadCatalog(engine.provider)} className="py-2 text-xs" style={{ color: colors.accent }}>
            Could not load models — tap to retry.
          </button>
        ) : (
          <select
            className={input}
            value={engine.model}
            onChange={(e) => setEngine({ ...engine, model: e.target.value })}
          >
            {!engine.model && <option value="" disabled>{models.length ? 'Pick a model' : 'No models for this engine'}</option>}
            {/* A saved model outside the loaded list still shows as picked. */}
            {engine.model && !hasModel && <option value={engine.model}>{modelName(engine)}</option>}
            {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        )}

        <div className={cn(label, 'mt-2.5')}>Effort</div>
        {chips(effortChoices(engine.provider), engine.effort, (v) => setEngine({ ...engine, effort: v as TierEngine['effort'] }))}
      </div>
    );
  }

  if (loading) {
    return (
      <AppShell embedded={embedded} title="Preferences" icon={SlidersHorizontal} onClose={onClose} themeConfig={themeConfig} themeMode={themeMode}>
        <div className={cn('text-xs py-6 text-center', colors.textMuted)}>Loading preferences…</div>
      </AppShell>
    );
  }

  return (
    <AppShell embedded={embedded} title="Preferences" icon={SlidersHorizontal} onClose={onClose} themeConfig={themeConfig} themeMode={themeMode}>
      {/* Identity */}
      <div className={card}>
        <div className={title}>Identity</div>
        <div className="flex flex-col gap-2.5">
          <label className="flex flex-col gap-1">
            <span className={label}>Companion name</span>
            <input className={input} value={companionName} onChange={(e) => setCompanionName(e.target.value)} placeholder="Echo" />
          </label>
          <label className="flex flex-col gap-1">
            <span className={label}>Your name</span>
            <input className={input} value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="Alex" />
          </label>
          <label className="flex flex-col gap-1">
            <span className={label}>Timezone</span>
            <select className={input} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {!TIMEZONES.includes(timezone) && <option value={timezone}>{timezone}</option>}
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* House engine */}
      <div className={card}>
        <div className={title}>House Engine</div>
        <p className={cn('text-[11px] mb-2.5 leading-snug', colors.textMuted)}>
          What answers by default. A pick in a thread's model pill still wins in that thread.
        </p>
        <div className="flex flex-col gap-2.5">
          {tierPicker('Chat', 'Your messages', chat, setChat)}

          <div className="flex items-center justify-between gap-3 px-0.5">
            <div className="min-w-0">
              <div className={cn('text-xs font-medium', colors.textMain)}>Separate engine for autonomous</div>
              <div className={cn('text-[10px] leading-snug', colors.textMuted)}>
                {split ? 'Wakes, watchers, scribe and impulses run on their own engine.' : `Wakes follow chat — ${modelName(chat) || 'no model yet'}.`}
              </div>
            </div>
            <Toggle
              on={split}
              onClick={() => {
                // Opening the split starts from the chat engine, not a stale one.
                if (!split && !auto.model) setAuto(chat);
                setSplit(!split);
              }}
              colors={colors}
              ariaLabel="Separate engine for autonomous"
            />
          </div>

          {split && tierPicker('Autonomous', 'Wakes, watchers, scribe', auto, setAuto)}
        </div>
      </div>

      {/* How a thread with more than one companion in it actually runs. */}
      <div className={card}>
        <div className={title}>The Room</div>
        {chips(ROOM_MODES, multiLane, (v) => { if (v === 'true' && multiLaneWaitingOn) return; setMultiLane(v); })}
        {multiLaneWaitingOn && (
          <p className={cn('text-[10px] mt-1.5', colors.textMuted)}>
            A Lane Each waits on a bio for {multiLaneWaitingOn.length ? multiLaneWaitingOn.join(' and ') : 'each companion'} — write it on his profile card. His lane reads it.
          </p>
        )}
        <p className={cn('text-[10px] mt-1.5', colors.textMuted)}>
          {multiLane === 'true'
            ? 'Each companion answers from his own warm lane. The turn passes between them in a shuffled order and each one hears what the others already said. Separate heads, same room.'
            : 'Everyone in a thread answers out of one shared lane — one context, all voices, no waiting.'}
        </p>
      </div>

      {message && <p className="text-xs mb-2" style={{ color: colors.accent }}>{message}</p>}
      {error && <p className="text-xs mb-2" style={{ color: colors.accent, opacity: 0.8 }}>{error}</p>}

      <button
        onClick={save}
        disabled={saving}
        className="w-full rounded-xl py-2.5 text-sm font-semibold bytelight-on-accent disabled:opacity-50 mb-3"
        style={{ background: colors.accent }}
      >
        {saving ? 'Saving…' : 'Save Preferences'}
      </button>
    </AppShell>
  );
}
