// Chat-header model pill — which engine answers in THIS thread.
//
// Main resolves the model per (companion brain, tier, thread): a thread-scope
// override wins over the companion default, which wins over the system
// fallback (backend services/companion-resolver.ts). This pill reads the
// effective config, and a pick writes a thread-scope interactive override —
// the same contract as main's Svelte ModelSelector, which this ports
// (routes/companion-settings-routes.ts). "Use default" clears the override.
//
// The sheet keeps the phone's look: provider tabs, starred favourites, a
// bottom sheet. Chips pick whose engine is being set: a shared brain as a
// whole ("Companion A & Companion B") or one of its companions alone. A companion with no
// pick of its own follows its brain's (the resolver falls through
// companion → brain at every scope), and a brain-wide thread pick still beats
// any one companion's default.
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronDown, Star, X, Loader2, RotateCcw } from 'lucide-react';
import { getVariant, type ProviderId, type ThinkingEffort } from '@bytelight/shared';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import { apiFetch, useActiveThreadId } from '../bytelight';
import { clearProviderScopedState } from '../bytelight/socket';
import {
  CLAUDE_VARIANT_OPTIONS,
  DEFAULT_BRAIN,
  PROVIDER_ROWS,
  normalizeCatalog,
  providerEnabled,
  type ModelOption,
  type ProviderStatus,
} from '../lib/house-engine';

interface ModelPillProps {
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  /**
   * Set to pick a companion's own DEFAULT instead of this thread's engine —
   * the profile card's fallback lane. Writes a companion-scope row for that
   * companion and tier; a thread pick still beats it.
   */
  defaultFor?: { companionId: string; name: string; tier: 'interactive' | 'autonomous'; label: string };
}

const EFFORT_OPTIONS: ThinkingEffort[] = ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

type SelectableProvider = ProviderId;

interface Effective {
  provider: SelectableProvider;
  model: string;
  thinkingEffort: ThinkingEffort;
  source: 'thread' | 'companion' | 'system';
  /** Whose row answered — a companion may be following its brain's. */
  matchedCompanionId: string | null;
}

// Who a pick is for: a whole brain, or one companion within a shared brain.
interface Target {
  id: string;
  label: string;
  /** Set on a companion target: the brain it falls back to. */
  brain?: string;
  brainLabel?: string;
}

const LS_FAVS = 'bytelight-fav-models';

function loadFavs(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(LS_FAVS) || '[]'));
  } catch {
    return new Set();
  }
}

function effortLabel(e: ThinkingEffort): string {
  return e === 'xhigh' ? 'Extra high' : e.charAt(0).toUpperCase() + e.slice(1);
}

export function ModelPill({ themeConfig, themeMode, defaultFor }: ModelPillProps) {
  const colors = themeConfig[themeMode];
  const activeThreadId = useActiveThreadId();
  // A default pick is thread-blind: no thread is read or written.
  const threadId = defaultFor ? null : activeThreadId;
  const TIER = defaultFor?.tier ?? 'interactive';
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<Target[]>([]);
  const [target, setTarget] = useState(defaultFor?.companionId ?? DEFAULT_BRAIN);
  const [effective, setEffective] = useState<Effective | null>(null);
  // Each companion's effective engine, for the collapsed pill's split label.
  const [memberEffective, setMemberEffective] = useState<Array<{ label: string; eff: Effective }>>([]);
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [activeProvider, setActiveProvider] = useState<SelectableProvider>('claude');
  const [catalog, setCatalog] = useState<Partial<Record<SelectableProvider, ModelOption[] | 'error'>>>({});
  const [loadingProvider, setLoadingProvider] = useState<SelectableProvider | null>(null);
  const [effort, setEffort] = useState<ThinkingEffort>('auto');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [favs, setFavs] = useState<Set<string>>(loadFavs);

  // Who sits at this thread's table. Each brain gets a chip; a brain shared
  // by more than one companion also gets a chip per companion.
  useEffect(() => {
    if (defaultFor) { setTargets([]); setTarget(defaultFor.companionId); return; }
    if (!threadId) { setTargets([]); setTarget(DEFAULT_BRAIN); return; }
    let stale = false;
    apiFetch(`/api/threads/${threadId}/roster`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (stale) return;
        const groups = new Map<string, Array<{ id: string; name: string }>>();
        for (const c of (data?.roster ?? []) as Array<{ brain?: string; display_name?: string; id?: string; slug?: string }>) {
          const b = c.brain || DEFAULT_BRAIN;
          const id = c.slug || c.id || b;
          groups.set(b, [...(groups.get(b) || []), { id, name: c.display_name || id }]);
        }
        const list: Target[] = [];
        for (const [b, members] of groups) {
          const brainLabel = members.map((m) => m.name).join(' & ');
          list.push({ id: b, label: brainLabel });
          if (members.length > 1) {
            for (const m of members) if (m.id !== b) list.push({ id: m.id, label: m.name, brain: b, brainLabel });
          }
        }
        setTargets(list);
        setTarget((prev) => (list.some((x) => x.id === prev) ? prev : list[0]?.id || DEFAULT_BRAIN));
      })
      .catch(() => { if (!stale) setTargets([]); });
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, defaultFor?.companionId]);

  async function readEffective(companionId: string): Promise<Effective | null> {
    const qs = new URLSearchParams({ companionId, tier: TIER });
    if (threadId) qs.set('threadId', threadId);
    try {
      const res = await apiFetch(`/api/companion-settings/effective?${qs.toString()}`);
      if (!res.ok) return null;
      const data = await res.json();
      return {
        provider: data.provider,
        model: data.model,
        thinkingEffort: data.thinkingEffort,
        source: data.source,
        matchedCompanionId: data.matchedCompanionId ?? null,
      };
    } catch {
      return null;
    }
  }

  async function fetchEffective(forTarget = target): Promise<Effective | null> {
    const next = await readEffective(forTarget);
    if (next) setEffective(next);
    // The companions of the default brain, for the pill's split label.
    const members = targets.filter((t) => t.brain === DEFAULT_BRAIN);
    const reads = await Promise.all(members.map(async (m) => ({ label: m.label, eff: await readEffective(m.id) })));
    setMemberEffective(reads.filter((r): r is { label: string; eff: Effective } => !!r.eff));
    return next;
  }

  // The pill follows the thread and the chosen target, and re-reads when the
  // app comes back to the foreground (another device may have changed it).
  useEffect(() => {
    void fetchEffective();
    const refresh = () => { if (document.visibilityState === 'visible') void fetchEffective(); };
    document.addEventListener('visibilitychange', refresh);
    return () => document.removeEventListener('visibilitychange', refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, target, targets]);

  async function loadCatalog(provider: SelectableProvider, force = false): Promise<void> {
    if (provider === 'claude' || provider === 'claude-cli') return; // static list
    if (!force && catalog[provider] && catalog[provider] !== 'error') return;
    setLoadingProvider(provider);
    try {
      const res = await apiFetch(`/api/models?provider=${provider}`);
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      const list = normalizeCatalog(data);
      setCatalog((prev) => ({ ...prev, [provider]: list }));
    } catch {
      setCatalog((prev) => ({ ...prev, [provider]: 'error' }));
    } finally {
      setLoadingProvider((p) => (p === provider ? null : p));
    }
  }

  async function openSheet() {
    setOpen(true);
    setError(null);
    void apiFetch('/api/models/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => setStatus(s))
      .catch(() => setStatus(null));
    const eff = (await fetchEffective()) ?? effective;
    const provider = eff?.provider ?? 'claude';
    setActiveProvider(provider);
    setEffort(eff?.thinkingEffort ?? 'auto');
    void loadCatalog(provider);
  }

  function pickProvider(p: SelectableProvider) {
    setActiveProvider(p);
    void loadCatalog(p);
  }

  async function applyModel(modelId: string, nextEffort = effort) {
    if (!defaultFor && !threadId) { setError('Open a thread first.'); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(defaultFor ? '/api/companion-settings/default' : '/api/companion-settings/thread', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companionId: target,
          tier: TIER,
          ...(defaultFor ? {} : { threadId }),
          providerId: activeProvider,
          modelId,
          thinkingEffort: nextEffort,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Could not switch (${res.status})`);
      }
      // The rate-limit banner and context readout belonged to the old engine.
      if (!defaultFor && effective && (effective.provider !== activeProvider || effective.model !== modelId)) clearProviderScopedState();
      await fetchEffective();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not switch');
    } finally {
      setBusy(false);
    }
  }

  async function useDefault() {
    if (!defaultFor && !threadId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(defaultFor ? '/api/companion-settings/default' : '/api/companion-settings/thread', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(defaultFor ? { companionId: target, tier: TIER } : { companionId: target, tier: TIER, threadId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Could not reset (${res.status})`);
      }
      if (!defaultFor) clearProviderScopedState();
      await fetchEffective();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset');
    } finally {
      setBusy(false);
    }
  }

  function toggleFav(key: string) {
    setFavs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try { localStorage.setItem(LS_FAVS, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }

  const options: ModelOption[] | 'error' | undefined = activeProvider === 'claude' || activeProvider === 'claude-cli'
    ? CLAUDE_VARIANT_OPTIONS
    : catalog[activeProvider];

  const sorted = useMemo(() => {
    if (!Array.isArray(options)) return [];
    return [...options].sort((a, b) => {
      const fa = favs.has(`${activeProvider}:${a.id}`) ? 0 : 1;
      const fb = favs.has(`${activeProvider}:${b.id}`) ? 0 : 1;
      return fa - fb;
    });
  }, [options, favs, activeProvider]);

  const modelName = (provider: string, id: string) => {
    if (provider === 'claude' || provider === 'claude-cli') return getVariant(id).label;
    const list = catalog[provider as SelectableProvider];
    return (Array.isArray(list) && list.find((m) => m.id === id)?.name) || id;
  };

  const sameEngine = (a: Effective, b: Effective) =>
    a.provider === b.provider && a.model === b.model && a.thinkingEffort === b.thinkingEffort;
  // When the companions run different engines here, the pill names each one.
  const split = memberEffective.length > 1 && memberEffective.some((m) => !sameEngine(m.eff, memberEffective[0].eff));
  const brainEffective = target === DEFAULT_BRAIN ? effective : null;
  const pillLabel = split
    ? memberEffective.map((m) => `${m.label} · ${modelName(m.eff.provider, m.eff.model)}`).join(' | ')
    : effective
      ? `${(brainEffective ?? effective).source === 'thread' ? 'Thread · ' : ''}${modelName(effective.provider, effective.model)} · ${effortLabel(effective.thinkingEffort)}`
      : 'Model';

  const current = targets.find((t) => t.id === target);
  // A pick that belongs to THIS target (not one it inherits): a thread pick
  // here, or — picking a default — this companion's own default row.
  const ownThreadPick = defaultFor
    ? effective?.source === 'companion' && effective.matchedCompanionId === defaultFor.companionId
    : effective?.source === 'thread' && (effective.matchedCompanionId ?? target) === target;
  const followingBrain = !!current?.brain && effective?.source === 'thread' && !ownThreadPick;
  const subtitle = defaultFor
    ? ownThreadPick
      ? `${defaultFor.name}'s own ${defaultFor.tier === 'autonomous' ? 'wake' : 'chat'} default. A thread pick still wins in that thread.`
      : `Following the shared default. A pick here becomes ${defaultFor.name}'s own.`
    : ownThreadPick
    ? current?.brain
      ? `${current.label} has his own engine in this thread.`
      : 'This thread has its own engine.'
    : followingBrain
      ? `${current!.label} is following ${current!.brainLabel}'s pick here. A pick sets his alone.`
      : current?.brain
        ? `${current.label} is following the default. A pick here is his alone, in this thread only.`
        : 'Following the default — a pick here applies to this thread only.';

  const isCurrent = (id: string) => effective?.provider === activeProvider && effective.model === id;

  return (
    <>
      {defaultFor ? (
        <button
          onClick={() => void openSheet()}
          className={cn('flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-2 text-left text-xs', colors.panelBorder, colors.textMain)}
          title={effective ? `${effective.provider} · ${effective.model} (${effective.source})` : undefined}
        >
          <span className="min-w-0 truncate">
            {effective
              ? `${ownThreadPick ? '' : 'Shared · '}${modelName(effective.provider, effective.model)} · ${effortLabel(effective.thinkingEffort)}`
              : 'Loading…'}
          </span>
          <ChevronDown size={12} className={cn('shrink-0', colors.textMuted)} />
        </button>
      ) : (
        <button
          onClick={() => void openSheet()}
          className={cn('flex max-w-[16rem] items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px] font-medium', colors.panelBorder, colors.textMuted)}
          title={effective ? `${effective.provider} · ${effective.model} (${effective.source})` : undefined}
        >
          <span className="truncate">{pillLabel}</span>
          <ChevronDown size={10} className="shrink-0" />
        </button>
      )}

      {createPortal(
        <AnimatePresence>
          {open && (
            <>
              <motion.div
                key="model-backdrop"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className={cn('fixed inset-0 bg-black/40', defaultFor ? 'z-[60]' : 'z-40')}
                onClick={() => setOpen(false)}
              />
              <motion.div
                key="model-sheet"
                initial={{ y: '100%' }}
                animate={{ y: 0 }}
                exit={{ y: '100%' }}
                transition={{ type: 'spring', damping: 32, stiffness: 320 }}
                // Over the profile card (itself z-50) when picking a default.
                className={cn('fixed inset-x-0 bottom-0 max-h-[75%] flex flex-col rounded-t-3xl border-t', defaultFor ? 'z-[70]' : 'z-50', colors.panelBg, colors.panelBorder)}
              >
                <div className="shrink-0 flex items-center justify-between px-4 pt-3 pb-1">
                  <span className={cn('text-sm font-semibold', colors.textMain)}>{defaultFor ? defaultFor.label : 'Model for this thread'}</span>
                  <button onClick={() => setOpen(false)} className={cn('rounded-full p-1.5', colors.textMuted)}>
                    <X size={16} />
                  </button>
                </div>
                <div className={cn('shrink-0 px-4 pb-2 text-[11px]', colors.textMuted)}>
                  {subtitle}
                </div>

                {targets.length > 1 && (
                  <div className="shrink-0 px-4 pb-2">
                    <div className="flex gap-1.5 overflow-x-auto scrollbar-hide">
                      {targets.map((t) => (
                        <button
                          key={t.id}
                          onClick={() => setTarget(t.id)}
                          className={cn('shrink-0 rounded-full border px-3 py-1 text-[11px] whitespace-nowrap', colors.panelBorder, colors.textMain)}
                          style={target === t.id ? { borderColor: colors.accent, color: colors.accent } : undefined}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                    {current?.brain && (
                      <p className={cn('mt-1.5 text-[10px] leading-snug', colors.textMuted)}>
                        In one shared lane, {current.brainLabel}'s pick runs both voices. His own pick takes over when he has a lane of his own.
                      </p>
                    )}
                  </div>
                )}

                <div className="shrink-0 flex gap-1.5 px-4 pb-2 overflow-x-auto scrollbar-hide">
                  {PROVIDER_ROWS.map((row) => {
                    const { enabled, hint } = providerEnabled(row.id, status);
                    const active = activeProvider === row.id;
                    return (
                      <button
                        key={row.id}
                        disabled={!enabled}
                        onClick={() => pickProvider(row.id)}
                        title={hint}
                        className={cn(
                          'shrink-0 min-w-[3.5rem] rounded-lg px-3 py-1 text-[11px] font-medium border whitespace-nowrap text-center disabled:opacity-35',
                          colors.panelBorder,
                          colors.textMain,
                        )}
                        style={active ? { background: colors.accent, color: 'var(--bytelight-on-accent)', borderColor: colors.accent } : undefined}
                      >
                        {row.label}
                      </button>
                    );
                  })}
                </div>

                <div className="shrink-0 px-4 pb-2">
                  <div className={cn('pb-1 text-[10px] font-bold uppercase tracking-wider', colors.textMuted)}>Thinking</div>
                  <div className="flex gap-1 overflow-x-auto scrollbar-hide">
                    {EFFORT_OPTIONS.map((e) => (
                      <button
                        key={e}
                        onClick={() => {
                          setEffort(e);
                          // On the engine already running here, effort applies at once.
                          if (effective && effective.provider === activeProvider) void applyModel(effective.model, e);
                        }}
                        className={cn('shrink-0 rounded-lg border px-2.5 py-1 text-[11px]', colors.panelBorder, colors.textMain)}
                        style={effort === e ? { background: colors.accent, color: 'var(--bytelight-on-accent)', borderColor: colors.accent } : undefined}
                      >
                        {effortLabel(e)}
                      </button>
                    ))}
                  </div>
                </div>

                {error && (
                  <div className="shrink-0 mx-4 mb-2 rounded-xl border px-3 py-2 text-[11px]" style={{ borderColor: colors.accent, color: colors.accent }}>
                    {error}
                  </div>
                )}

                <div className="flex-1 overflow-y-auto scrollbar-hide px-2 pb-2">
                  {loadingProvider === activeProvider && (
                    <div className={cn('flex items-center justify-center gap-2 py-6 text-xs', colors.textMuted)}>
                      <Loader2 size={14} className="animate-spin" /> Loading models…
                    </div>
                  )}
                  {options === 'error' && loadingProvider !== activeProvider && (
                    <button
                      onClick={() => void loadCatalog(activeProvider, true)}
                      className="w-full py-6 text-center text-xs"
                      style={{ color: colors.accent }}
                    >
                      Could not load models — tap to retry.
                    </button>
                  )}
                  {Array.isArray(options) && sorted.length === 0 && loadingProvider !== activeProvider && (
                    <div className={cn('py-6 text-center text-xs', colors.textMuted)}>No models for this provider.</div>
                  )}
                  {sorted.map((m) => {
                    const key = `${activeProvider}:${m.id}`;
                    const isFav = favs.has(key);
                    const current = isCurrent(m.id);
                    return (
                      <div key={key} className="flex items-center gap-1 px-2">
                        <button onClick={() => toggleFav(key)} className="p-1.5 shrink-0" aria-label={isFav ? 'Unfavourite' : 'Favourite'}>
                          <Star size={13} style={{ color: isFav ? colors.accent : 'rgba(127,127,127,0.5)' }} fill={isFav ? colors.accent : 'none'} />
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => void applyModel(m.id)}
                          className="flex flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left min-w-0 disabled:opacity-60"
                          style={current ? { background: themeMode === 'dark' ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)' } : undefined}
                        >
                          <span className={cn('flex-1 truncate text-sm', colors.textMain)} style={{ color: current ? colors.accent : undefined }}>
                            {m.name}
                          </span>
                        </button>
                      </div>
                    );
                  })}
                </div>

                {ownThreadPick && (
                  <div className={cn('shrink-0 border-t px-4 py-2', colors.panelBorder)}>
                    <button
                      disabled={busy}
                      onClick={() => void useDefault()}
                      className={cn('flex w-full items-center justify-center gap-2 rounded-lg py-2 text-xs font-medium disabled:opacity-60', colors.textMain)}
                    >
                      <RotateCcw size={13} /> {defaultFor ? `${defaultFor.name} follows the shared default` : current?.brain ? `${current.label} follows ${current.brainLabel} again` : 'Use the default engine here'}
                    </button>
                  </div>
                )}
              </motion.div>
            </>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
