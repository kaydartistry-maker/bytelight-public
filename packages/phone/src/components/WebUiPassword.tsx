import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { apiFetch } from '../bytelight';
import type { ThemeConfig } from '../lib/theme';
import { SecretInput } from './SecretInput';

interface Props {
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

// Web-UI password change. Lived under Agent → Models before — it's a
// security setting, not an agent setting, so it belongs in Settings → Data
// alongside the SecretsManager. Uses the same PUT /api/preferences flow
// PreferencesApp used to use.
export function WebUiPassword({ themeConfig, themeMode }: Props) {
  const colors = themeConfig[themeMode];
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!value.trim()) return;
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const res = await apiFetch('/api/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth: { password: value } }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Save failed (${res.status})`);
      setValue('');
      setMessage('Password updated. Restart the server for it to take effect.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={cn("space-y-4 p-4 rounded-2xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
      <h3 className={cn('micro-label', colors.accentText)}>Web UI Password</h3>
      <div className="space-y-3">
        <p className={cn('text-[10px] leading-relaxed', colors.textMuted)}>
          Sets the password the web UI prompts for at the lock screen. Leave
          blank to leave unchanged. Takes effect on the next server restart.
        </p>
        <SecretInput
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="••••••••"
          className={cn(
            'w-full bg-transparent focus:outline-none text-xs px-2 py-1.5 rounded-md border',
            colors.panelBorder,
            colors.textMain,
          )}
        />
        <div className="flex items-center justify-end gap-2">
          {message && <span className="text-[10px]" style={{ color: colors.accent }}>{message}</span>}
          {error && <span className="text-[10px]" style={{ color: colors.accent, opacity: 0.8 }}>{error}</span>}
          <button
            onClick={save}
            disabled={!value.trim() || saving}
            className="rounded-md px-3 py-1.5 text-[11px] font-semibold disabled:opacity-50"
            style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}
          >
            {saving ? <Loader2 size={11} className="animate-spin inline" /> : 'Save'}
          </button>
        </div>
      </div>
    </section>
  );
}
