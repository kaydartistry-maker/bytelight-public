import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { apiFetch } from '../../bytelight';
import { cn } from '../../lib/utils';
import type { ThemeColors } from '../../lib/theme';
import { ACCENT_TEXT_COLOR_BY_THEME } from './constants';
import {
  ENGINE_HINTS, QUALITY_OPTS, SETTINGS_SIZE_OPTS, STUDIO_ENGINES,
  budgetPatch, parseStudioSettings, spendLine,
  type StudioEngine, type StudioSettings,
} from './studio-settings';
import type { ThemeMode } from './types';

interface StudioSettingsPanelProps {
  colors: ThemeColors;
  themeMode: ThemeMode;
  /** Called after the default engine is saved, so Create can follow it. */
  onEngineSwitched: (engine: StudioEngine) => void;
}

/**
 * The desktop Studio's Settings tab: image generation on/off, the default
 * engine, and — for the metered OpenAI engine — size, quality, API key and
 * monthly budget. All of it is GET/PUT /api/studio/settings.
 */
export function StudioSettingsPanel({ colors, themeMode, onEngineSwitched }: StudioSettingsPanelProps) {
  const [settings, setSettings] = useState<StudioSettings | null>(null);
  const [monthlySpend, setMonthlySpend] = useState(0);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [budgetInput, setBudgetInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const loadIdRef = useRef(0);

  const loadSettings = useCallback(async () => {
    const loadId = ++loadIdRef.current;
    try {
      const r = await apiFetch('/api/studio/settings');
      if (!r.ok || loadId !== loadIdRef.current) {
        if (!r.ok) setError(`Settings could not be loaded (${r.status})`);
        return;
      }
      const parsed = parseStudioSettings(await r.json());
      setSettings(parsed.settings);
      setMonthlySpend(parsed.monthlySpendUsd);
      setBudgetInput(String(parsed.settings?.monthlyBudgetUsd ?? 0));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Settings could not be loaded');
    }
  }, []);

  useEffect(() => { void loadSettings(); }, [loadSettings]);

  const putSettings = async (patch: Record<string, unknown>): Promise<boolean> => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const r = await apiFetch('/api/studio/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (r.ok) {
        const parsed = parseStudioSettings(await r.json());
        if (parsed.settings) setSettings(parsed.settings);
        return true;
      }
      const data = await r.json().catch(() => ({}));
      setError(data.error || 'Could not save.');
      return false;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save.');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const switchBackend = async (engine: StudioEngine) => {
    if (await putSettings({ backend: engine })) {
      onEngineSwitched(engine);
      setNotice(`Image engine → ${engine}`);
    }
  };

  const saveKey = () => {
    if (!apiKeyInput.trim()) return;
    void putSettings({ openai_api_key: apiKeyInput.trim() });
    setApiKeyInput('');
  };
  const clearKey = () => { void putSettings({ openai_api_key: '' }); };
  const saveBudget = () => { void putSettings(budgetPatch(budgetInput)); };

  const label = cn('text-xs font-medium uppercase tracking-wide', colors.textMuted);
  const block = cn('space-y-2 rounded-xl border p-4', colors.panelBg, colors.panelBorder);
  const hint = cn('text-xs', colors.textMuted);
  const field = cn('min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm', colors.panelBg, colors.panelBorder, colors.textMain);
  const softButton = cn('rounded-lg border px-3 py-2 text-xs font-semibold disabled:opacity-50', colors.panelBorder, colors.textMain);

  return (
    <div className="bytelight-app-body flex-1 space-y-4 overflow-y-auto p-4">
      {error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}
      {notice && <div className={cn('rounded-xl border px-3 py-2 text-xs', colors.panelBorder, colors.textMain)}>{notice}</div>}

      {!settings ? (
        <p className={cn('py-8 text-center text-sm', colors.textMuted)}>{error ? 'Settings unavailable.' : 'Loading…'}</p>
      ) : (
        <>
          <section className={block}>
            <div className="flex items-center justify-between">
              <span className={label}>Image generation</span>
              <button
                type="button"
                role="switch"
                aria-checked={settings.enabled}
                aria-label="Toggle image generation"
                disabled={saving}
                onClick={() => void putSettings({ enabled: !settings.enabled })}
                className={cn('relative h-6 w-11 rounded-full border transition-colors disabled:opacity-50', colors.panelBorder)}
                style={settings.enabled ? { backgroundColor: colors.accent } : undefined}
              >
                <span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all', settings.enabled ? 'left-6' : 'left-0.5')} />
              </button>
            </div>
            <p className={hint}>When on, we can draw straight into the chat.</p>
          </section>

          <section className={block}>
            <span className={label}>Engine</span>
            <div className="flex flex-wrap gap-1.5">
              {STUDIO_ENGINES.map((engine) => {
                const active = settings.backend === engine;
                return (
                  <button
                    type="button"
                    key={engine}
                    disabled={saving}
                    onClick={() => void switchBackend(engine)}
                    aria-pressed={active}
                    className={cn('rounded-full border px-3 py-1.5 text-xs font-medium disabled:opacity-50', colors.panelBorder, !active && colors.textMuted)}
                    style={active ? { backgroundColor: colors.accent, borderColor: colors.accent, color: ACCENT_TEXT_COLOR_BY_THEME[themeMode] } : undefined}
                  >
                    {engine}
                  </button>
                );
              })}
            </div>
            <p className={hint}>{ENGINE_HINTS[settings.backend]}</p>
          </section>

          {settings.backend === 'openai' && (
            <>
              <section className={block}>
                <div className="flex items-center justify-between gap-3">
                  <span className={label}>Size</span>
                  <select
                    value={settings.size}
                    disabled={saving}
                    onChange={(e) => void putSettings({ size: e.target.value })}
                    className={cn('rounded-lg border px-2 py-1.5 text-xs', colors.panelBg, colors.panelBorder, colors.textMain)}
                  >
                    {SETTINGS_SIZE_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              </section>

              <section className={block}>
                <div className="flex items-center justify-between gap-3">
                  <span className={label}>Quality</span>
                  <select
                    value={settings.quality}
                    disabled={saving}
                    onChange={(e) => void putSettings({ quality: e.target.value })}
                    className={cn('rounded-lg border px-2 py-1.5 text-xs', colors.panelBg, colors.panelBorder, colors.textMain)}
                  >
                    {QUALITY_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <p className={hint}>Auto lets the model choose. Higher costs more.</p>
              </section>

              <section className={block}>
                <span className={label}>OpenAI API key</span>
                {settings.hasOpenaiKey && (
                  <div className="flex items-center gap-2">
                    <span className={cn('flex flex-1 items-center gap-1 text-xs', colors.textMain)}><Check className="h-3.5 w-3.5" /> Key saved</span>
                    <button type="button" disabled={saving} onClick={clearKey} className={softButton}>Remove</button>
                  </div>
                )}
                <div className="flex gap-2">
                  <input
                    type="password"
                    placeholder="sk-…"
                    autoComplete="off"
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    className={field}
                  />
                  <button type="button" disabled={saving || !apiKeyInput.trim()} onClick={saveKey} className={softButton}>Save</button>
                </div>
              </section>

              <section className={block}>
                <span className={label}>Monthly budget (USD)</span>
                <div className="flex gap-2">
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="0 = no cap"
                    value={budgetInput}
                    onChange={(e) => setBudgetInput(e.target.value)}
                    className={field}
                  />
                  <button type="button" disabled={saving} onClick={saveBudget} className={softButton}>Set</button>
                </div>
                <p className={hint}>{spendLine(monthlySpend, settings.monthlyBudgetUsd)}</p>
              </section>
            </>
          )}
          {saving && <div className={cn('flex items-center justify-center gap-2 text-xs', colors.textMuted)}><Loader2 className="h-4 w-4 animate-spin" /> Saving</div>}
        </>
      )}
    </div>
  );
}
