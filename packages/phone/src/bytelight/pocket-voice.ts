// Native pocket-call bridge for the Android shell. The web app remains the
// source of truth for the conversation; Android supplies the long-lived
// foreground-session notification and conversation Bubble when the owner carries
// the call outside Bytelight.

import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export type PocketVoicePhase =
  | 'starting'
  | 'ready'
  | 'listening'
  | 'hearing'
  | 'transcribing'
  | 'thinking'
  | 'synthesizing'
  | 'speaking'
  | 'error';

export interface PocketVoiceState {
  active: boolean;
}

/**
 * One face for the floating dock. The bitmap travels as base64 rather than as
 * a URL because the avatar endpoints are session-authenticated: the WebView
 * holds that cookie and a bare HttpURLConnection in the service does not.
 */
export interface PocketVoiceFace {
  png?: string;
  color?: string;
  initial?: string;
}

interface PocketVoicePlugin {
  startSession(options: {
    title: string;
    detail?: string;
    phase?: PocketVoicePhase;
    faces?: PocketVoiceFace[];
  }): Promise<{ started?: boolean }>;
  updateSession(options: { title?: string; detail?: string; phase?: PocketVoicePhase }): Promise<void>;
  endSession(): Promise<void>;
  getState(): Promise<PocketVoiceState & { supported: boolean; overlayGranted?: boolean }>;
  getOverlayState(): Promise<{ supported: boolean; granted: boolean }>;
  requestOverlayPermission(): Promise<{ opened: boolean; granted: boolean }>;
  readLastCrash(): Promise<{ report?: string | null }>;
  clearLastCrash(): Promise<void>;
  addListener(
    eventName: 'stateChange',
    listenerFunc: (state: PocketVoiceState) => void,
  ): Promise<PluginListenerHandle>;
}

const PocketVoice = registerPlugin<PocketVoicePlugin>('PocketVoice');

export function hasNativePocketVoice(): boolean {
  return Capacitor.getPlatform() === 'android';
}

async function quietly<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work();
  } catch {
    // The browser build intentionally has no native implementation. Voice
    // mode stays fully usable there; it simply cannot leave the page.
    return fallback;
  }
}

/**
 * Whether the floating tray may actually be drawn. "Appear on top" is special
 * access: declaring it in the manifest grants nothing, so this is the only
 * honest way to know whether the dock will appear when a call starts.
 */
export async function getPocketVoiceOverlayState(): Promise<{ supported: boolean; granted: boolean }> {
  if (!hasNativePocketVoice()) return { supported: false, granted: false };
  return await quietly(() => PocketVoice.getOverlayState(), { supported: false, granted: false });
}

/**
 * Open the settings page that grants it. There is no runtime dialog for this
 * one — Android only offers the screen, and the answer arrives when she comes
 * back, so re-read the state rather than trusting the return value.
 */
export async function requestPocketVoiceOverlayPermission(): Promise<{ opened: boolean; granted: boolean }> {
  if (!hasNativePocketVoice()) return { opened: false, granted: false };
  return await quietly(() => PocketVoice.requestOverlayPermission(), { opened: false, granted: false });
}

/**
 * Render each avatar to a small square PNG the native dock can decode without
 * a network call of its own. Anything that fails simply drops to its colour
 * and initial — the dock is never worth failing a call over.
 */
export async function encodePocketVoiceFaces(
  people: { avatar?: string | null; color?: string | null; name?: string | null }[],
  size = 84,
): Promise<PocketVoiceFace[]> {
  const encodeOne = async (person: typeof people[number]): Promise<PocketVoiceFace> => {
    const face: PocketVoiceFace = {
      color: person.color || undefined,
      initial: (person.name || '').trim().charAt(0).toUpperCase() || undefined,
    };
    if (!person.avatar) return face;
    try {
      const source = new Image();
      source.crossOrigin = 'anonymous';
      source.src = new URL(person.avatar, window.location.origin).toString();
      await new Promise<void>((resolve, reject) => {
        source.onload = () => resolve();
        source.onerror = () => reject(new Error('avatar did not load'));
      });
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) return face;
      // Cover-fit, matching the object-cover the in-app dock uses.
      const scale = Math.max(size / source.width, size / source.height);
      const width = source.width * scale;
      const height = source.height * scale;
      ctx.drawImage(source, (size - width) / 2, (size - height) / 2, width, height);
      face.png = canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
    } catch {
      // Tainted canvas, missing file, offline — the initial still draws.
    }
    return face;
  };
  return Promise.all(people.slice(0, 4).map(encodeOne));
}

export async function startPocketVoiceSession(options: {
  title: string;
  detail?: string;
  phase?: PocketVoicePhase;
  faces?: PocketVoiceFace[];
}): Promise<boolean> {
  if (!hasNativePocketVoice()) return false;
  const result = await quietly(() => PocketVoice.startSession(options), { started: false });
  return result.started === true;
}

export async function updatePocketVoiceSession(options: {
  title?: string;
  detail?: string;
  phase?: PocketVoicePhase;
}): Promise<void> {
  if (!hasNativePocketVoice()) return;
  await quietly(() => PocketVoice.updateSession(options), undefined);
}

export async function endPocketVoiceSession(): Promise<void> {
  if (!hasNativePocketVoice()) return;
  await quietly(() => PocketVoice.endSession(), undefined);
}

export async function getPocketVoiceState(): Promise<PocketVoiceState> {
  if (!hasNativePocketVoice()) return { active: false };
  const state = await quietly(
    () => PocketVoice.getState(),
    { active: false, supported: false },
  );
  return state;
}

export async function listenForPocketVoiceState(
  listener: (state: PocketVoiceState) => void,
): Promise<PluginListenerHandle | null> {
  if (!hasNativePocketVoice()) return null;
  return quietly(() => PocketVoice.addListener('stateChange', listener), null);
}

/**
 * Deliver the last native crash, if there was one.
 *
 * A crash cannot post its own report: the session cookie is HttpOnly, so the
 * dying process cannot read it and the endpoint refuses an unauthenticated
 * post. The shell therefore writes the report to disk and this hands it over on
 * the next launch, from the one place in the app that is properly logged in.
 * Only cleared once the house has actually acknowledged it — a failed upload
 * keeps the report for the next try rather than losing it.
 */
export async function deliverLastCrashReport(): Promise<boolean> {
  if (!hasNativePocketVoice()) return false;
  const stored = await quietly(() => PocketVoice.readLastCrash(), { report: null });
  const report = stored?.report;
  if (!report) return false;

  try {
    const response = await fetch('/api/app/crash', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ report }),
    });
    // An older backend answers new routes with the SPA shell and a 200, so the
    // status alone is not proof the report was recorded.
    if (!response.ok) return false;
    const body = await response.json().catch(() => null);
    if (!body?.received) return false;
  } catch {
    return false;
  }

  await quietly(() => PocketVoice.clearLastCrash(), undefined);
  return true;
}
