// Codex engine card for Agent -> Runtime: is Codex signed in, on which login,
// until when, and a way to the Providers card when it is not.
import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { cn } from '../lib/utils';
import type { ThemeConfig } from '../lib/theme';
import { apiFetch } from '../bytelight';
import { codexEngineView, expiresIn, type CodexStatus } from './engine-status';

const STATUS_COLOR = { red: '#e5484d', green: '#30a46c' } as const;

interface CodexEngineCardProps {
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  /** Opens Integrations (it lands on Providers, where Codex signs in). */
  onOpenProviders?: () => void;
}

export function CodexEngineCard({ themeConfig, themeMode, onOpenProviders }: CodexEngineCardProps) {
  const colors = themeConfig[themeMode];
  const [status, setStatus] = useState<CodexStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/auth/codex/status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus(await res.json());
      setFailed(false);
    } catch (err) {
      console.error('[Bytelight] Codex status failed:', err);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const view = codexEngineView(status);
  const color = view.ok ? STATUS_COLOR.green : STATUS_COLOR.red;
  const expiry = expiresIn(view.expiresAt);

  const row = (label: string, value: React.ReactNode) => (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className={cn('text-[11px]', colors.textMuted)}>{label}</span>
      <span className={cn('text-right text-[11px]', colors.textMain)}>{value}</span>
    </div>
  );

  return (
    <section
      className={cn('mb-4 rounded-2xl border p-4 backdrop-blur-md', colors.panelBg, colors.panelBorder)}
      style={status ? { borderColor: color } : undefined}
    >
      <div className="mb-2 flex items-center gap-2">
        <h3 className={cn('flex-1 text-sm font-bold', colors.textMain)}>Codex (ChatGPT)</h3>
        <button
          onClick={() => void load()}
          disabled={loading}
          className={cn('rounded-full border p-1.5 disabled:opacity-50', colors.panelBorder, colors.textMuted)}
          aria-label="Refresh"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} />
        </button>
      </div>

      {failed && !status ? (
        <div className={cn('text-xs', colors.textMuted)}>Couldn't check Codex right now.</div>
      ) : !status ? (
        <div className={cn('text-xs', colors.textMuted)}>Checking…</div>
      ) : (
        <>
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold" style={{ color }}>
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />
            {view.ok ? 'Ready' : 'Not signed in'}
          </div>
          <div className={cn('border-t pt-1', colors.panelBorder)}>
            {row('Signed in with', view.login)}
            {expiry && row('Next renewal', expiry)}
          </div>
          {!view.ok && (
            <>
              <p className={cn('mt-2 text-[11px] leading-snug', colors.textMuted)}>
                Codex models can't answer until the house is signed in to ChatGPT.
              </p>
              {onOpenProviders && (
                <button
                  onClick={onOpenProviders}
                  className="mt-3 w-full rounded-lg py-2 text-xs font-semibold"
                  style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}
                >
                  Sign in on Integrations → Providers
                </button>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
