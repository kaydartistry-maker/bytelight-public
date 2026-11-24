import React, { useState } from 'react';
import { Loader2, UploadCloud, DownloadCloud } from 'lucide-react';
import { cn } from '../lib/utils';
import { syncNow } from '../lib/sync';
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


// Setup Sync — explicit send/bring for the whole device setup. The
// automatic sync (lib/sync.ts: pull on open, send on Apply) covers the same
// passively; these buttons exist so moving into a new browser or the
// APK is one deliberate tap on each side, extras included, with
// failures shown instead of swallowed.
export function SetupSync({ themeConfig, themeMode }: Props) {
  const colors = themeConfig[themeMode];
  const [busy, setBusy] = useState<'send' | 'bring' | null>(null);
  const [confirmArmed, setConfirmArmed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Slice 8: both buttons go through the sync engine (lib/sync.ts): pictures,
  // fonts, Closet looks and moving videos travel as files; furniture and
  // connection settings stay on each device.
  async function send() {
    setBusy('send');
    setError(null);
    setMessage(null);
    setConfirmArmed(false);
    const r = await syncNow('send');
    if (r.ok) setMessage(`Setup sent to the house${r.detail ? ` (${r.detail})` : ''}. Your other devices pick it up when they open.`);
    else setError(`Send failed: ${'reason' in r ? r.reason : 'unknown'}.`);
    setBusy(null);
  }

  async function bring() {
    if (!confirmArmed) {
      setConfirmArmed(true);
      setError(null);
      setMessage("This replaces this device's look, fonts and Closet with the house copy. Your dock, widgets and lock layout stay. Tap again to do it.");
      return;
    }
    setBusy('bring');
    setError(null);
    setMessage(null);
    setConfirmArmed(false);
    const r = await syncNow('bring');
    if (r.ok) setMessage('Setup brought home.');
    else setError(`Bring failed: ${'reason' in r ? r.reason : 'unknown'}.`);
    setBusy(null);
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
