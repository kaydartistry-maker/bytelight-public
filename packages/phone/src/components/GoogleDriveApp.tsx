import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Copy, ExternalLink, Loader2, Unplug } from 'lucide-react';
import { apiFetch } from '../bytelight';
import { cn } from '../lib/utils';
import type { ThemeConfig } from '../lib/theme';
import { copyToClipboard } from '../lib/clipboard';

type Status = { configured: boolean; connected: boolean; account?: string; redirectUri?: string };

export function GoogleDriveApp({ themeConfig, themeMode }: { themeConfig: ThemeConfig; themeMode: 'light' | 'dark' }) {
  const colors = themeConfig[themeMode];
  const [status, setStatus] = useState<Status | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  const callback = status?.redirectUri || `${window.location.origin}/api/auth/google-drive/callback`;

  async function load() {
    const res = await apiFetch('/api/integrations/google-drive/status');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not read Google Drive status.');
    setStatus(data);
    return data as Status;
  }

  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : 'Status failed.'));
    return () => { if (poll.current) clearInterval(poll.current); };
  }, []);

  async function configure() {
    if (!clientId.trim() || !clientSecret.trim()) { setError('Both OAuth fields are required.'); return; }
    setBusy(true); setError(null);
    try {
      const res = await apiFetch('/api/integrations/google-drive/configure', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId, clientSecret }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not save Google OAuth settings.');
      setClientId(''); setClientSecret(''); await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Setup failed.'); }
    finally { setBusy(false); }
  }

  async function connect() {
    setBusy(true); setError(null);
    try {
      const res = await apiFetch('/api/integrations/google-drive/login', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) throw new Error(data.error || 'Could not start Google sign-in.');
      window.open(data.url, '_blank', 'noopener,noreferrer');
      if (poll.current) clearInterval(poll.current);
      poll.current = setInterval(async () => {
        try {
          const next = await load();
          if (next.connected && poll.current) { clearInterval(poll.current); poll.current = null; setBusy(false); }
        } catch { /* keep polling while the sign-in window is open */ }
      }, 2000);
      setTimeout(() => { if (poll.current) { clearInterval(poll.current); poll.current = null; setBusy(false); } }, 120_000);
    } catch (e) { setError(e instanceof Error ? e.message : 'Connection failed.'); setBusy(false); }
  }

  async function disconnect() {
    if (!window.confirm('Disconnect Google Drive from Virelle? Your files will not be changed.')) return;
    setBusy(true); setError(null);
    try {
      const res = await apiFetch('/api/integrations/google-drive/disconnect', { method: 'POST' });
      if (!res.ok) throw new Error('Disconnect failed.');
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Disconnect failed.'); }
    finally { setBusy(false); }
  }

  async function copyCallback() {
    const ok = await copyToClipboard(callback);
    setCopied(ok);
    setError(ok ? null : 'Your phone refused clipboard access. Press and hold the address below to copy it.');
    if (ok) setTimeout(() => setCopied(false), 1800);
  }

  const button = 'rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-2';
  return (
    <div className="space-y-3">
      <div data-appearance-card="" className={cn('rounded-2xl border p-4', colors.panelBg, colors.panelBorder)}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className={cn('font-semibold', colors.textMain)}>Google Drive & Docs</h3>
            <p className={cn('text-xs mt-1', colors.textMuted)}>One controlled doorway for Codex, Claude, Gemini/Neon, and read-only wakes.</p>
          </div>
          <div className={cn('text-xs font-semibold', status?.connected ? 'text-emerald-500' : colors.textMuted)}>
            {status?.connected ? 'Connected' : status?.configured ? 'Ready' : 'Setup needed'}
          </div>
        </div>

        {status?.connected ? (
          <div className="mt-4 space-y-3">
            <div className="flex items-center gap-2 text-sm text-emerald-500"><CheckCircle2 size={17} />{status.account || 'Google account connected'}</div>
            <p className={cn('text-xs', colors.textMuted)}>Companions may search and read Docs. Writes require your explicit request in the current interactive message; autonomous wakes cannot write.</p>
            <button disabled={busy} onClick={disconnect} className={cn(button, 'border', colors.panelBorder, colors.textMain)}><Unplug size={16} />Disconnect</button>
          </div>
        ) : status?.configured ? (
          <div className="mt-4">
            <button disabled={busy} onClick={connect} className={button} style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}>
              {busy ? <Loader2 size={16} className="animate-spin" /> : <ExternalLink size={16} />}Connect Google account
            </button>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <p className={cn('text-xs', colors.textMuted)}>Create a Google Cloud OAuth client of type <b>Web application</b>, enable the Google Drive and Google Docs APIs, then paste the callback address below into <b>Authorized redirect URIs</b>.</p>
            <p className={cn('text-[11px] font-semibold', colors.textMain)}>Do not open this address. Google uses it to return you to Virelle after sign-in.</p>
            <div className={cn('rounded-xl border p-2 text-[11px] break-all select-all', colors.panelBorder, colors.textMain)}>{callback}</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button type="button" onClick={copyCallback} className={cn(button, 'border', colors.panelBorder, colors.textMain)}>
                <Copy size={16} />{copied ? 'Copied' : 'Copy redirect URI'}
              </button>
              <button type="button" onClick={() => window.open('https://console.cloud.google.com/apis/credentials', '_blank', 'noopener,noreferrer')} className={cn(button, 'border', colors.panelBorder, colors.textMain)}>
                <ExternalLink size={16} />Open Google Cloud setup
              </button>
            </div>
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="OAuth client ID" className={cn('w-full rounded-xl border bg-transparent px-3 py-2 text-sm', colors.panelBorder, colors.textMain)} />
            <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="OAuth client secret" className={cn('w-full rounded-xl border bg-transparent px-3 py-2 text-sm', colors.panelBorder, colors.textMain)} />
            <button disabled={busy} onClick={configure} className={button} style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}>
              {busy && <Loader2 size={16} className="animate-spin" />}Save OAuth setup
            </button>
          </div>
        )}
        {error && <p className="text-xs mt-3 text-red-500">{error}</p>}
      </div>

      <div className={cn('rounded-2xl border p-4', colors.panelBg, colors.panelBorder)}>
        <h4 className={cn('text-sm font-semibold', colors.textMain)}>House boundaries</h4>
        <ul className={cn('text-xs mt-2 space-y-1.5', colors.textMuted)}>
          <li>• No automatic bulk ingestion or background Drive crawl.</li>
          <li>• Search and reads appear in the normal tool receipts.</li>
          <li>• Disconnect removes Virelle’s local token; it never deletes a Doc.</li>
        </ul>
      </div>
    </div>
  );
}
