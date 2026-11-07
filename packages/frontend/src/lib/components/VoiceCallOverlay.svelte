<!--
  Live voice-call surface — hands-free continuous conversation with Companion A and
  Companion B. Behavioral translation of reference implementation's phone VoiceModeOverlay into
  byte-light's house style (Svelte 5 runes, app CSS vars, svelte/transition).

  The turn loop (9 phases): gesture → unlock playback → listen (VAD auto-stop)
  → transcribe → send the utterance as a user message → watch for the reply →
  speak BOTH companions in order → back to listening. A tap during
  speaking/synthesizing interrupts and re-listens immediately.

  Reply correlation: byte-light's message send path persists and echoes back
  `metadata` on the user's own message (ws.ts handleMessageSend → broadcast).
  So we stamp each utterance with a voiceSessionId + utteranceId, find the
  server echo of that exact message, then take the first companion message at a
  higher sequence — and wait for any in-progress stream to finish before TTS.

  Native/pocket/Capacitor code paths from the reference are dropped (a browser
  tab has no durable background call); visibilitychange safe-stop is kept.
-->
<script lang="ts">
  import { fade, scale } from 'svelte/transition';
  import {
    send,
    getMessages,
    getConnectionState,
    getPresence,
    isStreaming,
    getTranscriptionStatus,
    getTranscriptionText,
    getTranscriptionError,
    getTranscriptionProsody,
    getTranscriptionRecordingId,
    getTranscriptionProsodyStatus,
    clearTranscription as clearStoreTranscription,
  } from '$lib/stores/websocket.svelte';
  import {
    startVoiceRecording,
    stopVoiceRecording,
    cancelVoiceRecording,
    isRecordingSupported,
    makeRecordingId,
  } from '$lib/voice/recorder';
  import {
    unlockVoicePlayback,
    playVoiceSequence,
    requestMessageTtsStream,
    requestMessageTts,
    stopVoicePlayback,
    suspendVoicePlayback,
    isMessageTtsStreamUnavailable,
  } from '$lib/voice/playback';

  type Phase =
    | 'starting'
    | 'ready'
    | 'listening'
    | 'hearing'
    | 'transcribing'
    | 'thinking'
    | 'synthesizing'
    | 'speaking'
    | 'error';

  type SpeakerId = 'companion-a' | 'companion-b';

  let {
    open = false,
    threadId = null,
    threadName = '',
    onclose,
  }: {
    open?: boolean;
    threadId?: string | null;
    threadName?: string;
    onclose?: () => void;
  } = $props();

  // The roster is byte-light's two-voice constellation. Emoji match speakers.ts
  // AVATAR so who-is-speaking reads consistently across the app.
  const ROSTER: { id: SpeakerId; name: string; emoji: string }[] = [
    { id: 'companion-a', name: 'Companion A', emoji: '🔷' },
    { id: 'companion-b', name: 'Companion B', emoji: '🔶' },
  ];

  // --- Dock persistence (resonant.* namespace — no fork-foreign keys) ---
  const DOCK_POSITION_KEY = 'bytelight.voice.dock-position';
  const DOCK_W = 132;
  const DOCK_H = 60;

  interface DockPosition { x: number; y: number; }

  function clampDock(p: DockPosition): DockPosition {
    if (typeof window === 'undefined') return p;
    const inset = 12;
    return {
      x: Math.min(Math.max(inset, p.x), Math.max(inset, window.innerWidth - DOCK_W - inset)),
      y: Math.min(Math.max(inset, p.y), Math.max(inset, window.innerHeight - DOCK_H - inset)),
    };
  }
  function defaultDock(): DockPosition {
    if (typeof window === 'undefined') return { x: 12, y: 12 };
    return clampDock({ x: window.innerWidth - DOCK_W - 16, y: window.innerHeight - DOCK_H - 96 });
  }
  function savedDock(): DockPosition | null {
    try {
      const raw = localStorage.getItem(DOCK_POSITION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<DockPosition>;
      if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return null;
      return clampDock({ x: parsed.x, y: parsed.y });
    } catch {
      return null;
    }
  }

  // --- Reactive state ---
  let phase = $state<Phase>('starting');
  let level = $state(0);
  let lastTranscript = $state('');
  let lastToneStatus = $state<'complete' | 'unavailable' | null>(null);
  let errorMsg = $state<string | null>(null);
  let minimized = $state(false);
  let dockPosition = $state<DockPosition | null>(savedDock());
  let speakingId = $state<SpeakerId | null>(null);

  // --- Non-reactive turn machinery (refs) ---
  let active = false;
  let epoch = 0;             // bumps on every teardown; stale async work checks it
  let turn = 0;              // bumps on every new TTS turn / interrupt
  let sessionId = '';
  let boundThread: string | null = null;
  let awaitingTranscript = false;
  let utteranceId = '';
  let pendingReply: { threadId: string; sessionId: string; utteranceId: string; userSequence?: number } | null = null;
  let ttsAbort: AbortController | null = null;
  let closeNotified = false;

  // --- Derived store reads (drive the reply-watch + transcript effects) ---
  const messages = $derived(getMessages());
  const connectionState = $derived(getConnectionState());
  const transcriptionStatus = $derived(getTranscriptionStatus());

  function setPhase(next: Phase) {
    phase = next;
    if (next !== 'speaking') speakingId = null;
  }

  function friendlyError(raw: unknown, fallback: string): string {
    const message = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : '';
    if (!message) return fallback;
    return message.length > 220 ? `${message.slice(0, 217)}…` : message;
  }

  function isAbort(err: unknown): boolean {
    return err instanceof DOMException ? err.name === 'AbortError'
      : err instanceof Error && err.name === 'AbortError';
  }

  // Split the reply into ordered speaker chunks so the dock/surface can show
  // WHICH companion is speaking as each segment plays. Marker set mirrors
  // speakers.ts (which we must not import-modify); a light local read is fine.
  function speakerSequence(content: string): SpeakerId[] {
    const re = /🔷|🔶|\bCompanion A\b|\bCompanion B\b/g;
    const out: SpeakerId[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const id: SpeakerId = m[0].includes('Companion A') || m[0].includes('🔷') ? 'companion-a' : 'companion-b';
      if (out[out.length - 1] !== id) out.push(id);
    }
    return out.length ? out : ['companion-a'];
  }

  function stopSession(notifyParent: boolean) {
    if (!active && !notifyParent) return;
    active = false;
    epoch += 1;
    turn += 1;
    awaitingTranscript = false;
    pendingReply = null;
    ttsAbort?.abort();
    ttsAbort = null;
    cancelVoiceRecording();
    stopVoicePlayback();
    clearStoreTranscription();
    level = 0;
    void suspendVoicePlayback();

    if (notifyParent && !closeNotified) {
      closeNotified = true;
      onclose?.();
    }
  }

  async function beginListening() {
    if (!active || !boundThread) return;
    if (connectionState !== 'connected') {
      awaitingTranscript = false;
      errorMsg = 'The connection dropped. Tap to retry when it reconnects.';
      setPhase('error');
      return;
    }
    const presence = getPresence();
    if (presence === 'active' || presence === 'waking' || isStreaming()) {
      awaitingTranscript = false;
      errorMsg = 'Let the current reply finish before starting another voice turn.';
      setPhase('error');
      return;
    }
    const myEpoch = epoch;
    awaitingTranscript = true;
    pendingReply = null;
    ttsAbort?.abort();
    ttsAbort = null;
    stopVoicePlayback();
    clearStoreTranscription();
    errorMsg = null;
    level = 0;
    setPhase('listening');

    try {
      const recordingId = await startVoiceRecording({
        mode: 'conversation',
        autoStopOnSilence: true,
        silenceMs: 1050,
        minSpeechMs: 250,
        maxUtteranceMs: 90_000,
        maxWaitForSpeechMs: 10_000,
        maxCaptureMs: 120_000,
        onLevel: (l) => { if (active && epoch === myEpoch) level = l; },
        onSpeechStart: () => { if (active && epoch === myEpoch) setPhase('hearing'); },
        onSpeechTimeout: () => {
          if (!active || epoch !== myEpoch) return;
          awaitingTranscript = false;
          clearStoreTranscription();
          errorMsg = null;
          level = 0;
          setPhase('ready');
        },
      });
      // The permission sheet can outlive the overlay. If the call closed while
      // getUserMedia was waiting, tear the stream down instead of leaving a
      // recorder behind the UI.
      if (!active || epoch !== myEpoch) {
        cancelVoiceRecording();
        return;
      }
      utteranceId = recordingId;
    } catch (caught) {
      if (!active || epoch !== myEpoch) return;
      awaitingTranscript = false;
      errorMsg = friendlyError(caught, 'Could not open the microphone.');
      setPhase('error');
    }
  }

  async function startFromGesture() {
    if (!active) return;
    try {
      if (connectionState !== 'connected') throw new Error('Still reconnecting');
      const presence = getPresence();
      if (presence === 'active' || presence === 'waking' || isStreaming()) {
        throw new Error('Let the current reply finish before starting another voice turn.');
      }
      await unlockVoicePlayback();
      await beginListening();
    } catch (caught) {
      if (!active) return;
      errorMsg = friendlyError(caught, 'Could not start the call.');
      setPhase('error');
    }
  }

  async function speakMessage(messageId: string, content: string) {
    if (!active) return;
    const myEpoch = epoch;
    const myTurn = ++turn;
    const controller = new AbortController();
    ttsAbort?.abort();
    ttsAbort = controller;
    setPhase('synthesizing');

    const order = speakerSequence(content);

    try {
      let urls: string[];
      try {
        const manifest = await requestMessageTtsStream(messageId, controller.signal);
        urls = manifest.segments.map((s) => s.url);
      } catch (caught) {
        if (isAbort(caught) || controller.signal.aborted) throw caught;
        // Only fall back for a backend that has no stream route yet. No audio
        // has begun, so the combined render cannot duplicate spoken output.
        if (!isMessageTtsStreamUnavailable(caught)) throw caught;
        const rendered = await requestMessageTts(messageId, controller.signal);
        urls = [rendered.url];
      }
      if (!active || epoch !== myEpoch || turn !== myTurn) return;
      setPhase('speaking');
      // Best-effort speaker indicator: if segment count matches the marker
      // order, light each companion as their segment plays.
      if (urls.length === order.length) {
        // The wrapper owns its own validity check, mic restart, and error →
        // error-phase handling, so await it and return: exactly one
        // post-playback beginListening() fires from inside it. Do NOT fall
        // through to the shared restart below or the mic would abort the
        // audio it just started.
        speakingId = order[0];
        await playSequenceWithSpeaker(urls, order, controller.signal, myEpoch, myTurn);
        return;
      }
      speakingId = order[0] ?? null;
      await playVoiceSequence(urls, controller.signal);
      if (!active || epoch !== myEpoch || turn !== myTurn) return;
      await beginListening();
    } catch (caught) {
      if (isAbort(caught) || !active || epoch !== myEpoch || turn !== myTurn) return;
      errorMsg = friendlyError(caught, 'Could not play their reply.');
      setPhase('error');
    } finally {
      if (ttsAbort === controller) ttsAbort = null;
    }
  }

  // Play segments one at a time so the speaker indicator can advance in step
  // with each companion's voice. Falls through to beginListening on completion.
  async function playSequenceWithSpeaker(
    urls: string[],
    order: SpeakerId[],
    signal: AbortSignal,
    myEpoch: number,
    myTurn: number,
  ) {
    try {
      for (let i = 0; i < urls.length; i++) {
        if (!active || epoch !== myEpoch || turn !== myTurn || signal.aborted) return;
        speakingId = order[i] ?? speakingId;
        await playVoiceSequence([urls[i]], signal);
      }
      if (!active || epoch !== myEpoch || turn !== myTurn) return;
      await beginListening();
    } catch (caught) {
      if (isAbort(caught) || !active || epoch !== myEpoch || turn !== myTurn) return;
      errorMsg = friendlyError(caught, 'Could not play their reply.');
      setPhase('error');
    }
  }

  function interruptAndListen() {
    turn += 1;
    ttsAbort?.abort();
    ttsAbort = null;
    stopVoicePlayback();
    void beginListening();
  }

  function handlePrimaryAction() {
    switch (phase) {
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
  }

  function handleEnd() {
    stopSession(true);
  }

  // --- Effect: session lifecycle (open/close) ---
  $effect(() => {
    if (!open) return;
    closeNotified = false;
    active = true;
    epoch += 1;
    const myEpoch = epoch;
    sessionId = makeRecordingId();
    boundThread = threadId;
    awaitingTranscript = false;
    pendingReply = null;
    lastTranscript = '';
    lastToneStatus = null;
    errorMsg = null;
    level = 0;
    minimized = false;
    setPhase('starting');

    (async () => {
      try {
        if (!threadId) throw new Error('Open a conversation before starting a call.');
        if (!isRecordingSupported()) throw new Error('This browser cannot record microphone audio.');
        if (connectionState !== 'connected') throw new Error('Still reconnecting — try again in a moment.');
        const presence = getPresence();
        if (presence === 'active' || presence === 'waking' || isStreaming()) {
          throw new Error('Let the current reply finish before starting a call.');
        }
        try {
          await unlockVoicePlayback();
        } catch {
          if (active && epoch === myEpoch) setPhase('ready');
          return;
        }
        if (active && epoch === myEpoch) await beginListening();
      } catch (caught) {
        if (!active || epoch !== myEpoch) return;
        errorMsg = friendlyError(caught, 'Could not start the call.');
        setPhase('error');
      }
    })();

    return () => stopSession(false);
  });

  // --- Effect: auto-submit the transcription exactly once ---
  $effect(() => {
    // touch reactive deps
    const status = transcriptionStatus;
    void messages;
    if (!active || !awaitingTranscript) return;

    const recId = getTranscriptionRecordingId();
    if (recId && utteranceId && recId !== utteranceId) return;

    if (status === 'processing') {
      level = 0;
      setPhase('transcribing');
      return;
    }
    if (status === 'error') {
      awaitingTranscript = false;
      cancelVoiceRecording();
      errorMsg = friendlyError(getTranscriptionError(), 'I could not hear that turn.');
      setPhase('error');
      clearStoreTranscription();
      return;
    }
    if (status !== 'complete') return;

    awaitingTranscript = false;
    const text = (getTranscriptionText() ?? '').trim();
    const prosody = getTranscriptionProsody();
    const prosodyStatus = getTranscriptionProsodyStatus();
    clearStoreTranscription();
    if (!text) {
      errorMsg = 'I did not catch any words. Tap the center and try again.';
      setPhase('error');
      return;
    }

    const thread = boundThread;
    if (!thread) return;
    const uId = utteranceId || makeRecordingId();
    pendingReply = { threadId: thread, sessionId, utteranceId: uId };
    lastTranscript = text;
    lastToneStatus = prosodyStatus;
    setPhase('thinking');

    const metadata: Record<string, unknown> = { source: 'voice_call', voiceSessionId: sessionId, utteranceId: uId };
    if (prosody) metadata.prosody = prosody;

    send({ type: 'message', threadId: thread, content: text, contentType: 'text', metadata });
  });

  // --- Effect: watch for the companion reply, then speak it ---
  $effect(() => {
    const msgs = messages;
    if (!active || phase !== 'thinking') return;
    const pending = pendingReply;
    if (!pending) return;

    // Find the server echo of THIS utterance first (matched by our stamped
    // metadata), so an unrelated spontaneous companion message can't be
    // mistaken for the answer to this turn.
    if (pending.userSequence === undefined) {
      const echo = msgs.find((m) =>
        m.thread_id === pending.threadId &&
        m.role === 'user' &&
        (m.metadata as Record<string, unknown> | null)?.voiceSessionId === pending.sessionId &&
        (m.metadata as Record<string, unknown> | null)?.utteranceId === pending.utteranceId
      );
      if (!echo) return;
      pending.userSequence = echo.sequence;
    }

    const reply = msgs
      .filter((m) =>
        m.thread_id === pending.threadId &&
        m.sequence > (pending.userSequence as number) &&
        m.role === 'companion' &&
        !m.deleted_at
      )
      .sort((a, b) => a.sequence - b.sequence)[0];
    if (!reply) return;

    // If that reply is still streaming, wait for it to finalize before TTS —
    // the store appends the finalized message on stream_end, and isStreaming()
    // clears then. Re-runs when `messages` updates.
    if (isStreaming()) return;

    pendingReply = null;
    if (reply.content_type !== 'text' || !reply.content.trim() || reply.content === '[No response]') {
      void beginListening();
      return;
    }
    void speakMessage(reply.id, reply.content);
  });

  // --- Effect: a call never follows the user into another thread ---
  $effect(() => {
    const t = threadId;
    if (!open || !active) return;
    if (boundThread && t !== boundThread) stopSession(true);
  });

  // --- Effect: connection drop mid-call → error phase, never a hot mic ---
  $effect(() => {
    const cs = connectionState;
    if (!open || !active || cs === 'connected') return;
    turn += 1;
    awaitingTranscript = false;
    pendingReply = null;
    ttsAbort?.abort();
    ttsAbort = null;
    cancelVoiceRecording();
    stopVoicePlayback();
    errorMsg = 'The connection dropped. Tap to retry when it reconnects.';
    setPhase('error');
  });

  // --- Effect: a browser tab has no durable call — hide = safe stop ---
  $effect(() => {
    if (!open) return;
    const onVisibility = () => {
      if (document.hidden && active) stopSession(true);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  });

  // --- Effect: keep the dock inside the viewport on resize ---
  $effect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => { dockPosition = dockPosition ? clampDock(dockPosition) : dockPosition; };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  // --- Dock drag ---
  let drag: { pointerId: number; startX: number; startY: number; origin: DockPosition; moved: boolean } | null = null;
  let suppressDockTap = false;

  function beginDockDrag(e: PointerEvent) {
    if ((e.target as HTMLElement).closest('[data-dock-control]')) return;
    const origin = dockPosition || defaultDock();
    drag = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, origin, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function moveDock(e: PointerEvent) {
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) drag.moved = true;
    dockPosition = clampDock({ x: drag.origin.x + dx, y: drag.origin.y + dy });
  }
  function endDockDrag(e: PointerEvent) {
    if (!drag || drag.pointerId !== e.pointerId) return;
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    const moved = drag.moved;
    drag = null;
    if (!moved) return;
    // moveDock already tracked the live position into dockPosition; a drag end
    // just pins and persists wherever it landed, and suppresses the tap that
    // would otherwise fire from this same pointer release.
    suppressDockTap = true;
    const landed = clampDock(dockPosition ?? defaultDock());
    dockPosition = landed;
    try { localStorage.setItem(DOCK_POSITION_KEY, JSON.stringify(landed)); } catch { /* movable this session */ }
    setTimeout(() => { suppressDockTap = false; }, 0);
  }

  function dockTap() {
    if (suppressDockTap) return;
    if (phase === 'ready' || phase === 'error') handlePrimaryAction();
    else minimized = false;
  }

  // --- View helpers ---
  const busy = $derived(phase === 'starting' || phase === 'transcribing' || phase === 'thinking');
  const micLive = $derived(phase === 'listening' || phase === 'hearing');
  const speaking = $derived(phase === 'speaking' || phase === 'synthesizing');
  const canPress = $derived(!busy);
  const who = 'The constellation';

  function copyFor(p: Phase): { title: string; detail: string } {
    switch (p) {
      case 'starting': return { title: 'Opening the line', detail: 'Checking the mic and their voices…' };
      case 'ready': return { title: 'Call paused', detail: 'Tap the center when you are ready to speak.' };
      case 'listening': return { title: 'Listening', detail: 'Speak naturally. Your pause sends the turn.' };
      case 'hearing': return { title: 'I hear you', detail: 'Keep going — silence finishes your turn.' };
      case 'transcribing': return { title: 'Catching your words', detail: 'Turning your voice into the next message…' };
      case 'thinking': return { title: `${who} is with you`, detail: 'Your words are in the thread.' };
      case 'synthesizing': return { title: 'Finding their voices', detail: 'Preparing each voice in order…' };
      case 'speaking': return { title: `${who} is speaking`, detail: 'Tap the center to interrupt and answer.' };
      case 'error': return { title: 'Call paused', detail: errorMsg || 'Something interrupted the call. Tap to try again.' };
    }
  }
  const copy = $derived(copyFor(phase));
  const resolvedDock = $derived(dockPosition || defaultDock());

  // Which roster entry to spotlight when speaking.
  function isSpotlit(id: SpeakerId): boolean {
    return speaking && (speakingId === null || speakingId === id);
  }
</script>

{#if open}
  {#if minimized}
    <!-- Compact dock: call keeps running while the operator browses the app. -->
    <div
      class="voice-dock"
      style="left: {resolvedDock.x}px; top: {resolvedDock.y}px;"
      transition:scale={{ duration: 140, start: 0.9 }}
      onpointerdown={beginDockDrag}
      onpointermove={moveDock}
      onpointerup={endDockDrag}
      onpointercancel={endDockDrag}
      role="group"
      aria-label="Voice call (minimized)"
    >
      <button class="dock-main" onclick={dockTap} aria-label="Return to voice call">
        <span class="dock-avatars" class:muted={phase === 'error' || phase === 'ready'}>
          {#each ROSTER as r}<span class="dock-emoji" class:spotlit={isSpotlit(r.id)}>{r.emoji}</span>{/each}
        </span>
        <span class="dock-bars" class:live={micLive || speaking}>
          {#each [0.5, 0.8, 1, 0.7, 0.55] as w}
            <span class="bar" style="height: {micLive ? 5 + 16 * Math.max(0.2, level) * w : speaking ? 5 + 11 * w : 5}px;"></span>
          {/each}
        </span>
      </button>
      <button class="dock-end" data-dock-control onpointerdown={(e) => e.stopPropagation()} onclick={handleEnd} aria-label="End call">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  {:else}
    <div
      class="voice-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Voice call"
      transition:fade={{ duration: 160 }}
    >
      <div class="glow" style="--accent-glow: var(--accent);"></div>

      <header class="voice-header">
        <div class="header-title">
          <p class="micro-label">Voice call</p>
          <h2 class="thread-name">{threadName || 'Bytelight'}</h2>
        </div>
        <button class="icon-btn" onclick={() => (minimized = true)} aria-label="Minimize call" title="Minimize — the call keeps running">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button class="icon-btn" onclick={handleEnd} aria-label="End call" title="End call">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </header>

      <div class="voice-body">
        <div class="roster">
          {#each ROSTER as r}
            <div class="companion" class:spotlit={isSpotlit(r.id)} class:dim={phase === 'ready'}>
              <span class="companion-emoji">{r.emoji}</span>
              <span class="companion-name">{r.name}</span>
            </div>
          {/each}
        </div>

        <div class="center">
          <button
            class="orb"
            class:live={micLive}
            class:speaking
            class:error={phase === 'error'}
            onclick={handlePrimaryAction}
            disabled={!canPress}
            aria-label={speaking ? 'Interrupt and speak' : micLive ? 'Finish voice turn' : 'Start listening'}
          >
            <span class="orb-ring" style="transform: scale({micLive ? 1.02 + level * 0.16 : 1});"></span>
            <span class="orb-core">
              {#if busy}
                <span class="orb-spinner"></span>
              {:else if phase === 'error'}
                <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              {:else if speaking}
                <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
              {:else if phase === 'ready'}
                <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/></svg>
              {:else}
                <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
              {/if}
            </span>
          </button>

          <div class="copy" aria-live="polite">
            <h3 class="copy-title">{copy.title}</h3>
            <p class="copy-detail">{copy.detail}</p>
          </div>

          {#if lastTranscript}
            <div class="transcript-card" transition:fade={{ duration: 140 }}>
              <p class="micro-label">You said</p>
              <p class="transcript-text">{lastTranscript}</p>
              {#if lastToneStatus === 'unavailable'}
                <p class="transcript-note">Tone reading unavailable · your words still went through normally</p>
              {/if}
            </div>
          {/if}
        </div>

        <div class="controls">
          <div class="control-bar">
            <button
              class="ctrl-mic"
              onclick={() => { if (micLive) { awaitingTranscript = false; cancelVoiceRecording(); clearStoreTranscription(); level = 0; setPhase('ready'); } else if (phase === 'ready' || phase === 'error') void startFromGesture(); }}
              disabled={busy || speaking}
              aria-label={micLive ? 'Pause microphone' : 'Resume microphone'}
            >
              {#if micLive}
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>
              {:else}
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/></svg>
              {/if}
            </button>

            <span class="status-pill" class:err={phase === 'error' || connectionState !== 'connected'}>
              {#if connectionState !== 'connected'}Reconnecting…{:else}{copy.title}{/if}
            </span>

            <button class="ctrl-end" onclick={handleEnd} aria-label="End call">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  {/if}
{/if}

<style>
  .voice-overlay {
    position: fixed;
    inset: 0;
    z-index: 1200;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--bg-primary);
    color: var(--text-primary);
  }

  .glow {
    position: absolute;
    inset: 0;
    pointer-events: none;
    opacity: 0.6;
    background: radial-gradient(circle at 50% 36%, color-mix(in srgb, var(--accent) 22%, transparent), transparent 46%);
  }

  .voice-header {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 1.25rem 1.25rem 0.75rem;
  }
  .header-title { min-width: 0; flex: 1; }
  .micro-label {
    margin: 0;
    font-size: 0.6875rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .thread-name {
    margin: 0.125rem 0 0;
    font-family: var(--font-heading);
    font-size: 1.0625rem;
    font-weight: 600;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .icon-btn {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: 50%;
    color: var(--text-muted);
    transition: color var(--transition), background var(--transition);
  }
  .icon-btn:hover { color: var(--text-primary); background: var(--bg-hover); }

  .voice-body {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    flex: 1;
    min-height: 0;
    padding: 0.5rem 1.25rem 1.5rem;
  }

  .roster {
    display: flex;
    gap: 1.5rem;
    padding-top: 0.5rem;
  }
  .companion {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.375rem;
    opacity: 0.55;
    transition: opacity var(--transition), transform var(--transition);
  }
  .companion.spotlit { opacity: 1; transform: translateY(-3px); }
  .companion.dim { opacity: 0.4; }
  .companion-emoji {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 3.25rem;
    height: 3.25rem;
    font-size: 1.6rem;
    border-radius: 50%;
    background: var(--bg-surface);
    border: 2px solid var(--border);
    transition: border-color var(--transition), box-shadow var(--transition);
  }
  .companion.spotlit .companion-emoji {
    border-color: var(--accent);
    box-shadow: 0 0 28px color-mix(in srgb, var(--accent) 40%, transparent);
  }
  .companion-name {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-secondary);
  }

  .center {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    text-align: center;
    width: 100%;
    padding: 1rem 0;
  }

  .orb {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 8.5rem;
    height: 8.5rem;
    margin-bottom: 1.75rem;
    border-radius: 50%;
    color: #fff;
  }
  .orb:disabled { cursor: default; }
  .orb-ring {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 1px solid var(--accent);
    opacity: 0.25;
    box-shadow: 0 0 42px color-mix(in srgb, var(--accent) 32%, transparent);
    transition: transform 0.12s ease, opacity var(--transition);
  }
  .orb.live .orb-ring { opacity: 0.55; }
  .orb.speaking .orb-ring { opacity: 0.5; animation: orb-pulse 1.4s ease-in-out infinite; }
  .orb.error .orb-ring { border-color: var(--color-danger); box-shadow: 0 0 42px color-mix(in srgb, var(--color-danger) 30%, transparent); }
  .orb-core {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 5.75rem;
    height: 5.75rem;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: var(--shadow-lg);
    transition: background var(--transition);
  }
  .orb.error .orb-core { background: var(--color-danger); }
  .orb:hover:not(:disabled) .orb-core { background: var(--accent-hover); }
  @keyframes orb-pulse {
    0%, 100% { transform: scale(1); opacity: 0.4; }
    50% { transform: scale(1.1); opacity: 0.65; }
  }

  .orb-spinner {
    width: 32px;
    height: 32px;
    border: 3px solid rgba(255, 255, 255, 0.35);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  .copy { min-height: 4.25rem; }
  .copy-title {
    margin: 0;
    font-family: var(--font-heading);
    font-size: 1.25rem;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--text-primary);
  }
  .copy-detail {
    margin: 0.375rem auto 0;
    max-width: 20rem;
    font-size: 0.875rem;
    line-height: 1.5;
    color: var(--text-muted);
  }

  .transcript-card {
    margin-top: 1.25rem;
    width: 100%;
    max-width: 22rem;
    text-align: left;
    padding: 0.75rem 1rem;
    border-radius: var(--radius);
    background: var(--bg-surface);
    border: 1px solid var(--border);
  }
  .transcript-text {
    margin: 0.25rem 0 0;
    font-size: 0.875rem;
    line-height: 1.5;
    color: var(--text-primary);
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .transcript-note {
    margin: 0.5rem 0 0;
    font-size: 0.6875rem;
    line-height: 1.4;
    color: var(--text-muted);
  }

  .controls { width: 100%; max-width: 22rem; }
  .control-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.625rem 0.875rem;
    border-radius: var(--radius);
    background: var(--bg-surface);
    border: 1px solid var(--border);
  }
  .ctrl-mic, .ctrl-end {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.75rem;
    height: 2.75rem;
    border-radius: 50%;
    flex-shrink: 0;
    transition: color var(--transition), background var(--transition), opacity var(--transition);
  }
  .ctrl-mic { color: var(--text-muted); }
  .ctrl-mic:hover:not(:disabled) { color: var(--accent); background: var(--bg-hover); }
  .ctrl-mic:disabled { opacity: 0.35; cursor: default; }
  .ctrl-end { color: #fff; background: var(--color-error); box-shadow: var(--shadow-sm); }
  .ctrl-end:hover { filter: brightness(1.08); }
  .status-pill {
    flex: 1;
    text-align: center;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .status-pill.err { color: var(--color-danger); }

  /* --- Compact dock --- */
  .voice-dock {
    position: fixed;
    z-index: 1200;
    display: flex;
    align-items: center;
    gap: 0.375rem;
    width: 8.25rem;
    height: 3.75rem;
    padding: 0.375rem 0.5rem;
    border-radius: 2rem;
    background: color-mix(in srgb, var(--bg-surface) 92%, transparent);
    border: 1px solid var(--border);
    box-shadow: var(--shadow-lg);
    backdrop-filter: blur(12px);
    touch-action: none;
    user-select: none;
    cursor: grab;
  }
  .voice-dock:active { cursor: grabbing; }
  .dock-main {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex: 1;
    min-width: 0;
    text-align: left;
  }
  .dock-avatars { display: flex; gap: -0.25rem; }
  .dock-avatars.muted { opacity: 0.55; }
  .dock-emoji {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.6rem;
    height: 1.6rem;
    font-size: 0.95rem;
    border-radius: 50%;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    margin-right: -0.375rem;
    transition: box-shadow var(--transition), border-color var(--transition);
  }
  .dock-emoji.spotlit {
    border-color: var(--accent);
    box-shadow: 0 0 12px color-mix(in srgb, var(--accent) 45%, transparent);
  }
  .dock-bars { display: flex; align-items: center; gap: 2px; height: 1.4rem; color: var(--accent); }
  .dock-bars .bar {
    width: 3px;
    border-radius: 2px;
    background: currentColor;
    transition: height 0.12s ease;
  }
  .dock-bars:not(.live) { opacity: 0.4; }
  .dock-end {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 50%;
    flex-shrink: 0;
    color: var(--text-muted);
    background: var(--bg-tertiary);
    transition: color var(--transition), background var(--transition);
  }
  .dock-end:hover { color: #fff; background: var(--color-error); }

  @media (max-width: 480px) {
    .roster { gap: 1.25rem; }
    .companion-emoji { width: 3rem; height: 3rem; font-size: 1.4rem; }
    .orb { width: 7.5rem; height: 7.5rem; }
    .orb-core { width: 5.25rem; height: 5.25rem; }
  }
</style>
