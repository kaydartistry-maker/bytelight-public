// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Waking Spotify on their phone from inside the app (Oct 23 2026). A play tapped while Spotify is not running comes back as
// nowhere to play; in the installed app, SpotifyRemote (android
// SpotifyRemotePlugin.java, Spotify's App Remote kit) starts Spotify in the
// background and makes this phone the device that plays, and the press is
// sent once more (lib/spotify.ts pressAndLook). When the kit gives no answer
// (Oct 23 2026, their first try: it never called back and the press spun), the
// plugin sends Spotify a media play key instead, and the page waits for
// Spotify to show up among the owner devices before trying again. Nothing here can
// hold a press longer than WAKE_CEILING_MS. In a browser, or an app from
// before the kit, there is nothing to wake and the old sentence stands.

import { App as CapApp } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { SpotifyConnectView } from '@bytelight/shared';
import { apiFetch } from './api';

interface SpotifyRemoteBridge {
  status(): Promise<{ installed: boolean; connected: boolean }>;
  wake(options: SpotifyConnectView): Promise<{ connected: boolean; switched: boolean; road?: 'kit' | 'media-key' | 'none'; steps?: string[] }>;
}

/** The longest a wake may take, the native half's own nine-second wait included; a press never spins past it. */
const WAKE_CEILING_MS = 20_000;
/** After the media key, how long to watch for Spotify to show up as one of the owner devices. */
const DEVICE_WATCH_MS = 10_000;

function within<T>(work: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    work.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

/** Wait until Spotify lists a phone among the owner devices (it is running and signed in there), or give up. */
async function deviceShowsUp(): Promise<number | null> {
  const started = Date.now();
  while (Date.now() - started < DEVICE_WATCH_MS) {
    try {
      const res = await apiFetch('/api/spotify/devices');
      if (res.ok) {
        // A phone, specifically: a laptop with Spotify open would show up too,
        // and the point is that this phone is ready to play.
        const data = (await res.json()) as { devices?: Array<{ type?: unknown }> };
        if (Array.isArray(data.devices) && data.devices.some((d) => d && d.type === 'Smartphone')) return Date.now() - started;
      }
    } catch {
      // The next look tries again.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return null;
}

const SpotifyRemote = registerPlugin<SpotifyRemoteBridge>('SpotifyRemote');

/** True only in an installed app new enough to carry the Spotify kit. */
export function canWakeSpotify(): boolean {
  return Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('SpotifyRemote');
}

let connect: SpotifyConnectView | null = null;

async function connectInfo(): Promise<SpotifyConnectView | null> {
  if (connect) return connect;
  try {
    const res = await apiFetch('/api/spotify/connect');
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<SpotifyConnectView>;
    if (typeof data.clientId !== 'string' || typeof data.redirectUri !== 'string') return null;
    connect = { clientId: data.clientId, redirectUri: data.redirectUri };
    return connect;
  } catch {
    return null;
  }
}

/** One line in the house's error log, so a wake that did not work can be read afterwards. */
/** The installed app's version, so a wake line says which native code ran it. */
let appVersion: Promise<string> | null = null;
function installedVersion(): Promise<string> {
  appVersion ??= CapApp.getInfo().then((info) => info.version).catch(() => '?');
  return appVersion;
}

function report(message: string): void {
  void installedVersion().then((version) =>
    apiFetch('/api/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ where: 'spotify-wake', message: `[app ${version}] ${message}`, stack: '', componentStack: '' }),
    }),
  ).catch(() => {});
}

/**
 * Wake Spotify on this phone. True when it is running and connected (the
 * press is then worth sending again), false when there is nothing to wake
 * with or the kit refused, which it says in the house log.
 */
export async function wakeSpotify(): Promise<boolean> {
  if (!canWakeSpotify()) return false;
  const info = await connectInfo();
  if (!info) {
    report('no client id from /api/spotify/connect (backend before the restart?)');
    return false;
  }
  try {
    // The owner second try on Oct 23 2026 showed the kit starts Spotify and then
    // never calls back, so the page watches for Spotify to show up among the owner
    // devices from the start, and whichever comes first ends the wake.
    const started = Date.now();
    let watching = true;
    const watch = (async () => {
      while (watching && Date.now() - started < WAKE_CEILING_MS) {
        const after = await deviceShowsUp();
        if (after !== null) return Date.now() - started;
      }
      return null;
    })();
    const plugin = within(SpotifyRemote.wake(info), WAKE_CEILING_MS);
    const first = await Promise.race([
      watch.then((ms) => ({ from: 'devices' as const, ms })),
      plugin.then((answer) => ({ from: 'plugin' as const, answer })),
    ]);
    if (first.from === 'devices') {
      watching = false;
      if (first.ms !== null) {
        report(`Spotify showed up as a device after ${first.ms} ms, before the app's Spotify piece answered`);
        // The piece is still working (its kit waits up to nine seconds), and
        // its answer is the only thing that says whether it let go of
        // Spotify afterwards, so it is written down when it comes (Oct 23 2026).
        void plugin.then((late) => {
          if (late === 'timeout') report(`the app's Spotify piece never answered in ${WAKE_CEILING_MS} ms`);
          else report(`the app's Spotify piece answered late by ${late.road ?? 'none'}: ${(late.steps ?? []).join(' > ') || 'no steps'}`);
        });
        return true;
      }
      report(`no device and no answer in ${WAKE_CEILING_MS} ms`);
      return false;
    }
    const answer = first.answer;
    if (answer === 'timeout') {
      watching = false;
      report(`no answer from the app's Spotify piece in ${WAKE_CEILING_MS} ms`);
      return false;
    }
    const steps = (answer.steps ?? []).join(' > ');
    if (answer.road === 'kit') {
      watching = false;
      report(`woke by the kit: switched ${answer.switched} (${steps})`);
      return true;
    }
    if (answer.road === 'media-key') {
      // Spotify was nudged awake from closed; the device watch already running
      // says when it is ready for the press to go again.
      const ms = await watch;
      watching = false;
      report(`woke by the media key: ${ms === null ? 'no device came up' : `a device showed up after ${ms} ms`} (${steps})`);
      return ms !== null;
    }
    watching = false;
    report(`could not wake: ${steps || 'no steps'}`);
    return false;
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'unknown';
    report(`refused: ${code}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
