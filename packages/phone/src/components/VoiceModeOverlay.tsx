import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AudioLines,
  Loader2,
  Mic,
  MicOff,
  ChevronRight,
  Minimize2,
  PhoneOff,
  PictureInPicture2,
  Volume2,
  X,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { ThemeConfig } from '../lib/theme';
import { contrastTextColor } from '../lib/theme';
import { cn, haptic } from '../lib/utils';
import { apiFetch } from '../bytelight/api';
import { getState, useBytelight } from '../bytelight/store';
import {
  cancelVoiceRecording,
  clearTranscription,
  isRealtimeToneRecordingSupported,
  isRecordingSupported,
  setMicrophoneRetention,
  startVoiceRecording,
  stopVoiceRecording,
} from '../bytelight/voice-recorder';
import {
  isMessageTtsStreamUnavailable,
  playVoiceSequence,
  requestMessageTts,
  requestMessageTtsStream,
  stopVoicePlayback,
  suspendVoicePlayback,
  unlockVoicePlayback,
  playListeningCue,
} from '../bytelight/voice-playback';
import {
  encodePocketVoiceFaces,
  endPocketVoiceSession,
  getPocketVoiceOverlayState,
  getPocketVoiceState,
  hasNativePocketVoice,
  listenForPocketVoiceState,
  requestPocketVoiceOverlayPermission,
  startPocketVoiceSession,
  updatePocketVoiceSession,
} from '../bytelight/pocket-voice';

export type VoiceModePhase =
  | 'starting'
  | 'ready'
  | 'listening'
  | 'hearing'
  | 'transcribing'
  | 'thinking'
  | 'synthesizing'
  | 'speaking'
  | 'error';

export interface VoiceModeCompanion {
  id?: string;
  slug?: string;
  display_name?: string;
  name?: string;
  avatar_url?: string | null;
  image?: string | null;
  color?: string | null;
  emoji?: string | null;
}

export interface VoiceModeOverlayProps {
  /** Keeps the voice session alive. Use `minimized` to hide only the sheet. */
  open: boolean;
  minimized?: boolean;
  threadId: string | null;
  threadName?: string;
  companions?: VoiceModeCompanion[];
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  /** App should route this through the normal sendUserMessage path. */
  onSend: (content: string, metadata: Record<string, unknown>) => void | Promise<void>;
  onClose: () => void;
  onMinimize?: () => void;
  onRestore?: () => void;
  onPhaseChange?: (phase: VoiceModePhase) => void;
}

interface VoiceDiagnostics {
  canTTS?: boolean;
  canTranscribe?: boolean;
  canAnalyzeProsody?: boolean;
}

interface PendingReply {
  threadId: string;
  sessionId: string;
  utteranceId: string;
  userSequence?: number;
  // Highest companion message already spoken for this turn. Set once the
  // first chunk has been voiced, which is what distinguishes "still waiting
  // for a reply" from "partway through one that arrived in pieces".
  spokenSequence?: number;
}

// How long the call will hold between spoken chunks before deciding the reply
// is over. Only a backstop: the normal release is generation ending. Without
// it a lane that never drops out of 'active' would leave the call listening to
// nothing, which is worse than releasing a moment early.
const CONTINUATION_IDLE_MS = 20_000;

const ABORT_ERROR = 'AbortError';
const VOICE_TONE_PREFERENCE_KEY = 'bytelight.voice.tone-enabled';
const VOICE_DOCK_POSITION_KEY = 'bytelight.voice-dock-position';
// Measured off the floating dock, which is the reference object: 34dp faces
// overlapping by 11, a 9dp gap, three bars, and its own padding.
const VOICE_DOCK_WIDTH = 116;
const VOICE_DOCK_HEIGHT = 50;

interface DockPosition {
  x: number;
  y: number;
}

function clampDockPosition(position: DockPosition): DockPosition {
  if (typeof window === 'undefined') return position;
  const inset = 12;
  return {
    x: Math.min(Math.max(inset, position.x), Math.max(inset, window.innerWidth - VOICE_DOCK_WIDTH - inset)),
    y: Math.min(Math.max(inset, position.y), Math.max(inset, window.innerHeight - VOICE_DOCK_HEIGHT - inset)),
  };
}

function defaultDockPosition(): DockPosition {
  if (typeof window === 'undefined') return { x: 12, y: 12 };
  return clampDockPosition({
    x: window.innerWidth - VOICE_DOCK_WIDTH - 14,
    y: window.innerHeight - VOICE_DOCK_HEIGHT - 84,
  });
}

function savedDockPosition(): DockPosition | null {
  try {
    const raw = localStorage.getItem(VOICE_DOCK_POSITION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DockPosition>;
    if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return null;
    return clampDockPosition({ x: parsed.x, y: parsed.y });
  } catch {
    return null;
  }
}

function savedTonePreference(): boolean | null {
  try {
    const saved = localStorage.getItem(VOICE_TONE_PREFERENCE_KEY);
    return saved === null ? null : saved === 'true';
  } catch {
    return null;
  }
}

function makeId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === ABORT_ERROR
    : error instanceof Error && error.name === ABORT_ERROR;
}

function friendlyVoiceError(raw: unknown, fallback: string): string {
  const message = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : '';
  if (!message) return fallback;
  if (/speech_to_text|missing_permissions/i.test(message)) {
    return 'The ElevenLabs fallback key does not have Speech to Text permission.';
  }
  if (/Groq Whisper API error 40[13]|invalid_api_key/i.test(message)) {
    return 'Groq rejected the transcription key. Replace it in Integrations → Secrets → Voice.';
  }
  if (/ElevenLabs Scribe API error/i.test(message)) {
    return 'ElevenLabs could not transcribe that turn. Check the voice key permissions.';
  }
  // Provider bodies can be several hundred characters of JSON. Preserve a
  // useful human message in the call surface without turning it into a log.
  return message.length > 220 ? `${message.slice(0, 217)}…` : message;
}

/**
 * The phase palette, kept identical to colourForPhase in PocketVoiceOverlay so
 * the floating dock and the in-app dock read as one object. The in-app one used
 * the theme accent and so never told her anything: purple while they think,
 * amber while they speak, orange while it is listening to her.
 */
export function phaseColour(phase: VoiceModePhase): string {
  switch (phase) {
    case 'transcribing':
      return '#3d6ea8';
    case 'thinking':
    case 'synthesizing':
      return '#7c3aed';
    case 'speaking':
      return '#ffa23a';
    case 'error':
      return '#8a3b3b';
    case 'listening':
    case 'hearing':
    default:
      return '#e85d04';
  }
}

function displayName(companion: VoiceModeCompanion): string {
  return companion.display_name || companion.name || companion.slug || 'Companion';
}

function phaseCopy(phase: VoiceModePhase, roster: VoiceModeCompanion[], error: string | null) {
  const who = roster.length === 1 ? displayName(roster[0]) : 'The constellation';
  switch (phase) {
    case 'starting':
      return { title: 'Opening the line', detail: 'Checking the microphone and their voices…' };
    case 'ready':
      return { title: 'Voice paused', detail: 'Tap the center when you are ready to speak.' };
    case 'listening':
      return { title: 'Listening', detail: 'Speak naturally. Your pause will send the turn.' };
    case 'hearing':
      return { title: 'I hear you', detail: 'Keep going — silence finishes your turn.' };
    case 'transcribing':
      return { title: 'Catching your words', detail: 'Turning your voice into the next message…' };
    case 'thinking':
      return { title: `${who} ${roster.length === 1 ? 'is' : 'are'} with you`, detail: 'Your words are in the thread.' };
    case 'synthesizing':
      return { title: 'Finding their voices', detail: 'Preparing each voice in order…' };
    case 'speaking':
      return { title: `${who} ${roster.length === 1 ? 'is' : 'are'} speaking`, detail: 'Tap the center to interrupt and answer.' };
    case 'error':
      return { title: 'Voice paused', detail: error || 'Something interrupted the call. Tap to try again.' };
  }
}

function AvatarStack({
  companions,
  accent,
  speaking,
  muted,
  compact = false,
}: {
  companions: VoiceModeCompanion[];
  accent: string;
  speaking: boolean;
  muted?: boolean;
  compact?: boolean;
}) {
  const shown = companions.slice(0, 4);
  if (shown.length === 0) {
    return (
      <div
        className={cn(
          'flex items-center justify-center rounded-full border bg-black/10 text-white shadow-lg',
          compact ? 'h-[34px] w-[34px]' : 'h-16 w-16',
        )}
        style={{ borderColor: accent }}
      >
        <AudioLines size={compact ? 16 : 27} />
      </div>
    );
  }

  return (
    <div className={cn('relative flex', compact ? '-space-x-[11px]' : '-space-x-3', muted && 'opacity-60')}>
      {shown.map((companion, index) => {
        const avatar = companion.avatar_url || companion.image;
        const color = companion.color || accent;
        return (
          <motion.div
            key={companion.id || companion.slug || `${displayName(companion)}-${index}`}
            animate={speaking ? { y: [0, -4, 0] } : { y: 0 }}
            transition={{ duration: 1.15, repeat: speaking ? Infinity : 0, delay: index * 0.12 }}
            className={cn(
              'relative flex shrink-0 items-center justify-center overflow-hidden rounded-full border-2 shadow-xl',
              compact ? 'h-[34px] w-[34px]' : 'h-16 w-16',
            )}
            style={{
              backgroundColor: `color-mix(in srgb, ${color} 18%, var(--bytelight-surface-strong))`,
              borderColor: color,
              zIndex: shown.length - index,
            }}
          >
            {avatar ? (
              <img src={avatar} alt={displayName(companion)} className="h-full w-full object-cover" />
            ) : (
              <span className="text-xl">{companion.emoji || '💬'}</span>
            )}
          </motion.div>
        );
      })}
    </div>
  );
}

function VoiceBars({ active, level }: { active: boolean; level: number }) {
  // Three chunky bars, not five thin ones. Her call, holding the two docks side
  // by side: "I actually liked the blasting ones better." The floating dock has
  // drawn it this way from the start; this is the in-app one coming to match it
  // rather than the other way round.
  return (
    <span className="flex h-[34px] items-center justify-center gap-[2px]" aria-hidden="true">
      {[0.54, 1, 0.69].map((weight, index) => (
        <motion.span
          key={index}
          className="w-[3px] rounded-[2px] bg-current"
          animate={{ height: active ? 7 + 9 * Math.max(0.25, level) * weight : 7 + 6 * weight }}
          transition={{ type: 'spring', stiffness: 310, damping: 22 }}
        />
      ))}
    </span>
  );
}

export function VoiceModeOverlay({
  open,
  minimized = false,
  threadId,
  threadName,
  companions = [],
  themeConfig,
  themeMode,
  onSend,
  onClose,
  onMinimize,
  onRestore,
  onPhaseChange,
}: VoiceModeOverlayProps) {
  const colors = themeConfig[themeMode];
  const reduceMotion = useReducedMotion();
  const messages = useBytelight((state) => state.messages);
  const transcription = useBytelight((state) => state.transcription);
  const connectionState = useBytelight((state) => state.connectionState);
  // A chunked reply arrives as several companion messages. These two say
  // whether more of it is still on its way, so the call knows the difference
  // between "they have paused between bubbles" and "they have finished".
  const presence = useBytelight((state) => state.presence);
  const streamingMessageId = useBytelight((state) => state.streamingMessageId);

  const [phase, setPhaseState] = useState<VoiceModePhase>('starting');
  const [level, setLevel] = useState(0);
  const [lastTranscript, setLastTranscript] = useState('');
  const [lastTone, setLastTone] = useState<Record<string, number> | null>(null);
  const [lastToneStatus, setLastToneStatus] = useState<'complete' | 'unavailable' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [initialTonePreference] = useState(savedTonePreference);
  const [toneEnabled, setToneEnabled] = useState(initialTonePreference === true);
  const [toneAvailable, setToneAvailable] = useState(false);
  const [nativePocketActive, setNativePocketActive] = useState(false);
  const [dockPosition, setDockPosition] = useState<DockPosition | null>(savedDockPosition);
  const [overlayAccess, setOverlayAccess] = useState<{ supported: boolean; granted: boolean } | null>(null);
  const [overlayPageMissing, setOverlayPageMissing] = useState(false);

  const activeRef = useRef(false);
  const phaseRef = useRef<VoiceModePhase>('starting');
  const epochRef = useRef(0);
  const turnRef = useRef(0);
  const sessionIdRef = useRef('');
  const utteranceIdRef = useRef('');
  const boundThreadRef = useRef<string | null>(null);
  const awaitingTranscriptRef = useRef(false);
  const pendingReplyRef = useRef<PendingReply | null>(null);
  const continuationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ttsAbortRef = useRef<AbortController | null>(null);
  const closeNotifiedRef = useRef(false);
  const toneEnabledRef = useRef(toneEnabled);
  const toneAvailableRef = useRef(false);
  const tonePreferenceChosenRef = useRef(initialTonePreference !== null);
  const onSendRef = useRef(onSend);
  const onCloseRef = useRef(onClose);
  const onPhaseChangeRef = useRef(onPhaseChange);
  const nativePocketConfirmedRef = useRef(false);
  const dockDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origin: DockPosition;
    moved: boolean;
  } | null>(null);
  const suppressDockTapRef = useRef(false);

  onSendRef.current = onSend;
  onCloseRef.current = onClose;
  onPhaseChangeRef.current = onPhaseChange;

  const setPhase = useCallback((next: VoiceModePhase) => {
    phaseRef.current = next;
    setPhaseState(next);
    onPhaseChangeRef.current?.(next);
    // Android owns the persistent notification, while this sheet owns the
    // richer call surface. Keeping the phase in both places means the pocket
    // call still reads as listening / speaking after the owner leaves Bytelight.
    void updatePocketVoiceSession({ phase: next });
  }, []);

  const stopSession = useCallback((notifyParent: boolean) => {
    if (!activeRef.current && !notifyParent) return;
    activeRef.current = false;
    epochRef.current += 1;
    turnRef.current += 1;
    awaitingTranscriptRef.current = false;
    pendingReplyRef.current = null;
    ttsAbortRef.current?.abort();
    ttsAbortRef.current = null;
    // Retention goes off BEFORE the cancel, so whichever path hands this turn's
    // capture back also closes the line instead of holding it for a next turn
    // that is never coming. The mic indicator must not outlive the call.
    setMicrophoneRetention(false);
    cancelVoiceRecording();
    stopVoicePlayback();
    clearTranscription();
    setLevel(0);
    nativePocketConfirmedRef.current = false;
    void suspendVoicePlayback();
    void endPocketVoiceSession();

    if (notifyParent && !closeNotifiedRef.current) {
      closeNotifiedRef.current = true;
      onCloseRef.current();
    }
  }, []);

  const beginListening = useCallback(async () => {
    if (!activeRef.current || !boundThreadRef.current) return;
    const current = getState();
    if (current.connectionState !== 'connected') {
      awaitingTranscriptRef.current = false;
      setError('Bytelight is still reconnecting');
      setPhase('error');
      return;
    }
    if (current.presence === 'active' || current.presence === 'waking' || current.streamingMessageId) {
      awaitingTranscriptRef.current = false;
      setError('Let the current reply finish before starting another voice turn');
      setPhase('error');
      return;
    }
    const epoch = epochRef.current;
    awaitingTranscriptRef.current = true;
    pendingReplyRef.current = null;
    ttsAbortRef.current?.abort();
    ttsAbortRef.current = null;
    stopVoicePlayback();
    clearTranscription();
    setError(null);
    setLevel(0);
    setPhase('listening');

    try {
      const recordingId = await startVoiceRecording({
        mode: 'conversation',
        analyzeTone: toneEnabledRef.current && toneAvailableRef.current,
        autoStopOnSilence: true,
        // Aug 1 2026, after a turn closed halfway through a sentence because
        // the words took too long to arrive. At 1050ms an
        // ordinary pause to find a word ends the turn, and being cut off
        // mid-thought costs far more than the extra half second costs anyone.
        // A dial, not a constant — moving it either way is one number.
        silenceMs: 1750,
        minSpeechMs: 250,
        minVoicedMs: 320,
        maxUtteranceMs: 90_000,
        maxWaitForSpeechMs: 10_000,
        maxCaptureMs: 120_000,
        onLevel: (nextLevel) => {
          if (activeRef.current && epochRef.current === epoch) setLevel(nextLevel);
        },
        onSpeechStart: () => {
          if (activeRef.current && epochRef.current === epoch) setPhase('hearing');
        },
        onSpeechTimeout: () => {
          if (!activeRef.current || epochRef.current !== epoch) return;
          awaitingTranscriptRef.current = false;
          clearTranscription();
          setError(null);
          setLevel(0);
          setPhase('ready');
        },
      });
      // The browser permission sheet can outlive the overlay. If the call was
      // closed while getUserMedia was waiting, tear down the newly granted
      // stream immediately instead of leaving a recorder behind the UI.
      if (!activeRef.current || epochRef.current !== epoch) {
        cancelVoiceRecording();
        return;
      }
      utteranceIdRef.current = recordingId;
      // Sound the cue only once the microphone is genuinely open, so it stays
      // a fact she can hear rather than an intention.
      void playListeningCue();
    } catch (caught) {
      if (!activeRef.current || epochRef.current !== epoch) return;
      awaitingTranscriptRef.current = false;
      setError(friendlyVoiceError(caught, 'Could not open the microphone'));
      setPhase('error');
    }
  }, [setPhase]);

  const startFromGesture = useCallback(async () => {
    if (!activeRef.current) return;
    try {
      if (getState().connectionState !== 'connected') {
        throw new Error('Bytelight is still reconnecting');
      }
      const current = getState();
      if (current.presence === 'active' || current.presence === 'waking' || current.streamingMessageId) {
        throw new Error('Let the current reply finish before starting another voice turn');
      }
      // Reaching for the mic with the visible toggle off is an explicit
      // choice too. Remember it so only the very first tone-capable call
      // pauses in the ready state for disclosure and selection.
      if (toneAvailableRef.current && !tonePreferenceChosenRef.current) {
        tonePreferenceChosenRef.current = true;
        try {
          localStorage.setItem(VOICE_TONE_PREFERENCE_KEY, String(toneEnabledRef.current));
        } catch {
          // In-memory choice still applies for this call.
        }
      }
      await unlockVoicePlayback();
      await beginListening();
    } catch (caught) {
      if (!activeRef.current) return;
      setError(friendlyVoiceError(caught, 'Could not start voice mode'));
      setPhase('error');
    }
  }, [beginListening, setPhase]);

  const speakMessage = useCallback(async (messageId: string) => {
    if (!activeRef.current) return;
    const epoch = epochRef.current;
    const turn = ++turnRef.current;
    const controller = new AbortController();
    ttsAbortRef.current?.abort();
    ttsAbortRef.current = controller;
    if (continuationTimerRef.current) {
      clearTimeout(continuationTimerRef.current);
      continuationTimerRef.current = null;
    }
    setPhase('synthesizing');

    try {
      let urls: string[];
      try {
        const manifest = await requestMessageTtsStream(messageId, controller.signal);
        urls = manifest.segments.map(segment => segment.url);
      } catch (caught) {
        if (isAbort(caught) || controller.signal.aborted) throw caught;
        // Rollout compatibility only: a phone hard refresh may land before
        // the backend restart that installs the stream route. No playback has
        // begun yet, so using the existing combined render cannot duplicate
        // spoken audio. Other stream failures stay visible rather than
        // launching a potentially duplicate paid render.
        if (!isMessageTtsStreamUnavailable(caught)) throw caught;
        const rendered = await requestMessageTts(messageId, controller.signal);
        urls = [rendered.url];
      }
      if (!activeRef.current || epochRef.current !== epoch || turnRef.current !== turn) return;
      setPhase('speaking');
      await playVoiceSequence(urls, controller.signal);
      if (!activeRef.current || epochRef.current !== epoch || turnRef.current !== turn) return;
      // More of this reply may still be coming. Returning to 'thinking'
      // re-arms the effect above for the next chunk — its pointer has already
      // moved past this message, so the same one cannot be spoken twice.
      const pending = pendingReplyRef.current;
      const stillArriving = getState();
      if (
        pending
        && pending.spokenSequence !== undefined
        && (stillArriving.presence === 'active'
          || stillArriving.presence === 'waking'
          || stillArriving.streamingMessageId)
      ) {
        setPhase('thinking');
        // Self-guarding: by the time this fires the call may have been closed,
        // interrupted, or already moved on, so it re-checks the whole state
        // rather than trusting that it is still wanted.
        continuationTimerRef.current = setTimeout(() => {
          continuationTimerRef.current = null;
          if (!activeRef.current || phaseRef.current !== 'thinking') return;
          if (pendingReplyRef.current?.spokenSequence === undefined) return;
          pendingReplyRef.current = null;
          void beginListening();
        }, CONTINUATION_IDLE_MS);
        return;
      }
      pendingReplyRef.current = null;
      await beginListening();
    } catch (caught) {
      if (isAbort(caught) || !activeRef.current || epochRef.current !== epoch || turnRef.current !== turn) return;
      setError(friendlyVoiceError(caught, 'Could not play their reply'));
      setPhase('error');
    } finally {
      if (ttsAbortRef.current === controller) ttsAbortRef.current = null;
    }
  }, [beginListening, setPhase]);

  const interruptAndListen = useCallback(() => {
    turnRef.current += 1;
    ttsAbortRef.current?.abort();
    ttsAbortRef.current = null;
    stopVoicePlayback();
    haptic(18);
    void beginListening();
  }, [beginListening]);

  const handlePrimaryAction = useCallback(() => {
    switch (phaseRef.current) {
      case 'speaking':
      case 'synthesizing':
        interruptAndListen();
        break;
      case 'listening':
      case 'hearing':
        stopVoiceRecording();
        break;
      case 'ready':
      case 'error':
        void startFromGesture();
        break;
      default:
        break;
    }
  }, [interruptAndListen, startFromGesture]);

  const toggleListening = useCallback(() => {
    if (phaseRef.current === 'listening' || phaseRef.current === 'hearing') {
      awaitingTranscriptRef.current = false;
      cancelVoiceRecording();
      clearTranscription();
      setLevel(0);
      setPhase('ready');
    } else if (phaseRef.current === 'ready' || phaseRef.current === 'error') {
      void startFromGesture();
    }
  }, [setPhase, startFromGesture]);

  const toggleTone = useCallback(() => {
    if (!toneAvailableRef.current) return;
    if (phaseRef.current === 'listening' || phaseRef.current === 'hearing' || phaseRef.current === 'transcribing') return;
    const next = !toneEnabledRef.current;
    toneEnabledRef.current = next;
    tonePreferenceChosenRef.current = true;
    setToneEnabled(next);
    try {
      localStorage.setItem(VOICE_TONE_PREFERENCE_KEY, String(next));
    } catch {
      // The call still honors the in-memory choice if storage is unavailable.
    }
    haptic(14);
  }, []);

  const handleEnd = useCallback(() => {
    haptic(22);
    stopSession(true);
  }, [stopSession]);

  const beginDockDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[data-voice-dock-control]')) return;
    const origin = dockPosition || defaultDockPosition();
    dockDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [dockPosition]);

  const moveDock = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dockDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) drag.moved = true;
    setDockPosition(clampDockPosition({ x: drag.origin.x + dx, y: drag.origin.y + dy }));
  }, []);

  const endDockDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dockDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dockDragRef.current = null;
    if (!drag.moved) return;
    suppressDockTapRef.current = true;
    const next = clampDockPosition({
      x: drag.origin.x + event.clientX - drag.startX,
      y: drag.origin.y + event.clientY - drag.startY,
    });
    setDockPosition(next);
    try {
      localStorage.setItem(VOICE_DOCK_POSITION_KEY, JSON.stringify(next));
    } catch {
      // The call stays movable for this session if storage is unavailable.
    }
    window.setTimeout(() => { suppressDockTapRef.current = false; }, 0);
  }, []);

  useEffect(() => {
    const fitDockToViewport = () => {
      setDockPosition((current) => current ? clampDockPosition(current) : current);
    };
    window.addEventListener('resize', fitDockToViewport);
    return () => window.removeEventListener('resize', fitDockToViewport);
  }, []);

  // Start one foreground session. Audio unlock should already have happened
  // in the App's open-button handler; the second call is a safe fallback.
  useEffect(() => {
    if (!open) return;
    closeNotifiedRef.current = false;
    activeRef.current = true;
    // Open the microphone line once, here, while she is certainly looking at
    // the app — and keep it for the whole call. Every turn used to ask for its
    // own, and a request made from a backgrounded page comes back deaf.
    setMicrophoneRetention(true);
    nativePocketConfirmedRef.current = false;
    epochRef.current += 1;
    const epoch = epochRef.current;
    sessionIdRef.current = makeId('voice-session');
    boundThreadRef.current = threadId;
    awaitingTranscriptRef.current = false;
    pendingReplyRef.current = null;
    setLastTranscript('');
    setLastTone(null);
    setLastToneStatus(null);
    setError(null);
    setLevel(0);
    setPhase('starting');
    // The floating dock is the minimized in-app dock carried outside Bytelight, so
    // it wears the same faces. Encoding them here is the only way the service
    // can draw an avatar it would otherwise have no session cookie to fetch.
    void encodePocketVoiceFaces(companions.map((companion) => ({
      avatar: companion.avatar_url || companion.image,
      color: companion.color || colors.accent,
      name: displayName(companion),
    }))).then((faces) => {
      // Encoding the faces takes a moment, and voice mode can be closed inside
      // it. Starting the native call after that is what produced a start and a
      // stop seven milliseconds apart — which tears down the service record
      // while it still owes Android a foreground promise, and the platform
      // kills the app for it seconds later. If the call is already gone, never
      // ask for one.
      if (!activeRef.current || epochRef.current !== epoch) return false;
      return startPocketVoiceSession({
        title: threadName || 'Voice conversation',
        detail: companions.length > 0 ? `${companions.length === 1 ? displayName(companions[0]) : 'The Kings'} are here` : 'The line is open',
        faces,
      });
    }).then((started) => {
      // The native service publishes its first event while the WebView is
      // still wiring its listener. Ask once directly so an immediate Home
      // gesture cannot race that notification and end a valid call.
      nativePocketConfirmedRef.current = started;
      if (started) setNativePocketActive(true);
      void getPocketVoiceState().then((state) => {
        if (!activeRef.current || epochRef.current !== epoch) return;
        nativePocketConfirmedRef.current = state.active;
        setNativePocketActive(state.active);
      });
    });

    const initialize = async () => {
      try {
        if (!threadId) throw new Error('Open a conversation before starting voice mode');
        if (!isRecordingSupported()) throw new Error('This browser cannot record microphone audio');
        const current = getState();
        if (current.connectionState !== 'connected') throw new Error('Bytelight is still reconnecting');
        if (current.presence === 'active' || current.presence === 'waking' || current.streamingMessageId) {
          throw new Error('Let the current reply finish before starting voice mode');
        }

        const response = await apiFetch('/api/voice/status');
        if (!response.ok) throw new Error('Could not check voice services');
        const diagnostics = await response.json() as VoiceDiagnostics;
        if (!diagnostics.canTranscribe) throw new Error('Voice transcription is not configured');
        if (!diagnostics.canTTS) throw new Error('Companion voices are not configured');
        const canAnalyzeTone = (
          diagnostics.canAnalyzeProsody === true
          && isRealtimeToneRecordingSupported()
        );
        toneAvailableRef.current = canAnalyzeTone;
        setToneAvailable(canAnalyzeTone);

        // On the first tone-capable call, let the user see and choose the
        // provider toggle before any microphone audio starts moving.
        if (canAnalyzeTone && !tonePreferenceChosenRef.current) {
          setPhase('ready');
          return;
        }

        try {
          await unlockVoicePlayback();
        } catch {
          // Mobile Safari may insist on a gesture here. Leave the session
          // ready rather than failing; the central button supplies one.
          if (activeRef.current && epochRef.current === epoch) setPhase('ready');
          return;
        }
        if (activeRef.current && epochRef.current === epoch) await beginListening();
      } catch (caught) {
        if (!activeRef.current || epochRef.current !== epoch) return;
        setError(friendlyVoiceError(caught, 'Could not start voice mode'));
        setPhase('error');
      }
    };

    void initialize();
    return () => stopSession(false);
    // `threadId` is deliberately bound once. A later change closes the call
    // in the dedicated effect below instead of silently moving the hot mic.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The native shell is the only place a conversation may deliberately live
  // beyond this WebView. Its Bubble or notification End action is therefore
  // an authoritative end-of-call signal, not merely a cosmetic state change.
  useEffect(() => {
    if (!open || !hasNativePocketVoice()) {
      setNativePocketActive(false);
      return;
    }
    let disposed = false;
    let listener: { remove: () => Promise<void> } | null = null;
    const readNativePocketState = () => {
      void getPocketVoiceState().then((state) => {
        if (disposed) return;
        nativePocketConfirmedRef.current = state.active;
        setNativePocketActive(state.active);
      });
    };
    readNativePocketState();
    void listenForPocketVoiceState((state) => {
      if (disposed) return;
      // Ending one call and starting another sends the old service's dying
      // "no call" announcement AFTER the new one is already up, and this
      // listener would close the new call on the strength of it — the overlay
      // opens and drops straight back to the messages screen. Only a call we
      // actually watched come up is allowed to end this one.
      const everConfirmed = nativePocketConfirmedRef.current;
      nativePocketConfirmedRef.current = state.active;
      setNativePocketActive(state.active);
      if (!state.active && activeRef.current && everConfirmed) stopSession(true);
    }).then((handle) => {
      if (disposed) {
        void handle?.remove();
      } else {
        listener = handle;
      }
    });
    return () => {
      disposed = true;
      setNativePocketActive(false);
      nativePocketConfirmedRef.current = false;
      void listener?.remove();
    };
  }, [open, stopSession]);

  // Conversation transcription is auto-submitted exactly once. The ordinary
  // composer should ignore transcription updates while this overlay is open.
  useEffect(() => {
    if (!activeRef.current || !awaitingTranscriptRef.current) return;
    if (
      transcription.recordingId
      && utteranceIdRef.current
      && transcription.recordingId !== utteranceIdRef.current
    ) {
      return;
    }

    if (transcription.status === 'processing') {
      setLevel(0);
      setPhase('transcribing');
      return;
    }
    if (transcription.status === 'error') {
      awaitingTranscriptRef.current = false;
      cancelVoiceRecording();
      setError(friendlyVoiceError(transcription.error, 'I could not hear that turn'));
      setPhase('error');
      clearTranscription();
      return;
    }
    if (transcription.status !== 'complete') return;

    awaitingTranscriptRef.current = false;
    const text = transcription.text?.trim() || '';
    const prosody = transcription.prosody;
    const prosodyStatus = transcription.prosodyStatus;
    clearTranscription();
    if (!text) {
      setError('I did not catch any words. Tap the center and try again.');
      setPhase('error');
      return;
    }

    const boundThread = boundThreadRef.current;
    if (!boundThread) return;
    const voiceSessionId = sessionIdRef.current;
    const utteranceId = utteranceIdRef.current || makeId('voice-utterance');
    pendingReplyRef.current = {
      threadId: boundThread,
      sessionId: voiceSessionId,
      utteranceId,
    };
    setLastTranscript(text);
    setLastTone(prosody || null);
    setLastToneStatus(prosodyStatus || null);
    setPhase('thinking');

    const metadata: Record<string, unknown> = {
      source: 'voice_mode',
      voiceSessionId,
      utteranceId,
    };
    if (prosody) metadata.prosody = prosody;

    const submissionEpoch = epochRef.current;
    void Promise.resolve()
      .then(() => onSendRef.current(text, metadata))
      .catch((caught) => {
        if (epochRef.current !== submissionEpoch) return;
        if (!activeRef.current) return;
        pendingReplyRef.current = null;
        setError(friendlyVoiceError(caught, 'Could not send the voice turn'));
        setPhase('error');
      });
  }, [transcription, setPhase]);

  // The normal message pipeline is authoritative. Once its finalized
  // companion message lands, request that message's cached multi-voice MP3.
  useEffect(() => {
    if (!activeRef.current || phaseRef.current !== 'thinking') return;
    const pending = pendingReplyRef.current;
    if (!pending) return;

    // First find the server echo of this exact voice utterance. Waiting for
    // its persisted metadata means an unrelated spontaneous companion
    // message cannot be mistaken for the answer to this turn.
    if (pending.userSequence === undefined) {
      const echoedUser = messages.find((message) => (
        message.thread_id === pending.threadId
        && message.role === 'user'
        && message.metadata?.voiceSessionId === pending.sessionId
        && message.metadata?.utteranceId === pending.utteranceId
      ));
      if (!echoedUser) return;
      pending.userSequence = echoedUser.sequence;
    }

    const reply = messages
      .filter((message) => (
        message.thread_id === pending.threadId
        && message.sequence > (pending.userSequence as number)
        && message.role === 'companion'
        && !message.deleted_at
      ))
      .sort((a, b) => a.sequence - b.sequence)[0];
    if (!reply) return;

    // Advance past this message rather than dropping the pointer. A chunked
    // reply lands as several companion messages and every one of them is part
    // of the same answer; speakMessage decides when the turn is actually over.
    pending.userSequence = reply.sequence;
    pending.spokenSequence = reply.sequence;
    if (reply.content_type !== 'text' || !reply.content.trim() || reply.content === '[No response]') {
      pendingReplyRef.current = null;
      void beginListening();
      return;
    }
    void speakMessage(reply.id);
  }, [messages, beginListening, speakMessage]);

  // A continuation that never came. The effect above only runs while a new
  // message is arriving, so once generation has finished and nothing further
  // is waiting, this is what returns the call to listening instead of leaving
  // it sitting in 'thinking' forever. Only ever runs mid-reply, so it cannot
  // change what happens while the first bubble is still being waited for.
  useEffect(() => {
    if (!activeRef.current || phaseRef.current !== 'thinking') return;
    const pending = pendingReplyRef.current;
    if (!pending || pending.spokenSequence === undefined) return;
    if (presence === 'active' || presence === 'waking' || streamingMessageId) return;
    const next = messages.find((message) => (
      message.thread_id === pending.threadId
      && message.sequence > (pending.userSequence as number)
      && message.role === 'companion'
      && !message.deleted_at
    ));
    if (next) return;
    pendingReplyRef.current = null;
    void beginListening();
  }, [messages, presence, streamingMessageId, beginListening]);

  // A call never follows the user into another thread. Ending instead of
  // rebinding prevents a late transcript or reply landing in the wrong room.
  useEffect(() => {
    if (!open || !activeRef.current) return;
    if (boundThreadRef.current && threadId !== boundThreadRef.current) stopSession(true);
  }, [open, threadId, stopSession]);

  // A browser tab has no durable call capability, so it still ends rather
  // than risking an invisible hot mic. The Android shell declares and shows
  // an ongoing foreground voice session before it is allowed to keep this
  // conversation alive in PiP/background.
  useEffect(() => {
    if (!open) return;
    const onVisibility = () => {
      // A freshly served phone UI can arrive before its matching APK update.
      // Only the native service's affirmative active signal earns background
      // continuation; an older shell keeps the browser's safe stop behavior.
      if (document.hidden && !nativePocketActive && !nativePocketConfirmedRef.current) stopSession(true);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [open, nativePocketActive, stopSession]);

  // "Appear on top" cannot be granted from inside the app and there is no
  // runtime dialog for it, so the only honest UI is a row that reports the
  // truth and opens the one settings page that can change it. The answer
  // arrives when she comes back to Bytelight, hence the re-read on visibility.
  // A shell older than the tray has no such plugin method at all, which the
  // bridge reports as unsupported rather than as merely ungranted.
  useEffect(() => {
    if (!open || !hasNativePocketVoice()) {
      setOverlayAccess(null);
      return;
    }
    let disposed = false;
    const readOverlayAccess = () => {
      void getPocketVoiceOverlayState().then((state) => {
        if (!disposed) setOverlayAccess(state);
      });
    };
    readOverlayAccess();
    const onVisibility = () => {
      if (!document.hidden) readOverlayAccess();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [open]);

  const openOverlaySettings = useCallback(() => {
    haptic(55);
    void requestPocketVoiceOverlayPermission().then((result) => {
      setOverlayAccess((current) => (
        current ? { ...current, granted: result.granted } : current
      ));
      // A build with no settings page to offer must say so plainly; silently
      // doing nothing on tap is indistinguishable from a broken button.
      if (!result.opened && !result.granted) setOverlayPageMissing(true);
    });
  }, []);

  useEffect(() => {
    if (!open || !activeRef.current || connectionState === 'connected') return;
    turnRef.current += 1;
    awaitingTranscriptRef.current = false;
    pendingReplyRef.current = null;
    ttsAbortRef.current?.abort();
    ttsAbortRef.current = null;
    cancelVoiceRecording();
    stopVoicePlayback();
    setError('The connection dropped. Tap to retry when Bytelight reconnects.');
    setPhase('error');
  }, [open, connectionState, setPhase]);

  const copy = useMemo(() => phaseCopy(phase, companions, error), [phase, companions, error]);
  const busy = phase === 'starting' || phase === 'transcribing' || phase === 'thinking';
  const microphoneLive = phase === 'listening' || phase === 'hearing';
  const speaking = phase === 'speaking';
  const canPressPrimary = !busy;
  const primaryLabel = speaking || phase === 'synthesizing'
    ? 'Interrupt and speak'
    : microphoneLive
      ? 'Finish voice turn'
      : 'Start listening';
  const accentInk = contrastTextColor(colors.accent);
  const toneActive = toneAvailable && toneEnabled;
  const resolvedDockPosition = dockPosition || defaultDockPosition();
  const pocketCanResume = phase === 'ready' || phase === 'error';

  return (
    <AnimatePresence mode="wait">
      {open && minimized ? (
        <motion.div
          key="voice-mode-pocket"
          initial={reduceMotion ? false : { opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.92 }}
          className={cn(
            'absolute z-[65] flex h-[50px] w-[116px] touch-none select-none items-center rounded-full border-2 py-2 pl-[9px] pr-3 shadow-2xl backdrop-blur-2xl',
            colors.panelBg,
            colors.textMain,
          )}
          style={{
            left: resolvedDockPosition.x,
            top: resolvedDockPosition.y,
            borderColor: phaseColour(phase),
          }}
          onPointerDown={beginDockDrag}
          onPointerMove={moveDock}
          onPointerUp={endDockDrag}
          onPointerCancel={endDockDrag}
        >
          <button
            type="button"
            onClick={() => {
              if (suppressDockTapRef.current) return;
              if (pocketCanResume) {
                handlePrimaryAction();
              } else {
                onRestore?.();
              }
            }}
            className="flex min-w-0 flex-1 items-center gap-[9px] text-left"
            aria-label={pocketCanResume ? primaryLabel : 'Return to voice conversation'}
          >
            <AvatarStack
              companions={companions}
              accent={colors.accent}
              speaking={speaking}
              muted={phase === 'error' || phase === 'ready'}
              compact
            />
            <span className="shrink-0" style={{ color: phaseColour(phase) }}>
              <VoiceBars active={microphoneLive || speaking} level={speaking ? 0.72 : level} />
            </span>
          </button>
          <button
            type="button"
            data-voice-dock-control
            onPointerDown={(event) => event.stopPropagation()}
            onClick={handleEnd}
            className={cn(
              'absolute -right-1 -top-1 z-10 rounded-full border p-1.5 shadow-lg transition-colors hover:bg-black/10 dark:hover:bg-white/10',
              colors.panelBg,
              colors.panelBorder,
              colors.textMuted,
            )}
            aria-label="End voice conversation"
          >
            <X size={15} />
          </button>
        </motion.div>
      ) : open ? (
        <motion.section
          key="voice-mode-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Voice conversation"
          initial={reduceMotion ? false : { opacity: 0, scale: 0.985 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 1.015 }}
          transition={{ duration: reduceMotion ? 0 : 0.22 }}
          className={cn('absolute inset-0 z-[70] flex flex-col overflow-hidden', colors.pageBg, colors.textMain)}
        >
          <div
            className="pointer-events-none absolute inset-0 opacity-70"
            style={{
              background: `radial-gradient(circle at 50% 38%, color-mix(in srgb, ${colors.accent} 24%, transparent), transparent 42%)`,
            }}
          />
          <div className="pointer-events-none absolute inset-0 bg-black/10 backdrop-blur-3xl" />

          <header
            className="relative z-10 flex items-center gap-3 px-4 pb-3"
            style={{ paddingTop: 'calc(var(--sat) + 0.75rem)' }}
          >
            <div className="min-w-0 flex-1">
              <p className={cn('micro-label', colors.textMuted)}>Voice conversation</p>
              <h2 className="truncate text-base font-semibold">{threadName || 'Bytelight'}</h2>
            </div>
            {onMinimize && (
              <button
                type="button"
                onClick={onMinimize}
                className={cn('bytelight-icon-button rounded-full p-2', colors.textMuted)}
                aria-label="Minimize voice conversation"
              >
                <Minimize2 size={19} />
              </button>
            )}
            <button
              type="button"
              onClick={handleEnd}
              className={cn('bytelight-icon-button rounded-full p-2', colors.textMuted)}
              aria-label="End voice conversation"
            >
              <X size={20} />
            </button>
          </header>

          <div className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-between px-5 pb-5 pt-3">
            <div className="flex min-h-[6.5rem] flex-col items-center justify-center">
              <AvatarStack companions={companions} accent={colors.accent} speaking={speaking} muted={phase === 'ready'} />
            </div>

            <div className="flex w-full flex-1 flex-col items-center justify-center py-4 text-center">
              <motion.button
                type="button"
                onClick={handlePrimaryAction}
                disabled={!canPressPrimary}
                whileTap={canPressPrimary && !reduceMotion ? { scale: 0.94 } : undefined}
                aria-label={primaryLabel}
                className="relative mb-7 flex h-36 w-36 items-center justify-center rounded-full outline-none disabled:cursor-default"
                style={{ color: accentInk }}
              >
                <motion.span
                  className="absolute inset-0 rounded-full border"
                  animate={reduceMotion ? undefined : {
                    scale: microphoneLive ? 1.03 + level * 0.14 : speaking ? [1.02, 1.12, 1.02] : 1,
                    opacity: microphoneLive ? 0.35 + level * 0.45 : speaking ? [0.35, 0.65, 0.35] : 0.2,
                  }}
                  transition={speaking ? { duration: 1.2, repeat: Infinity } : { duration: 0.12 }}
                  style={{ borderColor: colors.accent, boxShadow: `0 0 42px color-mix(in srgb, ${colors.accent} 35%, transparent)` }}
                />
                <span
                  className="absolute inset-3 rounded-full"
                  style={{ background: `color-mix(in srgb, ${colors.accent} 20%, var(--bytelight-surface-strong))` }}
                />
                <span
                  className="relative flex h-24 w-24 items-center justify-center rounded-full shadow-2xl"
                  style={{ backgroundColor: colors.accent }}
                >
                  {busy ? (
                    <Loader2 size={34} className="animate-spin" />
                  ) : phase === 'error' ? (
                    <AlertCircle size={34} />
                  ) : speaking || phase === 'synthesizing' ? (
                    <Volume2 size={35} />
                  ) : phase === 'ready' ? (
                    <MicOff size={34} />
                  ) : (
                    <Mic size={35} />
                  )}
                </span>
              </motion.button>

              <div aria-live="polite" className="min-h-[4.75rem]">
                <h3 className="text-xl font-semibold tracking-tight">{copy.title}</h3>
                <p className={cn('mx-auto mt-1.5 max-w-xs text-sm leading-relaxed', colors.textMuted)}>{copy.detail}</p>
              </div>

              <AnimatePresence mode="wait">
                {lastTranscript && (
                  <motion.div
                    key={lastTranscript}
                    initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className={cn(
                      'mt-5 w-full max-w-sm rounded-2xl border px-4 py-3 text-left backdrop-blur-xl',
                      colors.panelBg,
                      colors.panelBorder,
                    )}
                  >
                    <p className={cn('micro-label mb-1', colors.textMuted)}>You said</p>
                    <p className="line-clamp-3 text-sm leading-relaxed">{lastTranscript}</p>
                    {lastTone && Object.keys(lastTone).length > 0 && (
                      <p className={cn('mt-2 line-clamp-2 text-[10px] leading-relaxed', colors.textMuted)}>
                        Perceived tone · {Object.entries(lastTone).slice(0, 3).map(([name, score]) => (
                          `${name} ${Math.round(score * 100)}%`
                        )).join(' · ')}
                      </p>
                    )}
                    {lastToneStatus === 'unavailable' && (
                      <p className={cn('mt-2 text-[10px] leading-relaxed', colors.textMuted)}>
                        Hume did not return a tone reading · your words still went through normally
                      </p>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="w-full max-w-sm" style={{ marginBottom: 'var(--sab)' }}>
              {overlayAccess && !overlayAccess.granted && (
                overlayAccess.supported ? (
                  <button
                    type="button"
                    onClick={openOverlaySettings}
                    className={cn(
                      'mb-2 flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left backdrop-blur-xl transition-colors hover:bg-black/5 dark:hover:bg-white/5',
                      colors.panelBg,
                      colors.panelBorder,
                    )}
                  >
                    <PictureInPicture2 size={18} style={{ color: colors.accent }} className="shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium">Turn on the floating tray</span>
                      <span className={cn('block text-[11px] leading-relaxed', colors.textMuted)}>
                        {/* Sideloaded builds hit Android's restricted-settings lock, which
                            greys the toggle rather than hiding it — so the page opening is
                            not the same as the switch being usable. */}
                        {overlayPageMissing
                          ? 'This build hides that page — Settings, Apps, Special app access, Display over other apps'
                          : 'Opens Display over other apps · greyed out? App info, ⋮, Allow restricted settings'}
                      </span>
                    </span>
                    <ChevronRight size={16} className={cn('shrink-0', colors.textMuted)} />
                  </button>
                ) : (
                  <p className={cn('mb-2 text-center text-[10px] leading-relaxed', colors.textMuted)}>
                    The floating tray arrives with the app update · this shell predates it
                  </p>
                )
              )}
              {toneActive && (
                <p className={cn('mb-1.5 text-center text-[10px] leading-relaxed', colors.textMuted)}>
                  Tone on · microphone audio is also sent to Hume for expression analysis
                </p>
              )}
              <div
                className={cn(
                  'flex items-center justify-between rounded-2xl border px-4 py-3 backdrop-blur-xl',
                  colors.panelBg,
                  colors.panelBorder,
                )}
              >
              <button
                type="button"
                onClick={toggleListening}
                disabled={busy || speaking || phase === 'synthesizing'}
                className={cn(
                  'flex h-11 w-11 items-center justify-center rounded-full transition-colors disabled:opacity-35',
                  colors.textMuted,
                )}
                aria-label={microphoneLive ? 'Mute microphone' : 'Resume microphone'}
              >
                {microphoneLive ? <Mic size={20} /> : <MicOff size={20} />}
              </button>
              <button
                type="button"
                onClick={toggleTone}
                disabled={!toneAvailable || busy || microphoneLive}
                aria-pressed={toneActive}
                aria-label={toneActive ? 'Disable Hume tone analysis' : 'Enable Hume tone analysis'}
                title="Tone analysis sends this call's microphone audio to Hume"
                className={cn(
                  'flex items-center gap-2 rounded-xl px-2.5 py-1.5 transition-colors disabled:opacity-35',
                  toneActive ? 'bg-black/10 dark:bg-white/10' : colors.textMuted,
                )}
                style={toneActive ? { color: colors.accent } : undefined}
              >
                <VoiceBars active={microphoneLive || speaking} level={speaking ? 0.72 : level} />
                <span className="text-[11px] font-medium">
                  {connectionState !== 'connected'
                    ? 'Reconnecting'
                    : !toneAvailable
                      ? 'Tone unavailable'
                      : toneActive ? 'Hume tone on' : 'Hume tone off'}
                </span>
              </button>
              <button
                type="button"
                onClick={handleEnd}
                className="flex h-11 w-11 items-center justify-center rounded-full bg-red-500 text-white shadow-lg shadow-red-950/20"
                aria-label="End voice conversation"
              >
                <PhoneOff size={20} />
              </button>
              </div>
            </div>
          </div>
        </motion.section>
      ) : null}
    </AnimatePresence>
  );
}
