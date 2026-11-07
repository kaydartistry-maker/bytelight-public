import { useEffect, useState } from 'react';
import { Download, Loader2, Check, Smartphone } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { cn } from '../lib/utils';
import { apiFetch } from '../bytelight';
import type { ThemeConfig } from '../lib/theme';

interface Props {
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

interface StagedShell {
  available: boolean;
  versionCode?: number;
  versionName?: string;
  builtAt?: string;
  notes?: string;
  bytes?: number;
}

/**
 * The Android shell's update lane, with a button on it.
 *
 * /api/app/version and /api/app/download have existed since the shell did,
 * and nothing ever called them — so installing a new shell meant typing the
 * download URL in by hand. The routes were the hard part; this is the door.
 *
 * The served UI ships with every build, so this card only speaks up when the
 * NATIVE layer moved: it compares the running build number against the staged
 * one and stays quiet when they match. In a browser there is no shell to
 * update, so it offers the download instead of pretending to compare.
 */
export function AppUpdate({ themeConfig, themeMode }: Props) {
  const colors = themeConfig[themeMode];
  const [staged, setStaged] = useState<StagedShell | null>(null);
  const [installed, setInstalled] = useState<{ version: string; build: number } | null>(null);
  const [loading, setLoading] = useState(true);

  const native = Capacitor.isNativePlatform();

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await apiFetch('/api/app/version');
        // A phone build can reach a backend that predates this route, and the
        // SPA fallback answers those with 200 + HTML. Shape-check before use.
        const data: unknown = res.ok ? await res.json() : null;
        if (!cancelled && data && typeof data === 'object' && 'available' in data) {
          setStaged(data as StagedShell);
        }
      } catch {
        /* no shell staged, or no route — the card simply says nothing */
      }

      if (native) {
        try {
          const info = await CapApp.getInfo();
          const build = Number.parseInt(info.build, 10);
          if (!cancelled) {
            setInstalled({ version: info.version, build: Number.isNaN(build) ? 0 : build });
          }
        } catch {
          /* older shell without the App plugin — fall back to offering it */
        }
      }

      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [native]);

  if (loading || !staged?.available) return null;

  const stagedCode = staged.versionCode ?? 0;
  const upToDate = installed !== null && installed.build >= stagedCode;
  const readableSize = staged.bytes ? `${Math.round(staged.bytes / 1024 / 1024)} MB` : null;

  return (
    <section className={cn('space-y-4 p-4 rounded-2xl border backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
      <h3 className={cn('micro-label', colors.accentText)}>Android App</h3>
      <div className="space-y-3">
        <div className="flex items-start gap-3">
          <Smartphone size={16} className="mt-0.5 shrink-0" style={{ color: colors.accent }} />
          <div className="min-w-0 flex-1">
            <span className={cn('block text-sm font-medium', colors.textMain)}>
              {upToDate ? `Up to date — v${installed?.version}` : `Version ${staged.versionName} available`}
            </span>
            <span className={cn('block text-[11px] leading-relaxed', colors.textMuted)}>
              {installed && !upToDate && `You're on v${installed.version}. `}
              {!native && 'The house serves its own build. '}
              {readableSize}
            </span>
          </div>
        </div>

        {staged.notes && !upToDate && (
          <p className={cn('text-[10px] leading-relaxed', colors.textMuted)}>{staged.notes}</p>
        )}

        {upToDate ? (
          <div className={cn('flex items-center gap-1.5 text-[10px] uppercase tracking-wider', colors.textMuted)}>
            <Check size={12} style={{ color: colors.accent }} /> Nothing to install
          </div>
        ) : (
          <>
            {/* An ordinary link, deliberately. The route already answers with
                Content-Disposition, which is the one thing the shell's
                DownloadListener waits to hear — so this lands in Downloads
                with the session cookie attached, same as always. */}
            <a
              href="/api/app/download"
              className="flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-xs font-semibold active:scale-[0.99]"
              style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}
            >
              <Download size={14} />
              {native ? 'Download update' : 'Download the app'}
            </a>
            <p className={cn('text-[10px] leading-relaxed', colors.textMuted)}>
              Signed with the same key, so it installs over the top — nothing to
              uninstall. Android will ask you to confirm; open it from your
              notifications when the download finishes.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
