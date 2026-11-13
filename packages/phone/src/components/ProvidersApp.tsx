import React, { useEffect, useRef, useState } from 'react';
import { Plug, Loader2 } from 'lucide-react';
import { AppShell } from './AppShell';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import { SecretInput } from './SecretInput';
import { apiFetch } from '../bytelight';
import { Toggle } from './Toggle';
import { checkProvider, type ProviderCheckInput, type ProviderCheckState } from './provider-check';
import {
  providerCardStatus,
  reachAfterCheck,
  reachFromCatalog,
  UNKNOWN_REACH,
  type CatalogReach,
  type ModelsStatus,
  type ProviderCardId,
  type ProviderDot,
} from './provider-status';
import { manualCodeError, type CodexStatus } from './engine-status';

interface ProvidersAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  embedded?: boolean;
}

const MASK = '••••••••';

// API-key providers behind the runtime router — alphabetized.
//
const API_PROVIDERS = [
  { key: 'anthropic', name: 'Anthropic', tag: 'paid', placeholder: 'sk-ant-…', hint: 'console.anthropic.com (optional — the Claude lane uses your Claude Code login)' },
  { key: 'groq', name: 'Groq', tag: 'free', placeholder: 'gsk_…', hint: 'console.groq.com' },
  { key: 'huggingface', name: 'HuggingFace', tag: 'free', placeholder: 'hf_…', hint: 'huggingface.co/settings/tokens' },
  { key: 'openai', name: 'OpenAI', tag: 'paid', placeholder: 'sk-…', hint: 'platform.openai.com/api-keys' },
  { key: 'openrouter', name: 'OpenRouter', tag: 'paid', placeholder: 'sk-or-…', hint: 'openrouter.ai/keys' },
  { key: 'xai', name: 'xAI', tag: 'paid', placeholder: 'xai-…', hint: 'console.x.ai' },
] as const;

export function ProvidersApp({ onClose, themeConfig, themeMode, embedded }: ProvidersAppProps) {
  const colors = themeConfig[themeMode];
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [ollamaUrl, setOllamaUrl] = useState('');
  const [openaiUrl, setOpenaiUrl] = useState('https://api.openai.com/v1');
  const [ollamaKey, setOllamaKey] = useState('');
  // Main hides the Ollama lane unless providers.ollama.enabled is true.
  const [ollamaEnabled, setOllamaEnabled] = useState(false);
  // The OpenAI direct lane needs a key AND providers.openai.enabled.
  const [openaiEnabled, setOpenaiEnabled] = useState(false);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [checks, setChecks] = useState<Record<string, ProviderCheckState>>({});
  // Server truth for the per-card status lines (as last saved, not drafts).
  const [modelsStatus, setModelsStatus] = useState<ModelsStatus | null>(null);
  const [ollamaReach, setOllamaReach] = useState<CatalogReach>(UNKNOWN_REACH);
  const [openaiReach, setOpenaiReach] = useState<CatalogReach>(UNKNOWN_REACH);

  const [codex, setCodex] = useState<CodexStatus | null>(null);
  const [manualCode, setManualCode] = useState('');
  const [codexBusy, setCodexBusy] = useState(false);
  // Codex sign-in trouble shows on the Codex card itself, not at the bottom.
  const [codexError, setCodexError] = useState<string | null>(null);
  // Logging out deletes the stored credentials, so it asks first.
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function loadProviders() {
    try {
      const res = await apiFetch('/api/preferences');
      if (!res.ok) throw new Error('Failed to load');
      const prefs = await res.json();
      const p = prefs.providers || {};
      // Main's /preferences omits groq/xai and never echoes a key; its
      // /models/status says which providers are configured (as Svelte reads it).
      const status = await fetchModelsStatus();
      setModelsStatus(status);
      setOllamaUrl(p.ollama?.base_url || status?.ollama?.url || '');
      setOllamaKey(p.ollama?.api_key ? MASK : '');
      setOllamaEnabled(Boolean(status?.ollama?.enabled ?? p.ollama?.enabled));
      setOpenaiUrl(p.openai?.base_url || status?.openai?.url || 'https://api.openai.com/v1');
      setOpenaiEnabled(Boolean(status?.openai?.enabled ?? p.openai?.enabled));
      const k: Record<string, string> = {};
      for (const prov of API_PROVIDERS) {
        const configured = Boolean(p[prov.key]?.api_key) || Boolean(status?.[prov.key]?.configured);
        k[prov.key] = configured ? MASK : '';
      }
      setKeys(k);
      void loadCatalogReach(status);
    } catch {
      setError('Failed to load provider settings');
    } finally {
      setLoading(false);
    }
  }

  async function fetchModelsStatus(): Promise<ModelsStatus | null> {
    return apiFetch('/api/models/status').then((r) => (r.ok ? (r.json() as Promise<ModelsStatus>) : null)).catch(() => null);
  }

  // Live catalog size for the two lanes whose status line counts models.
  async function loadCatalogReach(status: ModelsStatus | null) {
    const probe = (provider: 'ollama' | 'openai') =>
      apiFetch(`/api/models?provider=${provider}`)
        .then((r) => (r.ok ? (r.json() as Promise<unknown>) : null))
        .catch(() => null);
    const [ollama, openai] = await Promise.all([probe('ollama'), probe('openai')]);
    setOllamaReach(reachFromCatalog(ollama, !!status?.ollama?.enabled));
    setOpenaiReach(reachFromCatalog(openai, !!status?.openai?.enabled));
  }

  async function refreshStatus() {
    const status = await fetchModelsStatus();
    setModelsStatus(status);
    await loadCatalogReach(status);
  }

  // Polls while a browser login is in flight and stops the moment it isn't —
  // including one already running when this screen opens (as Svelte does).
  async function loadCodex() {
    try {
      const res = await apiFetch('/api/auth/codex/status');
      if (!res.ok) return;
      const status = (await res.json()) as CodexStatus;
      setCodex(status);
      if (status.loginSession?.status === 'awaiting_browser') startCodexPoll();
      else stopCodexPoll();
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    loadProviders();
    loadCodex();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  async function saveProviders() {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const providerUpdates: Record<string, unknown> = {};
      if (ollamaUrl) {
        const ollama: Record<string, string | boolean> = { base_url: ollamaUrl, enabled: ollamaEnabled };
        if (ollamaKey && !ollamaKey.startsWith('•')) ollama.api_key = ollamaKey;
        providerUpdates.ollama = ollama;
      }
      for (const prov of API_PROVIDERS) {
        const v = keys[prov.key];
        if (v && !v.startsWith('•')) providerUpdates[prov.key] = { api_key: v };
      }
      if (openaiUrl) {
        const previous = providerUpdates.openai;
        providerUpdates.openai = { ...(previous && typeof previous === 'object' ? previous : {}), base_url: openaiUrl, enabled: openaiEnabled };
      }
      const res = await apiFetch('/api/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: providerUpdates }),
      });
      const data = await res.json();
      // Main reloads config on save — no restart needed.
      if (res.ok) {
        setMessage('Saved — live now.');
        void refreshStatus();
      } else setError(data.error || 'Failed to save');
    } catch {
      setError('Failed to save provider settings');
    } finally {
      setSaving(false);
    }
  }

  async function runCheck(input: ProviderCheckInput) {
    const provider = input.provider;
    setChecks((current) => ({ ...current, [provider]: { kind: 'checking' } }));
    const result = await checkProvider(input);
    setChecks((current) => ({ ...current, [provider]: { kind: 'complete', result } }));
    const outcome = result.kind === 'success' ? { ok: true as const, models: result.models } : { ok: false as const };
    if (provider === 'ollama') setOllamaReach((r) => reachAfterCheck(r, outcome));
    if (provider === 'openai') setOpenaiReach((r) => reachAfterCheck(r, outcome));
  }

  const DOT_COLOR: Record<ProviderDot, string | undefined> = {
    connected: colors.accent,
    'needs-key': '#f59e0b',
    disabled: undefined,
    'coming-soon': undefined,
  };

  function statusLine(id: ProviderCardId) {
    const cs = providerCardStatus(id, modelsStatus, { ollama: ollamaReach, openai: openaiReach }, ollamaUrl);
    const tint = DOT_COLOR[cs.dot];
    return (
      <div className="flex items-start gap-1.5 mb-2">
        <span
          className={cn('mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full', !tint && 'opacity-40')}
          style={{ background: tint ?? 'currentColor', boxShadow: tint ? `0 0 6px ${tint}66` : undefined }}
        />
        <span
          className={cn('text-[10px] leading-snug', colors.textMuted)}
          style={tint && cs.dot === 'needs-key' ? { color: tint } : undefined}
        >
          {cs.text}
        </span>
      </div>
    );
  }

  function checkNote(provider: string) {
    const state = checks[provider];
    if (!state || state.kind === 'idle' || state.kind === 'checking') return null;
    return state.result.kind === 'success' ? `Connected · ${state.result.models} models` : state.result.error;
  }

  function stopCodexPoll() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }

  function startCodexPoll() {
    if (pollRef.current) return;
    pollRef.current = setInterval(() => { void loadCodex(); }, 2000);
  }

  async function codexLogin() {
    setCodexBusy(true);
    setCodexError(null);
    try {
      const res = await apiFetch('/api/auth/codex/login', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCodexError([data.error, data.details].filter(Boolean).join(' — ') || 'Codex login failed');
      } else {
        if (data.url) window.open(data.url, '_blank', 'noopener,noreferrer');
        // Main can answer awaiting_browser before it has a URL; the poll
        // picks the URL up and the "Reopen login URL" link appears.
        await loadCodex();
        if (!data.url && data.status !== 'awaiting_browser') setCodexError('Codex login failed to produce a URL.');
      }
    } catch {
      setCodexError('Codex login failed');
    } finally {
      setCodexBusy(false);
    }
  }

  async function codexManualCode() {
    if (!manualCode.trim()) return;
    setCodexBusy(true);
    setCodexError(null);
    try {
      const res = await apiFetch('/api/auth/codex/manual-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: manualCode.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setCodexError(manualCodeError(res.status, body));
        return;
      }
      setManualCode('');
      await loadCodex();
    } catch {
      setCodexError(manualCodeError(0, null));
    } finally {
      setCodexBusy(false);
    }
  }

  async function codexCancel() {
    setCodexBusy(true);
    try {
      await apiFetch('/api/auth/codex/cancel', { method: 'POST' });
      stopCodexPoll();
      await loadCodex();
    } finally {
      setCodexBusy(false);
    }
  }

  async function codexLogout() {
    setConfirmingLogout(false);
    setCodexBusy(true);
    try {
      await apiFetch('/api/auth/codex/logout', { method: 'POST' });
      await loadCodex();
    } finally {
      setCodexBusy(false);
    }
  }

  const card = cn('rounded-2xl border p-3 mb-3', colors.panelBg, colors.panelBorder);
  const fieldLabel = cn('text-[11px] mb-1', colors.textMuted);
  const input = cn('w-full rounded-lg border px-2.5 py-2 text-xs bg-transparent', colors.panelBorder, colors.textMain);

  function tag(t: 'free' | 'paid') {
    return (
      <span
        className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide"
        style={{
          background: `${colors.accent}22`,
          color: colors.accent,
          opacity: t === 'free' ? 1 : 0.8,
        }}
      >
        {t === 'free' ? 'free tier' : 'credits'}
      </span>
    );
  }

  const codexLoggedIn = !!codex?.loggedIn;
  const codexViaCli = codexLoggedIn && codex?.source === 'cli';
  const codexInFlight = codex?.loginSession?.status === 'awaiting_browser';

  // Cancel / reopen / paste — shown under either login button while a
  // sign-in is open (and always under the first-time Log in button).
  function codexLoginControls() {
    return (
      <>
        {codexInFlight && (
          <button
            onClick={codexCancel}
            disabled={codexBusy}
            className={cn('mt-2 rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-50', colors.panelBorder, colors.textMain)}
          >
            Cancel login
          </button>
        )}
        {codex?.loginSession?.url && (
          <a
            href={codex.loginSession.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block text-[11px] mt-2"
            style={{ color: colors.accent }}
          >
            Reopen login URL
          </a>
        )}
        <div className={cn(fieldLabel, 'mt-2')}>
          Page didn't load? That's normal on a server. Copy the whole address from the top of that page and paste it here.
        </div>
        <div className="flex gap-2">
          <input
            className={cn(input, 'flex-1')}
            type="text"
            placeholder="Paste the whole address (or just the code)"
            value={manualCode}
            onChange={(e) => setManualCode(e.target.value)}
          />
          <button
            onClick={codexManualCode}
            disabled={codexBusy || !manualCode.trim()}
            className={cn('rounded-lg border px-3 text-xs font-semibold disabled:opacity-50', colors.panelBorder, colors.textMain)}
          >
            Submit
          </button>
        </div>
      </>
    );
  }


  return (
    <AppShell embedded={embedded} title="Providers" icon={Plug} onClose={onClose} themeConfig={themeConfig} themeMode={themeMode}>
      {loading ? (
        <div className={cn('rounded-2xl border p-3 backdrop-blur-md text-xs py-6 text-center', colors.panelBg, colors.panelBorder, colors.textMuted)}>Loading providers…</div>
      ) : (
        <>
          {/* Codex — moved to top */}
          <div className={cn('rounded-2xl border p-3 backdrop-blur-md mb-3', colors.panelBg, colors.panelBorder)}>
            <div className="flex items-center justify-between mb-2">
              <span className={cn('text-sm font-semibold', colors.textMain)}>Codex (ChatGPT)</span>
              <span
                className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                style={{
                  background: `${colors.accent}${codexLoggedIn || codexInFlight ? '26' : '00'}`,
                  color: codexLoggedIn || codexInFlight ? colors.accent : colors.textMuted,
                  opacity: codexLoggedIn ? 1 : codexInFlight ? 0.7 : 0.5,
                }}
              >
                {codexViaCli ? 'Using Codex CLI login' : codexLoggedIn ? 'Logged in' : codexInFlight ? 'Login in progress' : 'Not logged in'}
              </span>
            </div>
            {codexViaCli ? (
              <>
                <div className={cn('text-xs', colors.textMuted)}>
                  Borrowing the login from <code>codex login</code>, so Codex already works. You can still give the house a login of its own.
                </div>
                {!codexInFlight && (
                  <button
                    onClick={codexLogin}
                    disabled={codexBusy}
                    className={cn('mt-2 rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-50 flex items-center gap-1.5', colors.panelBorder, colors.textMain)}
                  >
                    {codexBusy && <Loader2 size={12} className="animate-spin" />} Sign the house in on its own
                  </button>
                )}
                {codexInFlight && codexLoginControls()}
              </>
            ) : codexLoggedIn ? (
              <button
                onClick={() => setConfirmingLogout(true)}
                disabled={codexBusy}
                className="rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                style={{ color: colors.accent, borderColor: colors.accent }}
              >
                Log out
              </button>
            ) : (
              <>
                <button
                  onClick={codexLogin}
                  disabled={codexBusy}
                  className="rounded-lg px-3 py-1.5 text-xs font-semibold bytelight-on-accent disabled:opacity-50 flex items-center gap-1.5"
                  style={{ background: colors.accent }}
                >
                  {codexBusy && <Loader2 size={12} className="animate-spin" />} Log in with ChatGPT
                </button>
                {codexLoginControls()}
              </>
            )}
            {codexError && (
              <p className="text-[11px] mt-2" style={{ color: colors.accent, opacity: 0.8 }}>{codexError}</p>
            )}
            {codex?.loginSession?.error && (
              <p className="text-[11px] mt-2" style={{ color: colors.accent, opacity: 0.8 }}>{codex.loginSession.error}</p>
            )}
          </div>

          {/* All providers in one panel */}
          <div className={cn('rounded-2xl border p-3 backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
            <p className={cn('text-xs mb-3', colors.textMuted)}>
              Connect inference backends. Add an API key to enable a provider — its models appear in the model selector.
            </p>

            {/* Ollama */}
            <div className={cn('rounded-xl border p-3 mb-2', colors.panelBorder)}>
              <div className="flex items-center gap-2 mb-2">
                <span className={cn('text-sm font-semibold', colors.textMain)}>Ollama</span>
                {tag('free')}
                <span className="ml-auto flex items-center gap-2">
                  <span className={cn('text-[10px]', colors.textMuted)}>{ollamaEnabled ? 'On' : 'Off'}</span>
                  <Toggle on={ollamaEnabled} onClick={() => setOllamaEnabled((v) => !v)} colors={colors} />
                </span>
              </div>
              {statusLine('ollama')}
              <div className={fieldLabel}>Base URL</div>
              <input
                className={input}
                type="text"
                placeholder="http://localhost:11434 or https://ollama.com"
                value={ollamaUrl}
                onChange={(e) => setOllamaUrl(e.target.value)}
              />
              <div className={cn(fieldLabel, 'mt-2')}>API Key</div>
              <SecretInput
                className={input}
                placeholder="Optional — for Ollama Cloud"
                value={ollamaKey}
                onChange={(e) => setOllamaKey(e.target.value)}
              />
              <button
                onClick={() => void runCheck({ provider: 'ollama', baseUrl: ollamaUrl, apiKey: ollamaKey })}
                disabled={!ollamaUrl.trim() || checks.ollama?.kind === 'checking'}
                className={cn('mt-2 rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-50', colors.panelBorder, colors.textMain)}
              >
                {checks.ollama?.kind === 'checking' ? 'Checking…' : 'Check'}
              </button>
              {checkNote('ollama') && <div className={cn('mt-1 text-[10px]', colors.textMuted)}>{checkNote('ollama')}</div>}
            </div>

            {/* API-key providers */}
            {API_PROVIDERS.map((prov) => (
              <div key={prov.key} className={cn('rounded-xl border p-3 mb-2 last:mb-0', colors.panelBorder)}>
                <div className="flex items-center gap-2 mb-2">
                  <span className={cn('text-sm font-semibold', colors.textMain)}>{prov.name}</span>
                  {tag(prov.tag)}
                  {prov.key === 'openai' && (
                    <span className="ml-auto flex items-center gap-2">
                      <span className={cn('text-[10px]', colors.textMuted)}>{openaiEnabled ? 'On' : 'Off'}</span>
                      <Toggle on={openaiEnabled} onClick={() => setOpenaiEnabled((v) => !v)} colors={colors} ariaLabel="OpenAI enabled" />
                    </span>
                  )}
                </div>
                {statusLine(prov.key)}
                <div className={fieldLabel}>API Key</div>
                <SecretInput
                  className={input}
                  placeholder={prov.placeholder}
                  value={keys[prov.key] || ''}
                  onChange={(e) => setKeys((k) => ({ ...k, [prov.key]: e.target.value }))}
                />
                {prov.key === 'openai' && (
                  <>
                    <div className={cn(fieldLabel, 'mt-2')}>Base URL</div>
                    <input className={input} value={openaiUrl} onChange={(e) => setOpenaiUrl(e.target.value)} />
                  </>
                )}
                {(prov.key === 'openai' || prov.key === 'openrouter' || prov.key === 'groq' || prov.key === 'xai') && (
                  <button
                    onClick={() => void runCheck(prov.key === 'openai'
                      ? { provider: 'openai', baseUrl: openaiUrl, apiKey: keys.openai || '' }
                      : { provider: prov.key, apiKey: keys[prov.key] || '' })}
                    disabled={(prov.key === 'openai' && !openaiUrl.trim()) || checks[prov.key]?.kind === 'checking'}
                    className={cn('mt-2 rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-50', colors.panelBorder, colors.textMain)}
                  >
                    {checks[prov.key]?.kind === 'checking' ? 'Checking…' : 'Check'}
                  </button>
                )}
                {checkNote(prov.key) && <div className={cn('mt-1 text-[10px]', colors.textMuted)}>{checkNote(prov.key)}</div>}
                <div className={cn('text-[10px] mt-1', colors.textMuted)}>{prov.hint}</div>
              </div>
            ))}

            {message && <p className="text-xs mt-3" style={{ color: colors.accent }}>{message}</p>}
            {error && <p className="text-xs mt-3" style={{ color: colors.accent, opacity: 0.8 }}>{error}</p>}

            <button
              onClick={saveProviders}
              disabled={saving}
              className="w-full rounded-xl py-2.5 text-sm font-semibold bytelight-on-accent disabled:opacity-50 mt-3"
              style={{ background: colors.accent }}
            >
              {saving ? 'Saving…' : 'Save Providers'}
            </button>
          </div>
        </>
      )}

      {confirmingLogout && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-6" onClick={() => setConfirmingLogout(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="codex-logout-title"
            className={cn('w-full max-w-xs rounded-2xl border p-5 shadow-2xl', colors.panelBg, colors.panelBorder)}
            onClick={(e) => e.stopPropagation()}
          >
            <h4 id="codex-logout-title" className={cn('mb-2 text-sm font-bold', colors.textMain)}>Log out of Codex?</h4>
            <p className={cn('mb-4 text-xs leading-relaxed', colors.textMuted)}>
              This deletes the stored OAuth credentials. Reconnect ChatGPT to restore Codex access.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmingLogout(false)}
                className={cn('rounded-lg border px-3 py-1.5 text-xs font-semibold', colors.panelBorder, colors.textMain)}
              >
                Cancel
              </button>
              <button
                onClick={() => void codexLogout()}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold"
                style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}
              >
                Log out
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
