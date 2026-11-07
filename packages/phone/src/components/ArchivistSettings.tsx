import React, { useEffect, useState } from 'react';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import { apiFetch } from '../bytelight';

// Who writes the memory blocks. Everything here except Codex rides the BYOK
// router and needs its own key in the Providers tab; Codex reuses the sign-in
// the Codex CLI already holds. The hint that matters is which account each one
// spends, so the placeholder model is listed alongside rather than buried.
const PROVIDERS = [
  { id: 'codex', label: 'Codex — ChatGPT subscription', model: 'gpt-5.6-sol' },
  { id: 'anthropic', label: 'Anthropic — API key, metered', model: 'claude-haiku-4-5-20251001' },
  { id: 'groq', label: 'Groq — API key, metered', model: 'llama-3.3-70b-versatile' },
  { id: 'openai', label: 'OpenAI — API key, metered', model: 'gpt-4.1-mini' },
  { id: 'openrouter', label: 'OpenRouter — API key, metered', model: 'anthropic/claude-haiku-4.5' },
  { id: 'ollama', label: 'Ollama Cloud — API key, metered', model: 'deepseek-v4-pro' },
];

function placeholderModel(provider: string): string {
  return PROVIDERS.find((p) => p.id === provider)?.model || 'model id';
}

const EFFORT_LEVELS = [
  { id: 'adaptive', label: 'Model Default' },
  { id: 'low', label: 'Light' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra High' },
  { id: 'max', label: 'Max' },
  { id: 'ultra', label: 'Ultra' },
];

const THINKING_MODES = [
  { id: 'disabled', label: 'Disabled' },
  { id: 'adaptive', label: 'Adaptive' },
  { id: 'enabled', label: 'Always' },
];

interface ArchivistSettingsProps {
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

/**
 * Archivist configuration, deliberately placed with the memory blocks rather
 * than in the agent settings: the status banner that reports the Archivist
 * broken lives here, so the controls that fix it should be under it and not
 * three taps away in a models tab.
 */
export function ArchivistSettings({ themeConfig, themeMode }: ArchivistSettingsProps) {
  const colors = themeConfig[themeMode];
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [provider, setProvider] = useState('ollama');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('adaptive');
  const [thinking, setThinking] = useState('disabled');

  useEffect(() => {
    if (!open || loaded) return;
    (async () => {
      try {
        const res = await apiFetch('/api/preferences');
        if (!res.ok) return;
        const p = await res.json();
        if (!p || typeof p !== 'object' || !p.agent) return;
        setProvider(p.agent.archivist_provider || 'ollama');
        setModel(p.agent.archivist_model || '');
        setEffort(p.agent.archivist_effort || 'adaptive');
        setThinking(p.agent.archivist_thinking || 'disabled');
        setLoaded(true);
      } catch {
        // Leave the defaults visible rather than blanking the panel.
      }
    })();
  }, [open, loaded]);

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await apiFetch('/api/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: {
            archivist_provider: provider,
            archivist_model: model,
            archivist_effort: effort,
            archivist_thinking: thinking,
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      setMessage(res.ok ? (data.message || 'Saved.') : (data.error || 'Failed to save'));
    } catch {
      setMessage('Failed to save');
    } finally {
      setSaving(false);
    }
  }

  const label = cn('text-[11px] mb-1', colors.textMuted);
  const input = cn('w-full rounded-lg border px-2.5 py-2 text-sm bg-transparent', colors.panelBorder, colors.textMain);
  const title = cn('text-[11px] font-bold uppercase tracking-[0.12em] mb-2', colors.textMuted);

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

  return (
    <div className={cn('mb-4 rounded-xl border', colors.panelBorder, colors.panelBg)}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium"
      >
        <span>Archivist settings</span>
        <span className="opacity-60">{open ? 'Hide' : 'Show'}</span>
      </button>

      {open && (
        <div className="px-3 pb-3">
          <p className={cn('text-[10px] mb-3', colors.textMuted)}>
            The Archivist reads new conversation and proposes lines for these blocks —
            nothing lands until you approve it under Review. Codex reuses the
            ChatGPT account you signed into with <code>codex login</code> — no extra billing.
            Every other option here is a metered API key you supply in the Providers tab.
            Higher effort keeps more of your companion's voice in what gets written, and
            costs more per sweep.
          </p>
          <div className="flex flex-col gap-2.5">
            <label className="flex flex-col gap-1">
              <span className={label}>Provider</span>
              <select className={input} value={provider} onChange={(e) => setProvider(e.target.value)}>
                {!PROVIDERS.some((p) => p.id === provider) && provider && (
                  <option value={provider}>{provider}</option>
                )}
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className={label}>Model</span>
              <input
                className={input}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={placeholderModel(provider)}
              />
            </label>
          </div>
          <div className={cn(title, 'mt-3')}>Effort</div>
          {chips(EFFORT_LEVELS, effort, setEffort)}
          <div className={cn(title, 'mt-3')}>Thinking</div>
          {chips(THINKING_MODES, thinking, setThinking)}

          {message && <p className="text-xs mt-3" style={{ color: colors.accent }}>{message}</p>}

          <button
            onClick={save}
            disabled={saving}
            className="w-full rounded-xl py-2 text-sm font-semibold bytelight-on-accent disabled:opacity-50 mt-3"
            style={{ background: colors.accent }}
          >
            {saving ? 'Saving…' : 'Save Archivist Settings'}
          </button>
        </div>
      )}
    </div>
  );
}
