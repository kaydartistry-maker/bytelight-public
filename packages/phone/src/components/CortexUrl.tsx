import React, { useEffect, useState } from 'react';
import { Check, Copy, Eye, EyeOff, Loader2, Trash2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { copyToClipboard } from '../lib/clipboard';
import { apiFetch } from '../bytelight';
import type { ThemeConfig } from '../lib/theme';

interface Props {
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  /** Re-check Cortex as soon as its worker address or token changes. */
  onSaved?: () => void;
}

// Cortex worker URL and token. Both live on the Cortex tab because this is the
// only place their connection state is visible, and because a worker address
// without its token is half a setting — the worker refuses to serve without it.
// They stay in the same secret store as everything else; only their door moved.

interface RowProps {
  secret: string;
  placeholder: string;
  /** Tokens are never echoed back into the field — only whether one is set. */
  masked?: boolean;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  onSaved?: () => void;
}

function SecretRow({ secret, placeholder, masked, themeConfig, themeMode, onSaved }: RowProps) {
  const colors = themeConfig[themeMode];
  const [value, setValue] = useState('');
  const [savedValue, setSavedValue] = useState('');
  const [hasValue, setHasValue] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A masked row deliberately never loads its value, so a saved secret is not
  // left sitting on screen. That made it write-only — fine until the Cortex
  // login page started asking her to type the token back in, which is the first
  // time this house has needed the value read rather than replaced.
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    load();
  }, [secret]);

  async function load() {
    setLoading(true);
    try {
      // These are deliberately hidden from the broad secrets editor now that
      // Cortex owns its own door. Read them directly so what is saved stays
      // visible here.
      const res = await apiFetch(`/api/secrets/${secret}`);
      if (res.status === 404) {
        setHasValue(false);
      } else if (!res.ok) {
        throw new Error(`Load failed: ${res.status}`);
      } else {
        const data = await res.json();
        const v = typeof data.value === 'string' ? data.value : '';
        setHasValue(Boolean(v) || data.value === undefined);
        if (!masked) {
          setValue(v);
          setSavedValue(v);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!value.trim()) return;
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const res = await apiFetch(`/api/secrets/${secret}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: value.trim() }),
      });
      if (!res.ok) throw new Error(`Save failed: ${res.status}`);
      if (masked) {
        setValue('');
        setSavedValue('');
      } else {
        setSavedValue(value.trim());
        setValue(value.trim());
      }
      setHasValue(true);
      setMessage('Saved');
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const res = await apiFetch(`/api/secrets/${secret}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`Clear failed: ${res.status}`);
      setValue('');
      setSavedValue('');
      setHasValue(false);
      setMessage('Cleared');
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Clear failed');
    } finally {
      setSaving(false);
    }
  }

  const hasDraft = value.trim().length > 0 && value.trim() !== savedValue;

  /** Fetch the stored value on demand. Kept out of load() so the default for a
   *  masked row stays "not on screen" — revealing is a thing she asks for. */
  async function fetchSecret(): Promise<string | null> {
    try {
      const res = await apiFetch(`/api/secrets/${secret}`);
      if (!res.ok) throw new Error(`Read failed: ${res.status}`);
      const data = await res.json();
      return typeof data.value === 'string' ? data.value : null;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read it');
      return null;
    }
  }

  async function toggleReveal() {
    if (revealed) {
      // Put it back exactly as it was: blank, so nothing lingers on screen.
      setRevealed(false);
      setValue('');
      setSavedValue('');
      return;
    }
    const v = await fetchSecret();
    if (v === null) return;
    // savedValue matches, so showing it does not look like an unsaved edit.
    setValue(v);
    setSavedValue(v);
    setRevealed(true);
  }

  async function copySecret() {
    // An unmasked row is already showing the real thing, so there is nothing to
    // go and fetch. Only a masked, unrevealed one has to ask.
    const v = !masked || revealed ? value : await fetchSecret();
    if (!v) return;
    if (await copyToClipboard(v)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
      return;
    }
    // The APK's WebView can refuse the clipboard. Say so rather than showing a
    // tick for something that did not happen.
    setError(masked ? 'Clipboard refused — tap the eye and copy by hand' : 'Clipboard refused — select it and copy by hand');
  }

  if (loading) {
    return (
      <div className={cn('flex items-center justify-center gap-2 py-2 text-xs', colors.textMuted)}>
        <Loader2 size={14} className="animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <input
          type={masked && !revealed ? 'password' : 'text'}
          value={value}
          onChange={(e) => { setValue(e.target.value); setRevealed(false); }}
          placeholder={masked && hasValue ? 'saved — type to replace' : placeholder}
          className={cn(
            'flex-1 bg-transparent focus:outline-none text-xs px-2 py-1.5 rounded-md border',
            colors.panelBorder,
            colors.textMain,
          )}
        />
        {/* Show/hide only means anything on a masked row. COPY means something on
            both: the worker URL is on screen but she still had to select it by
            hand on a phone to paste it into a connector dialog. */}
        {masked && hasValue && !hasDraft && (
          <>
            <button
              onClick={toggleReveal}
              className={cn('rounded-md p-1.5', 'hover:bg-black/5 dark:hover:bg-white/5')}
              style={{ color: colors.accent }}
              title={revealed ? 'Hide' : 'Show'}
              aria-label={revealed ? 'Hide the saved value' : 'Show the saved value'}
            >
              {revealed ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
          </>
        )}
        {hasValue && !hasDraft && (
          <button
            onClick={copySecret}
            className={cn('rounded-md p-1.5', 'hover:bg-black/5 dark:hover:bg-white/5')}
            style={{ color: colors.accent }}
            title="Copy"
            aria-label="Copy the saved value"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        )}
        {hasDraft && (
          <button
            onClick={save}
            disabled={saving}
            className="rounded-md px-3 py-1.5 text-[11px] font-semibold disabled:opacity-50"
            style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}
          >
            {saving ? <Loader2 size={11} className="animate-spin inline" /> : 'Save'}
          </button>
        )}
        {hasValue && !hasDraft && (
          <button
            onClick={clear}
            disabled={saving}
            className={cn('rounded-md p-1.5', colors.textMuted, 'hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40')}
            style={{ color: colors.accent }}
            title="Clear"
          >
            {saving ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={12} />}
          </button>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 min-h-[1rem]">
        {hasValue && !hasDraft && (
          <span className={cn('text-[10px] uppercase tracking-wider', colors.textMuted)} style={{ color: colors.accent }}>
            Saved
          </span>
        )}
        {message && <span className="text-[10px]" style={{ color: colors.accent }}>{message}</span>}
        {error && <span className="text-[10px]" style={{ color: colors.accent, opacity: 0.8 }}>{error}</span>}
      </div>
    </>
  );
}

export function CortexUrl({ themeConfig, themeMode, onSaved }: Props) {
  const colors = themeConfig[themeMode];

  return (
    <section className={cn("space-y-4 p-4 rounded-2xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
      <h3 className={cn('micro-label', colors.accentText)}>Cortex (Memory)</h3>
      <div className="space-y-3">
        <p className={cn('text-[10px] leading-relaxed', colors.textMuted)}>
          Your companions' long-term memory. Optional: without it, Blocks and
          Self-Knowledge still work. Changes take effect immediately.
        </p>
        <p className={cn('text-[10px] leading-relaxed', colors.textMuted)}>
          Don't have one? Deploy <span className="font-mono">workers/cortex</span> —
          its readme is four steps. Both fields below belong to it: the address it
          answers on, and the token it refuses to serve without.
        </p>

        <div className="space-y-1">
          <p className={cn('text-[10px] uppercase tracking-wider', colors.textMuted)}>Worker URL</p>
          <SecretRow
            secret="cortex_mcp_url"
            placeholder="https://….workers.dev"
            themeConfig={themeConfig}
            themeMode={themeMode}
            onSaved={onSaved}
          />
        </div>

        <div className="space-y-1">
          <p className={cn('text-[10px] uppercase tracking-wider', colors.textMuted)}>Worker token</p>
          <SecretRow
            secret="cortex_auth_token"
            placeholder="the CORTEX_AUTH_TOKEN you set on the worker"
            masked
            themeConfig={themeConfig}
            themeMode={themeMode}
            onSaved={onSaved}
          />
        </div>
      </div>
    </section>
  );
}
