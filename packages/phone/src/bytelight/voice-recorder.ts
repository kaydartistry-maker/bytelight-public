// Browser-side microphone capture shared by composer dictation and the
// foreground voice-conversation loop. MediaRecorder sends encoded chunks
// over the existing WebSocket; optional local VAD ends a conversation turn
// after the speaker stops.

import { send } from './socket';
import { setState } from './store';
import { VAD_WORKLET_SOURCE } from './vad-worklet';

export type VoiceRecordingMode = 'dictation' | 'conversation';

export interface VoiceRecordingOptions {
  mode?: VoiceRecordingMode;
  /** Opt in to the server-side Hume EVI tone sidecar for this utterance. */
  analyzeTone?: boolean;
  autoStopOnSilence?: boolean;
  silenceMs?: number;
  minSpeechMs?: number;
  /**
   * Total voiced time a capture must accumulate before it is worth sending.
   * Below this the clip is road noise or a bumped mic, and a transcriber given
   * nothing to transcribe invents something — stock video sign-offs, or our own
   * spelling hint read back aloud (both seen in the car, Jul 28 2026).
   */
  minVoicedMs?: number;
  maxUtteranceMs?: number;
  maxWaitForSpeechMs?: number;
  maxCaptureMs?: number;
  onLevel?: (level: number) => void;
  onSpeechStart?: () => void;
  onSpeechTimeout?: () => void;
}

let mediaRecorder: MediaRecorder | null = null;
let activeStream: MediaStream | null = null;
/**
 * The microphone line is opened ONCE per call and kept between turns.
 *
 * Same trap as the audio context below, one floor up. Every turn used to call
 * getUserMedia and stop the tracks again when the turn ended, and a hidden page
 * asking Android for a fresh microphone gets one back that is open and carries
 * nothing. So the first turn after she carried a call out of Bytelight landed — its
 * line was opened while she was still looking at the app — and every turn after
 * it recorded silence until she opened Bytelight and the ask could be made by a page
 * the phone considered awake. Reopening the app was never reconnecting anything;
 * it was making the next request from the foreground.
 *
 * Retention belongs to the CALL, not to a turn, and is deliberately opt-in:
 * composer dictation is a one-shot and must still hand the microphone straight
 * back, or the recording indicator sits lit on her status bar for nothing.
 */
let retainedStream: MediaStream | null = null;
let retainMicrophone = false;
let activeRecordingId: string | null = null;
let pendingTranscriptionId: string | null = null;
let suppressStopFrame = false;
let audioContext: AudioContext | null = null;
/**
 * The audio context is built ONCE and kept between turns.
 *
 * It used to be created and closed for every single turn, and a context built
 * while the phone believes nobody is watching can be born suspended and refuse
 * to resume without a gesture. So the first turn after she carried a call out
 * of Bytelight worked — its rig was built while she was still here — and every turn
 * after it built a listening rig that never woke up, until she opened the app
 * and gave it the gesture it wanted. Building it while she is here and keeping
 * it is the whole fix. One idle context costs nothing.
 */
let vadModuleLoadedFor: AudioContext | null = null;
let analyserFrame: number | null = null;
/**
 * A second, independent driver for the speech detector, living on the audio
 * thread. requestAnimationFrame stops firing the moment the page is not being
 * drawn, so leaving Bytelight mid-call froze the part that notices her talking
 * while the microphone stayed wide open. This one keeps its rhythm off screen.
 *
 * It is strictly ADDITIVE: the screen clock below is left exactly as it was, so
 * the worst this can do is fail to help. Everything the detector accumulates is
 * measured from elapsed time, so being woken by both drivers double-counts
 * nothing.
 */
let vadWorklet: AudioWorkletNode | null = null;
/** Module-scoped so the asynchronous worklet attach can still reach it. */
let analyserSource: MediaStreamAudioSourceNode | null = null;
let levelCallback: ((level: number) => void) | null = null;
let captureGeneration = 0;
let startingGeneration: number | null = null;
// Voiced time measured by this capture's VAD, readable by the manual-stop path
// so a tap on a silent capture is discarded the same way an auto-stop is.
let activeVoicedMs: number | null = null;
let activeMinVoicedMs = 0;
let voicelessCaptureHandler: (() => void) | null = null;

function pickMimeType(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) {
    return 'audio/webm';
  }
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return '';
}

function getAudioContextConstructor(): typeof AudioContext | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.AudioContext
    || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}

function makeRecordingId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `voice-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
  }
  return btoa(binary);
}

function stopAnalyser(): void {
  if (analyserFrame !== null) cancelAnimationFrame(analyserFrame);
  analyserFrame = null;
  if (vadWorklet) {
    vadWorklet.port.onmessage = null;
    try { vadWorklet.disconnect(); } catch { /* already torn down */ }
  }
  vadWorklet = null;
  if (analyserSource) {
    try { analyserSource.disconnect(); } catch { /* already torn down */ }
  }
  analyserSource = null;
  activeVoicedMs = null;
  activeMinVoicedMs = 0;
  voicelessCaptureHandler = null;
  levelCallback?.(0);
  levelCallback = null;
  // Deliberately NOT closed — see the note on vadModuleLoadedFor. The nodes for
  // this turn are gone; the context itself lives on for the next one.
}

function beginVoiceActivityDetection(
  stream: MediaStream,
  recorder: MediaRecorder,
  recordingId: string,
  options: VoiceRecordingOptions,
): boolean {
  if (!options.autoStopOnSilence) return false;

  const AudioContextCtor = getAudioContextConstructor();
  if (!AudioContextCtor) return false;

  let analyser: AnalyserNode;
  try {
    if (!audioContext || audioContext.state === 'closed') {
      audioContext = new AudioContextCtor();
      vadModuleLoadedFor = null;
    }
    if (audioContext.state === 'suspended') {
      void audioContext.resume().catch(() => {
        /* The initial call gesture normally unlocks this; levels stay at zero
           until the browser grants it if a WebView is stricter. */
      });
    }
    analyserSource = audioContext.createMediaStreamSource(stream);
    const source = analyserSource;
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.25;
    source.connect(analyser);
  } catch {
    stopAnalyser();
    return false;
  }

  const samples = new Float32Array(analyser.fftSize);
  const startedAt = performance.now();
  const calibrationUntil = startedAt + 600;
  const silenceMs = options.silenceMs ?? 1150;
  const minSpeechMs = options.minSpeechMs ?? 250;
  const maxUtteranceMs = options.maxUtteranceMs ?? 90_000;
  const maxWaitForSpeechMs = options.maxWaitForSpeechMs;
  const minVoicedMs = options.minVoicedMs ?? 0;
  let noiseFloor = 0.006;
  let speechFrames = 0;
  let speechStartedAt = 0;
  let lastSpeechAt = 0;
  let heardSpeech = false;
  let lastLevelAt = 0;
  let voicedMs = 0;
  let lastTickAt = startedAt;
  levelCallback = options.onLevel || null;
  activeVoicedMs = 0;
  activeMinVoicedMs = minVoicedMs;
  voicelessCaptureHandler = options.onSpeechTimeout || null;

  const tick = () => {
    if (activeRecordingId !== recordingId || recorder.state !== 'recording') return;

    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / samples.length);
    const now = performance.now();

    if (
      !heardSpeech
      && maxWaitForSpeechMs !== undefined
      && now - startedAt >= maxWaitForSpeechMs
    ) {
      cancelSpecificRecording(recorder, recordingId);
      options.onSpeechTimeout?.();
      return;
    }

    if (!heardSpeech && now < calibrationUntil) {
      noiseFloor = noiseFloor * 0.88 + rms * 0.12;
    }
    // Adaptive enough for fans and old-house background noise, but capped so
    // a noisy calibration window cannot make ordinary speech invisible.
    const threshold = Math.max(0.018, Math.min(0.08, noiseFloor * 2.4 + 0.006));

    if (now - lastLevelAt >= 50) {
      levelCallback?.(Math.min(1, rms / Math.max(threshold * 1.8, 0.001)));
      lastLevelAt = now;
    }

    const frameMs = Math.min(100, Math.max(0, now - lastTickAt));
    lastTickAt = now;

    if (rms >= threshold) {
      speechFrames += 1;
      lastSpeechAt = now;
      voicedMs += frameMs;
      activeVoicedMs = voicedMs;
      if (!heardSpeech && speechFrames >= 3) {
        heardSpeech = true;
        speechStartedAt = now;
        options.onSpeechStart?.();
      }
    } else {
      speechFrames = Math.max(0, speechFrames - 1);
    }

    if (
      heardSpeech
      && now - speechStartedAt >= minSpeechMs
      && now - lastSpeechAt >= silenceMs
    ) {
      // A gust, a bump or a truck passing can clear the threshold for a few
      // frames without a word in it. Drop that clip rather than handing the
      // transcriber silence and letting it fill the gap for her.
      if (voicedMs < minVoicedMs) {
        cancelSpecificRecording(recorder, recordingId);
        options.onSpeechTimeout?.();
        return;
      }
      stopSpecificRecording(recorder, recordingId);
      return;
    }

    if (heardSpeech && now - speechStartedAt >= maxUtteranceMs) {
      stopSpecificRecording(recorder, recordingId);
      return;
    }

    analyserFrame = requestAnimationFrame(tick);
  };

  analyserFrame = requestAnimationFrame(tick);
  void attachAudioThreadDriver(recordingId, tick);
  return true;
}

/**
 * Load the worklet and wire it to the same microphone source. Asynchronous, so
 * the screen clock covers the first fraction of a second on its own, and every
 * failure path simply leaves the detector running exactly as it does today.
 */
async function attachAudioThreadDriver(recordingId: string, tick: () => void): Promise<void> {
  const context = audioContext;
  const source = analyserSource;
  if (!context || !source || !context.audioWorklet) return;
  try {
    // Registering the same processor name twice on one context is an error,
    // and the context now outlives the turn that built it.
    if (vadModuleLoadedFor !== context) {
      const moduleUrl = URL.createObjectURL(
        new Blob([VAD_WORKLET_SOURCE], { type: 'text/javascript' }),
      );
      try {
        await context.audioWorklet.addModule(moduleUrl);
      } finally {
        URL.revokeObjectURL(moduleUrl);
      }
      vadModuleLoadedFor = context;
    }
    // The call may have ended while the module was loading.
    if (audioContext !== context || activeRecordingId !== recordingId) return;
    const node = new AudioWorkletNode(context, 'bytelight-vad-tick', {
      numberOfInputs: 1,
      // No outputs, so it never needs routing to a speaker to run — which is
      // what keeps echo cancellation from scrubbing her voice to silence.
      numberOfOutputs: 0,
    });
    node.port.onmessage = () => tick();
    source.connect(node);
    vadWorklet = node;
  } catch {
    // No worklet support, a blocked module fetch, a stricter engine: the screen
    // clock is still running and nothing has changed.
    vadWorklet = null;
  }
}

function hasLiveAudio(stream: MediaStream | null): stream is MediaStream {
  if (!stream) return false;
  const tracks = stream.getAudioTracks();
  return tracks.length > 0 && tracks.some((track) => track.readyState === 'live');
}

function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

/** Hand the line back — unless it is the retained one and a call is still up. */
function releaseStream(stream: MediaStream | null): void {
  if (!stream) return;
  if (retainMicrophone && stream === retainedStream) return;
  stopStream(stream);
  if (stream === retainedStream) retainedStream = null;
}

/**
 * Held open for the length of a call and closed the moment one ends. The
 * overlay owns this: it goes on when the call opens and off when it closes,
 * so nothing else in the app can leave the microphone lit.
 */
export function setMicrophoneRetention(on: boolean): void {
  retainMicrophone = on;
  if (on) return;
  const held = retainedStream;
  retainedStream = null;
  // A capture still running hands this back through releaseCapture, which now
  // finds retention switched off underneath it.
  if (held && !isVoiceRecording()) stopStream(held);
}

function releaseCapture(recordingId: string, stream: MediaStream, recorder: MediaRecorder): void {
  // Always release this capture's own stream, never whichever stream happens to
  // be in the global slot by the time async Blob conversion finishes. Mid-call
  // the line itself stays open; only this turn's hold on it ends.
  releaseStream(stream);
  if (activeRecordingId !== recordingId) return;
  stopAnalyser();
  if (activeStream === stream) activeStream = null;
  if (mediaRecorder === recorder) mediaRecorder = null;
  activeRecordingId = null;
  suppressStopFrame = false;
}

function stopSpecificRecording(recorder: MediaRecorder, recordingId: string): void {
  if (activeRecordingId !== recordingId || recorder.state === 'inactive') return;
  stopAnalyser();
  setState({ transcription: { status: 'processing', recordingId } });
  recorder.stop();
}

function cancelSpecificRecording(recorder: MediaRecorder, recordingId: string): void {
  if (activeRecordingId !== recordingId || recorder.state === 'inactive') return;
  suppressStopFrame = true;
  stopAnalyser();
  setState({ transcription: { status: 'idle' } });
  recorder.stop();
}

export async function startVoiceRecording(options: VoiceRecordingOptions = {}): Promise<string> {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') return activeRecordingId || '';
  if (activeRecordingId) {
    // The recorder has stopped but its final MediaRecorder blob is still
    // converting. Refuse a handoff until that capture releases instead of
    // letting old audio bleed into a new recording.
    throw new Error('The previous microphone turn is still closing');
  }
  if (startingGeneration !== null) return '';

  const generation = ++captureGeneration;
  startingGeneration = generation;

  setState({ transcription: { status: 'recording' } });

  let stream: MediaStream;
  if (retainMicrophone && hasLiveAudio(retainedStream)) {
    // The line is already open from an earlier turn of this call. Asking for a
    // fresh one from a page the phone believes is asleep is the whole bug.
    stream = retainedStream;
  } else {
    if (retainedStream) {
      stopStream(retainedStream);
      retainedStream = null;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      if (startingGeneration === generation) startingGeneration = null;
      if (generation !== captureGeneration) return '';
      setState({
        transcription: {
          status: 'error',
          error: err instanceof Error && err.name === 'NotAllowedError'
            ? 'Microphone permission denied'
            : 'Could not access microphone',
        },
      });
      throw err;
    }
    if (retainMicrophone) retainedStream = stream;
  }

  if (generation !== captureGeneration) {
    releaseStream(stream);
    if (startingGeneration === generation) startingGeneration = null;
    return '';
  }
  if (startingGeneration === generation) startingGeneration = null;
  activeStream = stream;

  const mimeType = pickMimeType();
  const recordingId = makeRecordingId();
  activeRecordingId = recordingId;
  pendingTranscriptionId = null;
  suppressStopFrame = false;
  setState({ transcription: { status: 'recording', recordingId } });

  try {
    mediaRecorder = mimeType
      ? new MediaRecorder(activeStream, { mimeType })
      : new MediaRecorder(activeStream);
  } catch (err) {
    // A line the recorder will not accept is no good to the next turn either,
    // so this one is dropped outright rather than retained.
    stopStream(activeStream);
    if (retainedStream === activeStream) retainedStream = null;
    activeStream = null;
    activeRecordingId = null;
    setState({ transcription: { status: 'error', error: 'Could not start microphone recording' } });
    throw err;
  }

  const captureStream = stream;
  const captureRecorder = mediaRecorder;
  const pendingChunkSends = new Set<Promise<void>>();
  let chunkSendChain: Promise<void> = Promise.resolve();
  let hardCaptureTimer: number | null = null;
  const analyzeTone = options.analyzeTone === true && isRealtimeToneRecordingSupported();
  const actualMimeType = captureRecorder.mimeType || mimeType || 'audio/webm';

  captureRecorder.addEventListener('dataavailable', (event) => {
    if (!event.data || event.data.size === 0) return;
    // Short EVI chunks must retain recorder order. ArrayBuffer conversion is
    // asynchronous, so serialize the sends instead of trusting completion
    // order when several 100ms blobs are in flight at once.
    const task = chunkSendChain
      .then(() => blobToBase64(event.data))
      .then((data) => send({ type: 'voice_audio', data, recordingId }))
      .catch(() => {
        /* one broken chunk should not tear down the microphone */
      });
    chunkSendChain = task;
    pendingChunkSends.add(task);
    void task.finally(() => {
      pendingChunkSends.delete(task);
    });
  });

  captureRecorder.addEventListener('stop', () => {
    if (hardCaptureTimer !== null) window.clearTimeout(hardCaptureTimer);
    hardCaptureTimer = null;
    pendingTranscriptionId = recordingId;
    const pending = Array.from(pendingChunkSends);
    void Promise.allSettled(pending).then(() => {
      const cancelled = suppressStopFrame;
      if (cancelled) {
        send({ type: 'voice_cancel', recordingId });
        pendingTranscriptionId = null;
      } else {
        send({ type: 'voice_stop', recordingId });
        pendingTranscriptionId = recordingId;
      }
      releaseCapture(recordingId, captureStream, captureRecorder);
    });
  });

  captureRecorder.addEventListener('error', () => {
    if (hardCaptureTimer !== null) window.clearTimeout(hardCaptureTimer);
    hardCaptureTimer = null;
    suppressStopFrame = true;
    send({ type: 'voice_cancel', recordingId });
    setState({ transcription: { status: 'error', error: 'Microphone recording failed' } });
  });

  // Hume recommends 100ms web chunks for real-time expression measurement.
  // Keep the quieter 1s cadence everywhere else so ordinary dictation and
  // tone-disabled calls do not create unnecessary WebSocket traffic.
  try {
    captureRecorder.start(options.mode === 'conversation' && analyzeTone ? 100 : 1000);
  } catch (err) {
    releaseCapture(recordingId, captureStream, captureRecorder);
    setState({ transcription: { status: 'error', error: 'Could not start microphone recording' } });
    throw err;
  }
  // Start the backend turn only after MediaRecorder has accepted the stream.
  // dataavailable cannot fire until a later task, so the header still follows
  // this control frame while a failed recorder never opens a paid EVI socket.
  send({
    type: 'voice_start',
    mimeType: actualMimeType,
    mode: options.mode || 'dictation',
    recordingId,
    analyzeTone,
  });
  if (options.maxCaptureMs !== undefined) {
    hardCaptureTimer = window.setTimeout(() => {
      cancelSpecificRecording(captureRecorder, recordingId);
      options.onSpeechTimeout?.();
    }, options.maxCaptureMs);
  }
  const vadStarted = beginVoiceActivityDetection(captureStream, captureRecorder, recordingId, {
    ...options,
    onSpeechStart: () => {
      options.onSpeechStart?.();
    },
  });
  // If an apparently available AudioContext still fails to initialize, close
  // the just-opened optional tone turn immediately rather than leaving a paid
  // paused EVI socket behind an unbounded recorder.
  if (analyzeTone && !vadStarted) {
    cancelSpecificRecording(captureRecorder, recordingId);
    options.onSpeechTimeout?.();
  }
  return recordingId;
}

export function stopVoiceRecording(): void {
  if (!mediaRecorder || !activeRecordingId) return;
  // A deliberate tap on a capture that never heard a word goes the same way an
  // auto-stop does: discarded, not transcribed.
  if (activeVoicedMs !== null && activeMinVoicedMs > 0 && activeVoicedMs < activeMinVoicedMs) {
    const onVoiceless = voicelessCaptureHandler;
    cancelSpecificRecording(mediaRecorder, activeRecordingId);
    onVoiceless?.();
    return;
  }
  stopSpecificRecording(mediaRecorder, activeRecordingId);
}

export function cancelVoiceRecording(): void {
  captureGeneration += 1;
  const recordingId = activeRecordingId;
  if (!mediaRecorder || mediaRecorder.state === 'inactive' || !recordingId) {
    suppressStopFrame = true;
    const pendingId = recordingId || pendingTranscriptionId;
    if (pendingId) {
      send({ type: 'voice_cancel', recordingId: pendingId });
      pendingTranscriptionId = null;
    }
    stopAnalyser();
    releaseStream(activeStream);
    activeStream = null;
    setState({ transcription: { status: 'idle' } });
    return;
  }
  suppressStopFrame = true;
  cancelSpecificRecording(mediaRecorder, recordingId);
}

export function clearTranscription(): void {
  pendingTranscriptionId = null;
  setState({ transcription: { status: 'idle' } });
}

export function isRecordingSupported(): boolean {
  return (
    typeof navigator !== 'undefined'
    && !!navigator.mediaDevices
    && typeof navigator.mediaDevices.getUserMedia === 'function'
    && typeof MediaRecorder !== 'undefined'
  );
}

export function isRealtimeToneRecordingSupported(): boolean {
  return isRecordingSupported() && !!getAudioContextConstructor();
}

export function isVoiceRecording(): boolean {
  return !!mediaRecorder && mediaRecorder.state === 'recording';
}
