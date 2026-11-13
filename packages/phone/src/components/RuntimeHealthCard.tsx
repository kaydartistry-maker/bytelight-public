// Claude runtime health — which Agent SDK runtime is loaded vs installed vs
// what the configured models need, with a guarded in-app SDK update.
// Port of main's Svelte RuntimeHealthCard on main's
// GET /api/runtime/health and POST /api/runtime/update-sdk.
import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { cn } from '../lib/utils';
import type { ThemeConfig } from '../lib/theme';
import { apiFetch } from '../bytelight';
import { claudeHealthView, type ClaudeHealth as RuntimeHealth } from './engine-status';

interface SdkUpdateResult {
  success: boolean;
  newInstalledVersion?: string | null;
  activeVersion?: string | null;
  restartRequired?: boolean;
  message?: string;
  error?: string;
  stderrTail?: string;
  stdoutTail?: string;
}

interface RuntimeHealthCardProps {
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

const STATUS_COLOR = { red: '#e5484d', yellow: '#f5a524', green: '#30a46c' } as const;

export function RuntimeHealthCard({ themeConfig, themeMode }: RuntimeHealthCardProps) {
  const colors = themeConfig[themeMode];
  const [health, setHealth] = useState<RuntimeHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [lastResult, setLastResult] = useState<SdkUpdateResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/runtime/health');
      if (res.ok) setHealth(await res.json());
    } catch (err) {
      console.error('[Bytelight] Runtime health failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function refresh() {
    // A post-update banner is stale once she has refreshed (usually after
    // restarting the backend), so clear it with the re-read.
    setLastResult(null);
    await load();
  }

  async function runUpdate() {
    setConfirming(false);
    setUpdating(true);
    setLastResult(null);
    try {
      const res = await apiFetch('/api/runtime/update-sdk', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      setLastResult(await res.json());
    } catch (err) {
      setLastResult({ success: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      await load();
      setUpdating(false);
    }
  }

  // Both warnings can apply at once (right after upgrading to a model whose
  // minimum exceeded the old runtime) — red beats yellow beats green.
  // With the CLI lane on, the box's own Claude Code answers; the SDK numbers
  // below are kept for the SDK lane and its update button.
  const view = health ? claudeHealthView(health) : null;
  const outdated = !!view?.outdated;
  const restartRequired = !!view?.restartRequired;
  const headline: keyof typeof STATUS_COLOR = view?.headline ?? 'green';
  const statusLabel = view?.label ?? '';

  const row = (label: string, value: React.ReactNode) => (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className={cn('text-[11px]', colors.textMuted)}>{label}</span>
      <span className={cn('text-right font-mono text-[11px]', colors.textMain)}>{value}</span>
    </div>
  );

  return (
    <section
      className={cn('mb-4 rounded-2xl border p-4 backdrop-blur-md', colors.panelBg, colors.panelBorder)}
      style={health ? { borderColor: STATUS_COLOR[headline] } : undefined}
    >
      <div className="mb-2 flex items-center gap-2">
        <h3 className={cn('flex-1 text-sm font-bold', colors.textMain)}>Claude</h3>
        <button
          onClick={() => void refresh()}
          disabled={loading || updating}
          className={cn('rounded-full border p-1.5 disabled:opacity-50', colors.panelBorder, colors.textMuted)}
          aria-label="Refresh"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} />
        </button>
      </div>

      {loading && !health && (
        <div className={cn('flex items-center gap-2 text-xs', colors.textMuted)}>
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      )}
      {!loading && !health && <div className={cn('text-xs', colors.textMuted)}>Unable to read runtime health.</div>}

      {health && (
        <>
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold" style={{ color: STATUS_COLOR[headline] }}>
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[headline] }} />
            {statusLabel}
          </div>
          {outdated && health.minRequired && (
            <p className="mb-2 text-[11px] leading-snug" style={{ color: STATUS_COLOR.red }}>
              SDK runtime {health.activeRuntimeVersion} is below the minimum required by {health.minRequired.reason} ({health.minRequired.version}).
            </p>
          )}
          {restartRequired && (
            <p className="mb-2 text-[11px] leading-snug" style={{ color: STATUS_COLOR.yellow }}>
              The SDK on disk is newer than the one loaded — restart the backend to load it.
            </p>
          )}
          {view?.cliAnswering && (
            <p className={cn('mb-2 text-[11px] leading-snug', colors.textMuted)}>
              Chats go through the Claude Code app on the house's computer, signed in with your Claude subscription.
            </p>
          )}
          <div className={cn('border-t pt-1', colors.panelBorder)}>
            {row(view?.cliAnswering ? 'Claude Code (answering now)' : 'System Claude Code (terminal)', health.systemCcVersion ?? '—')}
            {row('SDK runtime (in memory)', health.activeRuntimeVersion ?? '—')}
            {row('SDK runtime (on disk)', health.installedRuntimeVersion ?? '—')}
            {row('Required by configured models', health.minRequired
              ? <>{health.minRequired.version} <span className="opacity-60">({health.minRequired.reason})</span></>
              : <span className="opacity-60">no minimum declared</span>)}
          </div>

          <button
            onClick={() => setConfirming(true)}
            disabled={updating}
            className="mt-3 w-full rounded-lg py-2 text-xs font-semibold disabled:opacity-60"
            style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}
          >
            {updating ? 'Updating…' : 'Update SDK'}
          </button>
          <p className={cn('mt-1.5 text-[10px] leading-snug opacity-70', colors.textMuted)}>
            Updating modifies package-lock.json. The new runtime loads after a backend restart.
          </p>

          {lastResult && (
            <div
              className="mt-3 rounded-xl border p-3 text-[11px] leading-snug"
              style={{ borderColor: lastResult.success ? STATUS_COLOR.green : STATUS_COLOR.red }}
            >
              {lastResult.success ? (
                <span className={colors.textMain}>
                  <strong>SDK updated.</strong> New installed runtime: {lastResult.newInstalledVersion ?? '—'}. Restart the backend to load it.
                </span>
              ) : (
                <div className={colors.textMain}>
                  <strong>Update failed.</strong>
                  <p className="mt-1">{lastResult.error ?? 'Unknown error'}</p>
                  {lastResult.stderrTail && (
                    <details className="mt-1">
                      <summary className="cursor-pointer opacity-70">stderr (last 2KB)</summary>
                      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[10px]">{lastResult.stderrTail}</pre>
                    </details>
                  )}
                  {lastResult.stdoutTail && (
                    <details className="mt-1">
                      <summary className="cursor-pointer opacity-70">stdout (last 2KB)</summary>
                      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[10px]">{lastResult.stdoutTail}</pre>
                    </details>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-6" onClick={() => setConfirming(false)}>
          <div
            className={cn('w-full max-w-xs rounded-2xl border p-5 shadow-2xl', colors.panelBg, colors.panelBorder)}
            onClick={(e) => e.stopPropagation()}
          >
            <h4 className={cn('mb-2 text-sm font-bold', colors.textMain)}>Update Claude Agent SDK?</h4>
            <p className={cn('mb-2 text-xs leading-relaxed', colors.textMuted)}>
              This runs <span className="font-mono">npm install @anthropic-ai/claude-agent-sdk@latest</span>, changing
              package-lock.json and possibly packages/backend/package.json.
            </p>
            <p className={cn('mb-4 text-xs leading-relaxed', colors.textMuted)}>
              After it finishes, restart the backend for the new runtime to load.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirming(false)}
                className={cn('rounded-lg border px-3 py-1.5 text-xs font-semibold', colors.panelBorder, colors.textMain)}
              >
                Cancel
              </button>
              <button
                onClick={() => void runUpdate()}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold"
                style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}
              >
                Update SDK
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
