import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings } from '../types';
import type { ThemeColors } from '../lib/theme';
import { cn } from '../lib/utils';
import { Toggle } from './Toggle';
import {
  isWebPushEnabled, readWebPushDeviceState, sendTestPush, setupWebPush,
  subscribeWebPush, unsubscribeWebPush, setWebPushDevicePreferences, type WebPushDeviceState,
} from '../bytelight/push';

export interface PushNotificationsPanelProps {
  colors: ThemeColors;
  // API-compatible with SettingsDashboard. Browser subscriptions are device
  // state, so this panel must not read/write its install-wide legacy flag.
  appSettings?: Omit<AppSettings, 'theme' | 'contacts'>;
  onSettingsChange?: (settings: Partial<Omit<AppSettings, 'theme' | 'contacts'>>) => void;
}

/** Web/PWA panel. The caller retains its existing Capacitor/FCM native panel. */
export function PushNotificationsPanel({ colors }: PushNotificationsPanelProps) {
  const [device, setDevice] = useState<WebPushDeviceState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [contact, setContact] = useState(() => typeof window !== 'undefined' && window.location.protocol === 'https:' ? window.location.origin : '');
  const mounted = useRef(true);
  const sequence = useRef(0);
  const inAction = useRef(false);

  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const state = await readWebPushDeviceState();
      if (mounted.current && request === sequence.current) setDevice(state);
    } catch (err) {
      if (mounted.current && request === sequence.current) {
        setDevice(null); // Unknown readiness must never appear as enabled.
        setError(err instanceof Error ? err.message : 'Could not check notifications.');
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const recheck = () => { if (!inAction.current && document.visibilityState !== 'hidden') void refresh(); };
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', recheck);
    return () => {
      mounted.current = false;
      sequence.current++;
      window.removeEventListener('focus', recheck);
      document.removeEventListener('visibilitychange', recheck);
    };
  }, [refresh]);

  const act = async (name: string, action: () => Promise<void>) => {
    if (inAction.current) return;
    inAction.current = true;
    sequence.current++; // Invalidate an older background status refresh.
    setBusy(name);
    setError(null);
    setNotice(null);
    try { await action(); }
    catch (err) { if (mounted.current) setError(err instanceof Error ? err.message : String(err)); }
    finally {
      await refresh();
      inAction.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  const enabled = !!device && isWebPushEnabled(device);
  const ready = !!device?.server.webPush.configured && !!device?.server.webPush.publicKey;
  const cannotEnable = !device?.supported || !ready || device.permission === 'denied'
    || device.keyMismatch || (device.ios && !device.installed);
  const buttonClass = cn('rounded-lg border px-3 py-2 text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed', colors.panelBorder, colors.textMain);

  return (
    <section className={cn('space-y-4 p-4 rounded-2xl border backdrop-blur-md', colors.panelBg, colors.panelBorder)} aria-label="Notifications">
      <h3 className={cn('micro-label', colors.accentText)}>Notifications</h3>
      <div className="flex items-center justify-between gap-4">
        <div>
          <span className={cn('block text-sm font-medium', colors.textMain)}>Push notifications on this device</span>
          <span className={cn('text-xs', colors.textMuted)}>
            {!device ? error ? 'Status unavailable. Check the error below, then try again.' : 'Checking server and device…' : enabled ? 'This device is registered and notifications are allowed.' : 'Enable alerts for messages while you are away.'}
          </span>
        </div>
        <Toggle on={enabled} disabled={!!busy || !device || (!enabled && cannotEnable)} colors={colors}
          ariaLabel="Toggle push notifications on this device"
          onClick={() => {
            if (enabled) void act('Disabling…', unsubscribeWebPush);
            // No await before this call: the prepared key preserves the iOS tap.
            else if (device?.server.webPush.publicKey) void act('Enabling…', () => subscribeWebPush(device.server.webPush.publicKey!));
          }} />
      </div>

      {device && (
        <dl className={cn('grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs', colors.textMuted)}>
          <dt>Server</dt><dd>{ready ? 'Web push ready' : device.server.webPush.setupState === 'empty' ? 'Not set up yet' : 'Saved setup needs attention'}</dd>
          <dt>Permission</dt><dd>{device.permission === 'unsupported' ? 'Unavailable in this browser' : device.permission === 'default' ? 'Not requested yet' : device.permission === 'denied' ? 'Blocked in device settings' : 'Allowed'}</dd>
          <dt>This device</dt><dd>{device.keyMismatch ? 'Old push key — remove registration first' : device.subscribed && device.registered ? 'Registered' : device.subscribed ? 'Browser subscription needs server registration' : 'Not subscribed'}</dd>
        </dl>
      )}

      {device?.ios && !device.installed && (
        <p className={cn('text-xs leading-relaxed', colors.textMain)}>On iPhone/iPad, open this site in Safari, choose Share → Add to Home Screen, then open it from its app icon. Web push requires iOS/iPadOS 16.4 or later.</p>
      )}
      {device && !device.supported && !device.ios && (
        <p className={cn('text-xs', colors.textMuted)}>This browser does not expose web push. Use a supported browser on the app’s HTTPS address.</p>
      )}
      {device?.permission === 'denied' && (
        <p className={cn('text-xs', colors.textMuted)}>Notifications are blocked for this app. Allow them in your device or browser notification settings, then return here and check status.</p>
      )}

      {device?.registered && (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-4">
            <span className={cn('text-xs font-medium', colors.textMain)}>Notify this device even when another app window is open</span>
            <Toggle on={device.notifyWhileConnected} disabled={!!busy || (!device.notifyWhileConnected && !enabled)} colors={colors}
              ariaLabel="Notify this device even when another app window is open"
              onClick={() => void act('Saving device preference…', () => setWebPushDevicePreferences(device.endpoint!, !device.notifyWhileConnected))} />
          </div>
          <p className={cn('text-xs leading-relaxed', colors.textMuted)}>Off by default. Turning this on also allows alerts while this device’s own app is open. It affects only this registered browser, not your other devices.</p>
        </div>
      )}

      {device && !ready && (
        <form className="space-y-2" onSubmit={(event) => {
          event.preventDefault();
          void act('Setting up…', async () => { await setupWebPush(contact); if (mounted.current) setNotice('Server setup is ready. Now enable notifications on this device.'); });
        }}>
          <label className={cn('block text-xs', colors.textMain)}>
            Contact URI for web push
            <input type="text" value={contact} onChange={e => setContact(e.target.value)} disabled={!!busy}
              placeholder="https://your-app.example or mailto:you@example.com"
              className={cn('mt-1 block w-full rounded-lg border bg-transparent p-2 text-xs', colors.panelBorder, colors.textMain)} />
          </label>
          <p className={cn('text-xs leading-relaxed', colors.textMuted)}>Your app’s HTTPS address can be used here. Setup creates encrypted server keys only when no setup exists, preserves existing keypairs, and never sends a notification.</p>
          {device.server.webPush.setupState === 'partial' && <p className={cn('text-xs', colors.textMuted)}>The saved setup is incomplete. Restore its matching keypair in Secrets; setup will not rotate or replace it.</p>}
          <button type="submit" disabled={!!busy || !contact.trim()} className={buttonClass}>{busy === 'Setting up…' ? busy : device.server.webPush.setupState === 'empty' ? 'Set up web push' : 'Activate saved web push'}</button>
        </form>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!!busy} className={buttonClass} onClick={() => { setError(null); void refresh(); }}>Check status</button>
        {device?.subscribed && !enabled && <button type="button" className={buttonClass} disabled={!!busy} onClick={() => void act('Removing…', unsubscribeWebPush)}>Remove this device registration</button>}
        {enabled && <button type="button" className={buttonClass} disabled={!!busy} onClick={() => void act('Testing…', async () => {
          const result = await sendTestPush(device.endpoint!);
          if (mounted.current) setNotice(`Push service accepted ${result.delivery.accepted} test notification. Check this device; display or receipt is not confirmed.`);
        })}>{busy === 'Testing…' ? 'Testing…' : 'Send a test to this device'}</button>}
      </div>
      {busy && <p role="status" className={cn('text-xs', colors.textMuted)}>{busy}</p>}
      {notice && <p role="status" className={cn('text-xs', colors.textMain)}>{notice}</p>}
      {error && <p role="alert" className={cn('text-xs', colors.textMain)}>{error}</p>}
      <p className={cn('text-xs leading-relaxed', colors.textMuted)}>By default, message alerts wait until all app windows are disconnected. The per-device option above can override that for this browser. Device Focus and notification settings also control how alerts appear.</p>
    </section>
  );
}

export default PushNotificationsPanel;
