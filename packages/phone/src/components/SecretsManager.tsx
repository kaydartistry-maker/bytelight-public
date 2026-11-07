import React, { useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff, Loader2, Trash2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { apiFetch } from '../bytelight';
import type { ThemeConfig } from '../lib/theme';
import { SecretInput } from './SecretInput';

import { groupSecrets, type SecretStatus } from './secret-groups';
import { canReveal, revealResult } from './secret-reveal';

interface SecretsManagerProps {
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

// BYOK editor for every server-managed API key / token / URL. Reads the
// list from GET /api/secrets (status only, no values), groups it the way
// the classic Keys panel does (see secret-groups.ts), and writes via
// PUT/DELETE /api/secrets/:name. The backend re-initializes the
// affected service in place so changes take effect without a restart.
export function SecretsManager({ themeConfig, themeMode }: SecretsManagerProps) {
  const colors = themeConfig[themeMode];

  const [secrets, setSecrets] = useState<SecretStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Plain values fetched on request only; dropped on hide, save and clear.
  const [revealed, setRevealed] = useState<Record<string, string | undefined>>({});
  const [revealing, setRevealing] = useState<string | null>(null);
  const [revealNote, setRevealNote] = useState<Record<string, string | undefined>>({});

  function forget(name: string) {
    setRevealed((r) => ({ ...r, [name]: undefined }));
    setRevealNote((n) => ({ ...n, [name]: undefined }));
  }

  async function toggleReveal(name: string) {
    if (revealed[name] !== undefined) {
      forget(name);
      return;
    }
    setRevealing(name);
    setRevealNote((n) => ({ ...n, [name]: undefined }));
    try {
      const res = await apiFetch(`/api/secrets/${encodeURIComponent(name)}`);
      const body = res.ok ? await res.json().catch(() => null) : null;
      const result = revealResult(res.status, body);
      if (result.kind === 'value') setRevealed((r) => ({ ...r, [name]: result.value }));
      else setRevealNote((n) => ({ ...n, [name]: result.message }));
    } catch (err) {
      setRevealNote((n) => ({ ...n, [name]: err instanceof Error ? err.message : 'Reveal failed' }));
    } finally {
      setRevealing(null);
    }
  }

  async function load() {
    setLoading(true);
    try {
      const res = await apiFetch('/api/secrets');
      if (!res.ok) throw new Error(`Load failed: ${res.status}`);
      const data = await res.json();
      setSecrets(Array.isArray(data.secrets) ? data.secrets : []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function save(name: string) {
    const value = drafts[name];
    if (!value || !value.trim()) return;
    setBusy(name);
    try {
      const res = await apiFetch(`/api/secrets/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: value.trim() }),
      });
      if (!res.ok) throw new Error(`Save failed: ${res.status}`);
      setDrafts((d) => {
        const next = { ...d };
        delete next[name];
        return next;
      });
      forget(name);
      setSecrets((prev) => prev.map((s) => (s.name === name ? { ...s, hasValue: true } : s)));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(null);
    }
  }

  async function clear(name: string) {
    setBusy(name);
    try {
      const res = await apiFetch(`/api/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`Clear failed: ${res.status}`);
      setDrafts((d) => {
        const next = { ...d };
        delete next[name];
        return next;
      });
      // Clearing the saved override can fall back to an env value, so the
      // backend's answer is the truth for the badge.
      const body = await res.json().catch(() => null);
      forget(name);
      const stillSet = Boolean(body && typeof body === 'object' && (body as { hasValue?: unknown }).hasValue === true);
      setSecrets((prev) => prev.map((s) => (s.name === name ? { ...s, hasValue: stillSet } : s)));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Clear failed');
    } finally {
      setBusy(null);
    }
  }

  const grouped = useMemo(() => groupSecrets(secrets), [secrets]);

  const card = cn('p-4 rounded-2xl border', colors.panelBg, colors.panelBorder);

  return (
    <div className="space-y-5">
      {/* Description panel */}
      <div className={cn('rounded-2xl border p-3 backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
        <p className={cn('text-xs', colors.textMuted)}>
          Manage API keys and tokens for connected services. Changes take effect immediately.
        </p>
      </div>

      {loading && (
        <div className={cn('rounded-2xl border p-3 backdrop-blur-md flex items-center justify-center gap-2 py-6 text-xs', colors.panelBg, colors.panelBorder, colors.textMuted)}>
          <Loader2 size={14} className="animate-spin" /> Loading secrets…
        </div>
      )}

      {error && (
        <p className="text-xs" style={{ color: colors.accent }}>
          {error}
        </p>
      )}

      {grouped.map((group) => (
        <section key={group.category} className={cn('rounded-2xl border p-3 backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
          <h3 className={cn('text-[11px] font-bold uppercase tracking-[0.12em] mb-3', colors.textMuted)} style={{ color: colors.accent }}>{group.label}</h3>
          <div className="space-y-2">
            {group.items.map((s) => {
              const draft = drafts[s.name] ?? '';
              const hasDraft = draft.length > 0;
              const rowBusy = busy === s.name;
              const shown = revealed[s.name];
              const isShown = shown !== undefined;
              return (
                <div key={s.name} className={card}>
                  <div className="flex items-center justify-between mb-1">
                    <label className={cn('text-xs font-medium', colors.textMain)}>{s.label}</label>
                    {!hasDraft && (s.hasValue ? (
                      <span className={cn('text-[10px] uppercase tracking-wider', colors.textMuted)} style={{ color: colors.accent }}>
                        Saved
                      </span>
                    ) : (
                      <span className={cn('text-[10px] uppercase tracking-wider opacity-60', colors.textMuted)}>
                        Not set
                      </span>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <SecretInput
                      value={draft}
                      placeholder={s.hasValue ? '••••••••  (saved — type to replace)' : 'Not set'}
                      onChange={(e) => setDrafts((d) => ({ ...d, [s.name]: e.target.value }))}
                      className={cn(
                        'flex-1 bg-transparent focus:outline-none text-xs px-2 py-1.5 rounded-md border',
                        colors.panelBorder,
                        colors.textMain,
                      )}
                    />
                    <button
                      onClick={() => void toggleReveal(s.name)}
                      disabled={!canReveal(s) || revealing === s.name}
                      className={cn('rounded-md p-1.5 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-30', colors.textMuted)}
                      style={isShown ? { color: colors.accent } : undefined}
                      title={s.hasValue ? (isShown ? 'Hide value' : 'Reveal stored value') : 'Nothing stored to reveal'}
                      aria-label={isShown ? 'Hide value' : 'Reveal stored value'}
                      aria-pressed={isShown}
                    >
                      {revealing === s.name ? <Loader2 size={12} className="animate-spin" /> : isShown ? <EyeOff size={12} /> : <Eye size={12} />}
                    </button>
                    {hasDraft && (
                      <button
                        onClick={() => save(s.name)}
                        disabled={rowBusy}
                        className="rounded-md px-3 py-1.5 text-[11px] font-semibold disabled:opacity-50"
                        style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}
                      >
                        {rowBusy ? <Loader2 size={11} className="animate-spin inline" /> : 'Save'}
                      </button>
                    )}
                    {s.hasValue && !hasDraft && (
                      <button
                        onClick={() => clear(s.name)}
                        disabled={rowBusy}
                        className={cn('rounded-md p-1.5', colors.textMuted, 'hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40')}
                        style={{ color: colors.accent }}
                        title="Clear"
                      >
                        {rowBusy ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={12} />}
                      </button>
                    )}
                  </div>
                  {isShown && (
                    <div className={cn('mt-1.5 flex items-baseline gap-2 rounded-md border px-2 py-1', colors.panelBorder)}>
                      <span className={cn('shrink-0 text-[9px] uppercase tracking-wider', colors.textMuted)}>stored value</span>
                      <code className={cn('min-w-0 break-all font-mono text-[11px]', colors.textMain)}>{shown || '(empty)'}</code>
                    </div>
                  )}
                  {revealNote[s.name] && (
                    <p className="text-[10px] mt-1" style={{ color: colors.accent, opacity: 0.8 }}>{revealNote[s.name]}</p>
                  )}
                  {s.hint && (
                    <p className={cn('text-[10px] mt-1 opacity-70', colors.textMuted)}>{s.hint}</p>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {!loading && grouped.length === 0 && !error && (
        <div className={cn('rounded-2xl border p-3 backdrop-blur-md text-center', colors.panelBg, colors.panelBorder)}>
          <p className={cn('text-xs py-3 italic', colors.textMuted)}>
            No secrets defined.
          </p>
        </div>
      )}
    </div>
  );
}
