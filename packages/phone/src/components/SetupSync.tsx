import React, { useState } from 'react';
import { Loader2, UploadCloud, DownloadCloud } from 'lucide-react';
import localforage from 'localforage';
import { cn } from '../lib/utils';
import { apiFetch } from '../bytelight';
import type { ThemeConfig } from '../lib/theme';

interface Props {
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

// Everything worth carrying that lives outside the theme/contacts/appSettings
// trio: reactions + bookmarks, Studio picks, Press rail state, game bests,
// radar notes. All small JSON/scalar strings — safe to ride along in the
// server blob next to the wallpapers.
export const EXTRA_KEYS = [
  'bytelight_metadata',
  'bytelight-studio-backend',
  'bytelight-studio-codex-model',
  'bytelight-studio-cf-model',
  'bytelight-studio-agy-model',
  'bytelight-studio-openart-model',
  'bytelight-studio-history',
  'bytelight.press.spread-rail-collapsed',
  'core_defense_best',
  'firewall_breach_best',
  'radar_ping_best',
  'radar_reaction_best',
  'signal_glide_high_score',
  'signal_landing_best',
  'radar_os_notes',
];

export function collectLocalExtras(): Record<string, string> {
  const extras: Record<string, string> = {};
  for (const key of EXTRA_KEYS) {
    const value = localStorage.getItem(key);
    if (value !== null) extras[key] = value;
  }
  return extras;
}

export function applyLocalExtras(extras: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(extras)) {
    if (!EXTRA_KEYS.includes(key) || typeof value !== 'string') continue;
    try {
      localStorage.setItem(key, value);
    } catch {
      // quota — skip this key, the big data lives in localforage anyway
    }
  }
}

function readLocalJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Setup Sync — explicit send/bring for the whole device setup. The
// automatic sync (settings-sync.ts) covers theme/contacts/appSettings
// passively; these buttons exist so moving into a new browser or the
// APK is one deliberate tap on each side, extras included, with
// failures shown instead of swallowed.
export function SetupSync({ themeConfig, themeMode }: Props) {
  const colors = themeConfig[themeMode];
  const [busy, setBusy] = useState<'send' | 'bring' | null>(null);
  const [confirmArmed, setConfirmArmed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setBusy('send');
    setError(null);
    setMessage(null);
    setConfirmArmed(false);
    try {
      const [theme, contacts, appSettings] = await Promise.all([
        localforage.getItem('bytelight_theme'),
        localforage.getItem('bytelight_contacts'),
        localforage.getItem('bytelight_settings'),
      ]);
      const blob = {
        theme: theme ?? readLocalJson('bytelight_theme'),
        contacts: contacts ?? readLocalJson('bytelight_contacts'),
        appSettings: appSettings ?? readLocalJson('bytelight_settings'),
        extras: collectLocalExtras(),
      };
      const body = JSON.stringify({ settings: blob });
      const sizeMb = (body.length / (1024 * 1024)).toFixed(1);
      const res = await apiFetch('/api/app-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (!res.ok) {
        throw new Error(
          res.status === 404
            ? 'The house needs its restart first — the sync door ships with the next backend start.'
            : res.status === 413 || res.status >= 500
              ? `The house refused ${sizeMb} MB (HTTP ${res.status}). If the backend hasn't restarted since the door was widened, restart it and tap again.`
              : `Send failed (HTTP ${res.status})`,
        );
      }
      setMessage(`Setup sent — ${sizeMb} MB stored in the house.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Send failed');
    } finally {
      setBusy(null);
    }
  }

  async function bring() {
    if (!confirmArmed) {
      setConfirmArmed(true);
      setError(null);
      setMessage("This replaces this device's setup with the house copy. Tap again to do it.");
      return;
    }
    setBusy('bring');
    setError(null);
    setMessage(null);
    setConfirmArmed(false);
    try {
      const res = await apiFetch('/api/app-settings');
      if (res.status === 404) {
        throw new Error('The house needs its restart first — the sync door ships with the next backend start.');
      }
      if (!res.ok) throw new Error(`Fetch failed (HTTP ${res.status})`);
      // Shape-validate instead of trusting res.ok — an old backend's SPA
      // fallback answers unknown routes with 200 + HTML.
      let data: { settings?: Record<string, unknown> | null };
      try {
        data = await res.json();
      } catch {
        throw new Error('The house gave a non-JSON answer — backend may need a restart.');
      }
      const blob = data?.settings;
      if (!blob || typeof blob !== 'object') {
        setError('The house has no saved setup yet — send one from the device where things look right.');
        return;
      }
      if (blob.theme) await localforage.setItem('bytelight_theme', blob.theme);
      if (blob.contacts) await localforage.setItem('bytelight_contacts', blob.contacts);
      if (blob.appSettings) await localforage.setItem('bytelight_settings', blob.appSettings);
      // Best-effort localStorage mirrors so first paint isn't default;
      // oversized values just stay localforage-only like they do today.
      for (const [key, value] of [
        ['bytelight_theme', blob.theme],
        ['bytelight_contacts', blob.contacts],
        ['bytelight_settings', blob.appSettings],
      ] as const) {
        if (!value) continue;
        try {
          localStorage.setItem(key, JSON.stringify(value));
        } catch {
          // quota — localforage copy is the one boot trusts anyway
        }
      }
      if (blob.extras && typeof blob.extras === 'object') {
        applyLocalExtras(blob.extras as Record<string, unknown>);
      }
      setMessage('Setup brought home — reloading…');
      setTimeout(() => window.location.reload(), 600);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bring failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className={cn('space-y-4 p-4 rounded-2xl border backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
      <h3 className={cn('micro-label', colors.accentText)}>Setup Sync</h3>
      <p className={cn('text-xs leading-relaxed', colors.textMuted)}>
        Theme, wallpapers, contacts, dock, custom emojis, Studio picks, game
        bests, radar notes. Send from the device that looks right; bring on
        the one that doesn&apos;t.
      </p>
      <div className="grid grid-cols-1 gap-2">
        <button
          onClick={send}
          disabled={busy !== null}
          className="w-full py-3 rounded-2xl font-bold text-sm flex items-center justify-center gap-2 transition-all duration-300 hover:scale-[1.01] active:scale-[0.98] disabled:opacity-50"
          style={{ backgroundColor: colors.accent, color: 'var(--bytelight-on-accent)' }}
        >
          {busy === 'send' ? <Loader2 size={16} className="animate-spin" /> : <UploadCloud size={16} />}
          Send my setup to the house
        </button>
        <button
          onClick={bring}
          disabled={busy !== null}
          className={cn(
            'w-full py-3 rounded-2xl font-bold text-sm flex items-center justify-center gap-2 border transition-all duration-300 hover:scale-[1.01] active:scale-[0.98] disabled:opacity-50',
            colors.panelBorder,
            colors.textMain,
          )}
          style={confirmArmed ? { borderColor: colors.accent, color: colors.accent } : undefined}
        >
          {busy === 'bring' ? <Loader2 size={16} className="animate-spin" /> : <DownloadCloud size={16} />}
          {confirmArmed ? 'Tap again to overwrite this device' : 'Bring my setup here'}
        </button>
      </div>
      {message && <p className={cn('text-xs', colors.accentText)}>{message}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </section>
  );
}
