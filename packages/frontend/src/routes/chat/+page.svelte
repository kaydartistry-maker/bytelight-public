<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { base } from '$app/paths';
  import MessageBubble from '$lib/components/MessageBubble.svelte';
  import MessageInput from '$lib/components/MessageInput.svelte';
  import ThreadList from '$lib/components/ThreadList.svelte';
  import PresenceIndicator from '$lib/components/PresenceIndicator.svelte';
  import ConnectionStatus from '$lib/components/ConnectionStatus.svelte';
  import AudioAutoPlayer from '$lib/components/AudioAutoPlayer.svelte';
  import ContextIndicator from '$lib/components/ContextIndicator.svelte';
  import ModelSelector from '$lib/components/ModelSelector.svelte';
  import Canvas from '$lib/components/Canvas.svelte';
  import CanvasList from '$lib/components/CanvasList.svelte';
  import SearchPanel from '$lib/components/SearchPanel.svelte';
  import StarredDrawer from '$lib/components/StarredDrawer.svelte';
  import StudioDrawer from '$lib/components/StudioDrawer.svelte';
  import VoiceCallOverlay from '$lib/components/VoiceCallOverlay.svelte';
  import { loadMyStars } from '$lib/stores/stars.svelte';
  import { loadProfiles } from '$lib/stores/profiles.svelte';
  import CompanionChip from '$lib/components/CompanionChip.svelte';
  import RosterEditor from '$lib/components/RosterEditor.svelte';
  import {
    loadCompanions,
    allCompanions,
    getThreadRoster,
    type Companion,
  } from '$lib/stores/companions.svelte';
  import {
    connect,
    send,
    loadThread,
    loadThreadAround,
    loadThreads,
    loadOlderMessages,
    setPendingJump,
    getPendingJump,
    getConnectionState,
    getReconnectScheduled,
    getMessages,
    getThreads,
    getActiveThreadId,
    getRoutingThreadId,
    getPresence,
    getUnreadCounts,
    getStreamingState,
    getLastError,
    getPendingCount,
    getToolEvents,
    getContextUsage,
    getCompactionNotice,
    getActiveCanvasId,
    setActiveCanvasId,
    getStreamingSegments,
    sendStopGeneration,
    isStreaming,
    getRateLimitInfo,
    getLastCommandResult,
    clearCommandResult,
    getLastTokenAt,
  } from '$lib/stores/websocket.svelte';
  import { goto } from '$app/navigation';
  import { loadSettings, getCompanionName } from '$lib/stores/settings.svelte';
  import { initTheme, getMode, setMode } from '$lib/stores/theme.svelte';
  import { apiFetch } from '$lib/utils/api';
  import type { Message } from '@bytelight/shared';

  // Reactive state from stores
  let connectionState = $derived(getConnectionState());
  let reconnectScheduled = $derived(getReconnectScheduled());
  let messages = $derived(getMessages());
  let threads = $derived(getThreads());
  let activeThreadId = $derived(getActiveThreadId());

  // Live voice call — hands-free conversation surface (reference implementation port). Mounted
  // at the page level so it can minimize into a floating dock and keep running
  // while the operator browses. The composer's call button flips `voiceCallOpen`.
  let voiceCallOpen = $state(false);
  let activeThreadName = $derived(threads.find(t => t.id === activeThreadId)?.name ?? '');
  let routingThreadId = $derived(getRoutingThreadId());
  let presence = $derived(getPresence());
  let unreadCounts = $derived(getUnreadCounts());
  let streaming = $derived(getStreamingState());
  let lastError = $derived(getLastError());
  let pendingCount = $derived(getPendingCount());
  let toolEventsMap = $derived(getToolEvents());
  let contextUsage = $derived(getContextUsage());
  let compactionNotice = $derived(getCompactionNotice());
  let activeCanvasId = $derived(getActiveCanvasId());
  let streamingSegments = $derived(getStreamingSegments());
  let isStreamingNow = $derived(isStreaming());
  let rateLimitInfo = $derived(getRateLimitInfo());
  let companionName = $derived(getCompanionName());
  let commandResult = $derived(getLastCommandResult());

  // --- Date dividers (WhatsApp-style "Today · May 12" tags between days) ---
  function startOfDay(d: Date): number {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
  function isSameLocalDay(a: string, b: string): boolean {
    return startOfDay(new Date(a)) === startOfDay(new Date(b));
  }
  function dateDividerLabel(iso: string): string {
    const d = new Date(iso);
    const now = new Date();
    const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
    const opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
    if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
    const dateStr = d.toLocaleDateString(undefined, opts);
    if (diffDays === 0) return `Today · ${dateStr}`;
    if (diffDays === 1) return `Yesterday · ${dateStr}`;
    return dateStr;
  }

  // Canvas state
  let canvasDropdownOpen = $state(false);

  function toggleCanvasDropdown() {
    canvasDropdownOpen = !canvasDropdownOpen;
  }

  function handleOpenCanvas(e: CustomEvent<string>) {
    setActiveCanvasId(e.detail);
  }

  // Search state
  let searchOpen = $state(false);
  let starredOpen = $state(false);
  let studioOpen = $state(false);

  // Component refs
  let messageInput: MessageInput | undefined = $state();


  function toggleSearch() {
    searchOpen = !searchOpen;
  }

  // Honor the OS "reduce motion" setting: instant scroll + no flash animation.
  function prefersReducedMotion(): boolean {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // Scroll a specific message into view and flash a highlight ring. Used by
  // search-result jumps. The bubble wrapper is rendered with id="msg-{id}".
  // Retries a few times if the element isn't in the DOM yet (the messages list
  // may still be rendering after loadThreadAround replaced the slice).
  function scrollToMessageId(messageId: string, retries = 5) {
    const el = messagesContainer?.querySelector<HTMLElement>(`#msg-${CSS.escape(messageId)}`)
      ?? document.getElementById(`msg-${messageId}`);
    if (!el) {
      if (retries > 0) setTimeout(() => scrollToMessageId(messageId, retries - 1), 100);
      return;
    }
    const reduced = prefersReducedMotion();
    el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
    if (!reduced) {
      el.classList.add('highlight-flash');
      setTimeout(() => el.classList.remove('highlight-flash'), 2000);
    }
  }

  async function handleSearchResult(result: { messageId: string; threadId: string }) {
    searchOpen = false;

    // Hold the auto-scroll guard for the whole jump so the effect at the bottom
    // of this file (and the paginating scroll handler) don't yank the view away
    // before we land on the target. ALWAYS released via a guaranteed timeout
    // below — even if the target never renders — so the guard can't get stuck.
    setPendingJump(result.messageId);
    const release = () => setPendingJump(null);
    // The jump target may sit above the render window — reveal the full
    // loaded store so its msg-{id} node exists for scrollToMessageId. The
    // trim effect re-engages once the operator returns to the bottom.
    renderStart = 0;

    // Already loaded in the active thread → just scroll, keep the guard up
    // briefly so other scroll effects don't override us.
    const alreadyLoaded = result.threadId === activeThreadId
      && messages.some(m => m.id === result.messageId);
    if (alreadyLoaded) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => scrollToMessageId(result.messageId));
      });
      setTimeout(release, 1500);
      return;
    }

    try {
      // Load a window centered on the target (switches thread if needed),
      // rather than the tail — so a hit older than the loaded 50 is present.
      await loadThreadAround(result.threadId, result.messageId);
      sidebarOpen = false;
      // Two paints so the bubbles have mounted with their msg-{id} ids, then
      // scroll onto the target.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => scrollToMessageId(result.messageId));
      });
    } finally {
      // Guaranteed release — outlasts the retry ladder in scrollToMessageId
      // (5 × 100ms) so the guard is up long enough to win the race, then always
      // clears so normal auto-scroll on new messages resumes.
      setTimeout(release, 1500);
    }
  }

  // Focus a starred message in its thread (reuses the search-result focus flow).
  async function focusStarredMessage(threadId: string, messageId: string) {
    await handleSearchResult({ messageId, threadId });
  }

  // Theme toggle
  function toggleTheme() {
    setMode(getMode() === 'dark' ? 'light' : 'dark');
  }

  // Local state
  let replyTo = $state<Message | null>(null);
  let messagesContainer: HTMLDivElement;
  let messagesEndEl: HTMLDivElement;
  let shouldAutoScroll = $state(true);
  let sidebarOpen = $state(false); // mobile overlay
  let sidebarCollapsed = $state(false); // desktop collapse
  let readObserver: IntersectionObserver | null = null;
  let loadingOlder = $state(false);
  let hasMoreMessages = $state(true);

  // DOM render window — the store keeps every loaded message (search, jumps,
  // and pagination all read it); only the newest slice becomes live DOM
  // nodes. Without this, an all-day thread accumulates every message as a
  // permanent node and deep scroll-back grows the DOM without bound — the
  // browser-lag source. Scrolling up reveals already-loaded history in steps
  // BEFORE any network pagination; returning to the bottom re-trims and
  // releases the nodes.
  const RENDER_WINDOW = 150;
  const RENDER_EXPAND_STEP = 100;
  let renderStart = $state(0);
  let revealingOlder = false; // scroll-event guard while an expansion settles
  const renderedMessages = $derived(messages.slice(renderStart));

  // Reveal an older chunk of ALREADY-LOADED history (no network), preserving
  // the scroll anchor the same way loadMoreMessages does.
  function revealOlderRendered() {
    if (!messagesContainer || revealingOlder) return;
    revealingOlder = true;
    const prevHeight = messagesContainer.scrollHeight;
    const prevTop = messagesContainer.scrollTop;
    renderStart = Math.max(0, renderStart - RENDER_EXPAND_STEP);
    setTimeout(() => {
      if (messagesContainer) {
        messagesContainer.scrollTop = prevTop + (messagesContainer.scrollHeight - prevHeight);
      }
      revealingOlder = false;
    }, 0);
  }

  // Total unread count
  const totalUnread = $derived(
    Object.values(unreadCounts).reduce((sum, count) => sum + count, 0)
  );

  // Handle thread selection
  async function handleThreadSelect(threadId: string) {
    hasMoreMessages = true;
    await loadThread(threadId);
    sidebarOpen = false;
    shouldAutoScroll = true;
  }

  // New thread modal state
  let newThreadOpen = $state(false);
  let newThreadName = $state('');
  let creatingThread = $state(false);
  // Roster picker: which companion ids are seated in the thread being created.
  // Defaults to the resident pair (zero-tap everyday case). The backend default
  // seating (createThread) is the real source of truth for non-picker paths;
  // this just mirrors it so the picker opens pre-seated.
  const DEFAULT_SEATED = ['companion-a', 'companion-b'];
  let newThreadSeated = $state<string[]>([...DEFAULT_SEATED]);

  function handleNewThread() {
    newThreadName = '';
    newThreadSeated = [...DEFAULT_SEATED];
    newThreadOpen = true;
  }

  function toggleSeat(id: string) {
    newThreadSeated = newThreadSeated.includes(id)
      ? newThreadSeated.filter((x) => x !== id)
      : [...newThreadSeated, id];
  }

  function closeNewThreadModal() {
    if (creatingThread) return;
    newThreadOpen = false;
    newThreadName = '';
  }

  async function submitNewThread() {
    if (creatingThread) return;
    creatingThread = true;
    try {
      const name = newThreadName.trim() || undefined;
      // Only send companionIds when the picker diverges from the backend
      // default — keeps the everyday case identical to today's behaviour and
      // lets the single default-seating point (createThread) own it.
      const seated = newThreadSeated;
      const isDefault =
        seated.length === DEFAULT_SEATED.length &&
        DEFAULT_SEATED.every((d) => seated.includes(d));
      const body: Record<string, unknown> = { name };
      if (!isDefault && seated.length > 0) body.companionIds = seated;

      const response = await apiFetch('/api/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error('Failed to create thread');
      const data = await response.json();
      await loadThreads();
      newThreadOpen = false;
      newThreadName = '';
      await handleThreadSelect(data.thread.id);
    } catch (err) {
      console.error('Failed to create thread:', err);
    } finally {
      creatingThread = false;
    }
  }

  // ── Thread-header roster ────────────────────────────────────────────────
  // Who's seated in the open thread. Loaded on thread switch; shown as chips in
  // the header; tapping opens the RosterEditor (PUT roster from Slice 2).
  let headerRoster = $state<Companion[]>([]);
  let rosterEditorOpen = $state(false);

  async function refreshHeaderRoster(threadId: string | null) {
    if (!threadId) {
      headerRoster = [];
      return;
    }
    headerRoster = await getThreadRoster(threadId);
  }

  // Reload the header roster whenever the active thread changes.
  $effect(() => {
    const id = activeThreadId;
    refreshHeaderRoster(id);
  });

  function onRosterSaved(roster: Companion[]) {
    headerRoster = roster;
    rosterEditorOpen = false;
  }

  // Handle batched send — text and/or files all go as one message → one agent query
  async function handleBatchSend(
    content: string,
    files: Array<{ fileId: string; filename: string; mimeType: string; size: number; contentType: 'image' | 'audio' | 'file'; url: string }>,
    prosody?: Record<string, number>
  ) {
    let threadId = activeThreadId;
    if (!threadId) {
      // Empty-state send: byte-light's design is daily-thread routing
      // (see memory/product_decisions.md). If today's daily already
      // exists, switch to it for visual consistency. Otherwise, send
      // with undefined threadId — backend's handleMessageSend routes
      // to/creates today's daily automatically.
      const todayName = new Date().toLocaleDateString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'short',
      });
      const todayDaily = threads.find(t => t.type === 'daily' && t.name === todayName);
      if (todayDaily) {
        threadId = todayDaily.id;
        await loadThread(todayDaily.id);
      }
      // If no daily exists yet, threadId stays undefined and backend creates it.
    }

    if (files.length === 0) {
      // Text only
      send({
        type: 'message',
        // threadId may be null in the empty-state path — backend's
        // handleMessageSend routes a missing threadId to/creates today's
        // daily. The protocol types threadId as required string, so assert
        // the documented nullable-at-runtime shape here.
        threadId: threadId as string,
        content,
        contentType: 'text',
        replyToId: replyTo?.id,
        ...(prosody && { metadata: { prosody } }),
      });
    } else {
      // Files (+ optional text) — single message, backend stores files individually
      // and fires one combined agent query
      send({
        type: 'message',
        // See note above — threadId is nullable at runtime in empty-state.
        threadId: threadId as string,
        content: content || '',
        contentType: 'text',
        replyToId: replyTo?.id,
        metadata: {
          attachments: files.map(f => ({
            fileId: f.fileId,
            filename: f.filename,
            mimeType: f.mimeType,
            size: f.size,
            url: f.url,
            contentType: f.contentType,
          })),
          ...(prosody && { prosody }),
        },
      });
    }

    replyTo = null;
    shouldAutoScroll = true;
  }

  // Handle reply
  function handleReply(message: Message) {
    replyTo = message;
  }

  // Cancel reply
  function handleCancelReply() {
    replyTo = null;
  }

  // Send a suggested prompt — empty-state routes via backend daily routing
  async function sendSuggested(text: string) {
    let threadId = activeThreadId;
    if (!threadId) {
      // Empty-state send: byte-light's design is daily-thread routing
      // (see memory/product_decisions.md). If today's daily already
      // exists, switch to it for visual consistency. Otherwise, send
      // with undefined threadId — backend's handleMessageSend routes
      // to/creates today's daily automatically.
      const todayName = new Date().toLocaleDateString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'short',
      });
      const todayDaily = threads.find(t => t.type === 'daily' && t.name === todayName);
      if (todayDaily) {
        threadId = todayDaily.id;
        await loadThread(todayDaily.id);
      }
    }
    send({
      type: 'message',
      // See note above — threadId is nullable at runtime in empty-state.
      threadId: threadId as string,
      content: text,
      contentType: 'text',
    });
    shouldAutoScroll = true;
  }

  // Check if should auto-scroll + load older messages on scroll to top
  function checkAutoScroll() {
    if (!messagesContainer) return;

    const { scrollTop, scrollHeight, clientHeight } = messagesContainer;
    const threshold = 100; // pixels from bottom

    shouldAutoScroll = scrollHeight - scrollTop - clientHeight < threshold;

    // Load older messages when scrolled near top — but not while a search-jump
    // is landing: scrollIntoView({block:'center'}) can transiently sit near the
    // top and would otherwise trigger a prepend that reflows the window out
    // from under the target we're trying to land on.
    if (getPendingJump()) return;
    if (scrollTop < 100 && !loadingOlder && activeThreadId && messages.length > 0) {
      // Already-loaded history first (pure DOM reveal, no network); only when
      // the render window has reached the front of the store does the backend
      // pagination fetch another page.
      if (renderStart > 0) {
        revealOlderRendered();
      } else if (hasMoreMessages) {
        loadMoreMessages();
      }
    }
  }

  // Load older messages and preserve scroll position
  async function loadMoreMessages() {
    if (!activeThreadId || loadingOlder || !hasMoreMessages) return;
    loadingOlder = true;

    const prevHeight = messagesContainer?.scrollHeight ?? 0;

    const hasMore = await loadOlderMessages(activeThreadId);
    hasMoreMessages = hasMore;

    // Preserve scroll position after prepending
    await new Promise(r => setTimeout(r, 0));
    if (messagesContainer) {
      const newHeight = messagesContainer.scrollHeight;
      messagesContainer.scrollTop = newHeight - prevHeight;
    }

    loadingOlder = false;
  }

  // Auto-scroll to bottom
  function scrollToBottom() {
    if (!messagesContainer || !shouldAutoScroll) return;

    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  // Manual scroll to bottom (ignores shouldAutoScroll flag)
  function jumpToBottom() {
    if (!messagesContainer) return;
    shouldAutoScroll = true;
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  // Toggle sidebar on mobile
  function toggleSidebar() {
    sidebarOpen = !sidebarOpen;
  }

  // Mark messages as read when bottom of chat is visible
  function setupReadObserver() {
    if (readObserver) readObserver.disconnect();
    readObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && activeThreadId && messages.length > 0) {
          const lastMsg = messages[messages.length - 1];
          if (lastMsg.role === 'companion' && !lastMsg.read_at) {
            send({ type: 'read', threadId: activeThreadId, beforeId: lastMsg.id });
          }
        }
      }
    }, { threshold: 0.1 });

    if (messagesEndEl) readObserver.observe(messagesEndEl);
  }

  // Keyboard shortcuts
  function handleGlobalKeydown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      searchOpen = !searchOpen;
    }
    if (e.key === 'Escape') {
      if (newThreadOpen) { e.preventDefault(); closeNewThreadModal(); return; }
      if (sidebarOpen) { e.preventDefault(); sidebarOpen = false; return; }
      if (searchOpen) { e.preventDefault(); searchOpen = false; return; }
      if (isStreamingNow) { e.preventDefault(); sendStopGeneration(); }
    }
  }

  // Load initial data and connect
  onMount(async () => {
    initTheme();
    // The socket needs only the session cookie — not threads or settings. Open it
    // immediately so a slow/stalled initial data fetch can never delay (or, with a
    // hung fetch, indefinitely block) the live connection coming up.
    connect();
    await Promise.all([loadThreads(), loadSettings()]);
    loadMyStars();
    loadProfiles(); // speaker avatars/names for per-companion bubbles (fire-and-forget)
    loadCompanions(); // pickable roster registry for the picker + header (fire-and-forget)
    apiFetch('/api/preferences', { credentials: 'include' })
      .then(r => r.json())
      .then(p => {
        if (p?.identity?.companion_name) {
          localStorage.setItem('bytelight-companion-name', p.identity.companion_name);
        }
      })
      .catch(() => {});
    window.addEventListener('keydown', handleGlobalKeydown);
    window.addEventListener('open-canvas', handleOpenCanvas as EventListener);

    // Load today's thread if available
    const todayThread = threads.find(t =>
      t.name.startsWith('Daily -') && t.name.includes(new Date().toISOString().split('T')[0])
    );

    if (todayThread) {
      await handleThreadSelect(todayThread.id);
    } else if (threads.length > 0) {
      await handleThreadSelect(threads[0].id);
    }

    setupReadObserver();
  });

  // Cleanup on unmount (keep socket alive across route changes)
  onDestroy(() => {
    readObserver?.disconnect();
    window.removeEventListener('keydown', handleGlobalKeydown);
    window.removeEventListener('open-canvas', handleOpenCanvas as EventListener);
  });

  // Auto-scroll effect
  $effect(() => {
    messages; // Track changes
    streaming; // Track streaming changes
    // While a search-jump is in flight, do NOT yank the view to the bottom —
    // the jump loads a window centered on the target and scrollToMessageId
    // will place it. Releasing the guard (a guaranteed timeout in
    // handleSearchResult) lets normal auto-scroll resume.
    if (getPendingJump()) return;
    setTimeout(scrollToBottom, 50);
  });

  // Render-window trim: while pinned at the bottom, keep only the newest
  // RENDER_WINDOW messages as DOM nodes. Runs on new messages AND when the
  // user returns to the bottom (shouldAutoScroll flips true), which is the
  // moment deep-scroll nodes get released. Never trims mid-read (scrolled up)
  // or while a search-jump is landing — hiding the jump target or yanking
  // history out from under a reading operator is the failure mode this guard
  // exists for.
  $effect(() => {
    const len = messages.length;
    if (renderStart > len) { renderStart = Math.max(0, len - RENDER_WINDOW); return; } // thread switched to a shorter history
    if (getPendingJump()) return;
    if (!shouldAutoScroll) return;
    const target = Math.max(0, len - RENDER_WINDOW);
    if (target > renderStart) renderStart = target;
  });

  // Tail-work detection: reply text landed but stream still open (memory writes, tool tail)
  let now = $state(Date.now());
  $effect(() => {
    if (streaming.messageId && streaming.tokens) {
      const interval = setInterval(() => { now = Date.now(); }, 1000);
      return () => clearInterval(interval);
    }
  });
  let tailWorking = $derived.by(() => {
    const last = getLastTokenAt();
    return Boolean(streaming.tokens && last != null && now - last > 2500);
  });
</script>

<div class="chat-page">
  <!-- Sidebar overlay on mobile -->
  {#if sidebarOpen}
    <button class="sidebar-overlay" onclick={toggleSidebar} aria-label="Close sidebar"></button>
  {/if}

  <!-- Sidebar -->
  <div class="sidebar" class:open={sidebarOpen} class:collapsed={sidebarCollapsed}>
    <ThreadList
      threads={threads}
      activeThreadId={activeThreadId}
      routingThreadId={routingThreadId}
      onselect={handleThreadSelect}
      oncreate={handleNewThread}
      loadThreads={loadThreads}
    />
  </div>

  <!-- Main chat area -->
  <div class="main-content">
    <!-- Header -->
    <header class="chat-header">
      <div class="header-top">
        <button class="menu-button" onclick={toggleSidebar} aria-label="Toggle sidebar">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 12h18M3 6h18M3 18h18"/>
          </svg>
        </button>
        <button class="sidebar-toggle" onclick={() => sidebarCollapsed = !sidebarCollapsed} aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'} title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            {#if sidebarCollapsed}
              <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/>
            {:else}
              <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><path d="M15 9l-3 3 3 3"/>
            {/if}
          </svg>
        </button>

        <div class="header-info">
          <h1 class="header-title">{companionName}</h1>
          <PresenceIndicator status={presence} />
          <ModelSelector />
        </div>
      </div>

      <!-- Row 2: roster faces on the left, nav-icon rail on the right. On mobile
           the icon rail scrolls horizontally (≈4 icons visible, swipe for more,
           matched to the Settings page-selector rail: overflow-x auto +
           hidden scrollbar). On desktop the row sits inline in the header and,
           with room, shows every icon without scrolling. -->
      <div class="header-bar">
        {#if activeThreadId && headerRoster.length > 0}
          <div class="header-roster-wrapper">
            <button
              class="header-roster"
              onclick={() => rosterEditorOpen = !rosterEditorOpen}
              aria-label="Edit who's in this thread"
              aria-expanded={rosterEditorOpen}
              title="Who's in this thread"
            >
              {#each headerRoster as c (c.id)}
                <CompanionChip companion={c} size="sm" showName={false} interactive={false} />
              {/each}
            </button>
            {#if rosterEditorOpen}
              <RosterEditor
                threadId={activeThreadId}
                seated={headerRoster}
                onsaved={onRosterSaved}
                onclose={() => rosterEditorOpen = false}
              />
            {/if}
          </div>
        {/if}

      <div class="header-actions">
        <a href="{base}/cc" class="header-icon-btn" aria-label="Command Center" title="Command Center">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0h4"/>
          </svg>
        </a>
        <button class="header-icon-btn" onclick={toggleSearch} aria-label="Search messages (Ctrl+K)" title="Search (Ctrl+K)">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
          </svg>
        </button>
        <button class="header-icon-btn" class:active={starredOpen} onclick={() => starredOpen = !starredOpen} aria-label="Starred messages" title="Starred">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
        </button>
        <button class="header-icon-btn" class:active={studioOpen} onclick={() => studioOpen = !studioOpen} aria-label="Studio" title="Studio">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>
          </svg>
        </button>
        {#if contextUsage}
          <ContextIndicator
            percentage={contextUsage.percentage}
            tokensUsed={contextUsage.tokensUsed}
            contextWindow={contextUsage.contextWindow}
          />
        {/if}
        {#if totalUnread > 0}
          <div class="unread-badge">{totalUnread}</div>
        {/if}
        <div class="canvas-trigger-wrapper">
          <button
            class="header-icon-btn"
            class:active={activeCanvasId !== null || canvasDropdownOpen}
            onclick={toggleCanvasDropdown}
            aria-label="Canvases"
            title="Canvases"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
              <line x1="3" y1="9" x2="21" y2="9"/>
              <line x1="9" y1="21" x2="9" y2="9"/>
            </svg>
          </button>
          {#if canvasDropdownOpen}
            <CanvasList onclose={() => canvasDropdownOpen = false} />
          {/if}
        </div>
        <a href="{base}/files" class="header-icon-link" aria-label="Files">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
        </a>
        <button class="header-icon-btn" onclick={toggleTheme} aria-label="Toggle light/dark mode" title="Toggle theme">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
          </svg>
        </button>
        <button class="settings-link" onclick={() => goto(`${base}/settings`)} aria-label="Settings">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/>
          </svg>
        </button>
      </div>
      </div>
    </header>

    <!-- Connection status -->
    <ConnectionStatus state={connectionState} error={lastError} pendingCount={pendingCount} reconnectScheduled={reconnectScheduled} onReconnect={connect} />

    <!-- Compaction notice banner -->
    {#if compactionNotice}
      <div class="compaction-banner" class:compacting={!compactionNotice.isComplete}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 2v10l4 4"/>
          <circle cx="12" cy="12" r="10"/>
        </svg>
        <span>{compactionNotice.message}</span>
      </div>
    {/if}

    <!-- Rate limit banner -->
    {#if rateLimitInfo}
      <div class="rate-limit-banner">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        <span>Rate limited ({rateLimitInfo.status}) — waiting for reset...</span>
      </div>
    {/if}

    <!-- Messages area -->
    <div
      class="messages-container"
      bind:this={messagesContainer}
      onscroll={checkAutoScroll}
    >
      <div class="messages-list">
        {#if loadingOlder}
          <div class="loading-older">Loading older messages...</div>
        {:else if !hasMoreMessages && messages.length > 0}
          <div class="thread-start">Beginning of conversation</div>
        {/if}
        {#if messages.length === 0}
          <div class="empty-state">
            <div class="empty-icon">&#128172;</div>
            <h3 class="empty-title">Start a conversation</h3>
            <p class="empty-subtitle">Say hello, ask a question, or try one of these:</p>
            <div class="suggested-prompts">
              <button class="prompt-chip" onclick={() => sendSuggested('How are you today?')}>
                How are you today?
              </button>
              <button class="prompt-chip" onclick={() => sendSuggested('Tell me something interesting')}>
                Tell me something interesting
              </button>
              <button class="prompt-chip" onclick={() => sendSuggested('What can you help me with?')}>
                What can you help me with?
              </button>
            </div>
          </div>
        {:else}
          {#each renderedMessages as message, i (message.id)}
            {#if renderStart + i === 0 || !isSameLocalDay(messages[renderStart + i - 1].created_at, message.created_at)}
              <div class="date-divider"><span class="date-divider-label">{dateDividerLabel(message.created_at)}</span></div>
            {/if}
            <div
              id="msg-{message.id}"
              class="message-wrapper"
              oncontextmenu={(e) => { if (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches) return; e.preventDefault(); handleReply(message); }}
            >
              <MessageBubble message={message} toolEvents={toolEventsMap[message.id] || []} segments={message.metadata?.segments as any || null} />
            </div>
          {/each}

          {#if streaming.messageId && streaming.threadId === activeThreadId}
            {@const liveTools = toolEventsMap[streaming.messageId] || []}
            <div class="message-wrapper" class:tail-working={tailWorking}>
              {#if streaming.tokens}
                <MessageBubble
                  message={{
                    id: streaming.messageId,
                    thread_id: activeThreadId ?? '',
                    sequence: 0,
                    role: 'companion',
                    content: streaming.tokens,
                    content_type: 'text',
                    platform: 'web',
                    metadata: null,
                    companion_id: null,
                    reply_to_id: null,
                    reply_to_preview: null,
                    edited_at: null,
                    deleted_at: null,
                    original_content: null,
                    created_at: new Date().toISOString(),
                    delivered_at: null,
                    read_at: null,
                    client_id: null,
                  }}
                  isStreaming={true}
                  streamTokens={streaming.tokens}
                  toolEvents={liveTools}
                  segments={streamingSegments}
                />
                {#if tailWorking}
                  <div class="tail-working-strip" aria-label="Reply landed, finishing background work">
                    <span class="typing-dot"></span>
                    <span class="typing-dot"></span>
                    <span class="typing-dot"></span>
                    <span class="tail-working-label">tidying up…</span>
                  </div>
                {/if}
              {:else}
                <!-- Live activity panel while companion is working -->
                <div class="activity-panel" aria-label="Working">
                  <div class="activity-header">
                    <span class="typing-dot"></span>
                    <span class="typing-dot"></span>
                    <span class="typing-dot"></span>
                    <span class="activity-label">Thinking...</span>
                  </div>
                  {#if liveTools.length > 0}
                    <div class="activity-tools">
                      {#each liveTools as tool}
                        <div class="activity-tool" class:complete={tool.isComplete} class:error={tool.isError}>
                          <span class="tool-status">{tool.isComplete ? (tool.isError ? '!' : '') : ''}</span>
                          <span class="tool-name">{tool.toolName}</span>
                          {#if tool.input}
                            <span class="tool-input">{tool.input}</span>
                          {/if}
                          {#if tool.elapsed}
                            <span class="tool-elapsed">{tool.elapsed.toFixed(1)}s</span>
                          {/if}
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/if}
            </div>
          {/if}
        {/if}

        <!-- Sentinel for read receipt IntersectionObserver -->
        <div bind:this={messagesEndEl} class="messages-end-sentinel"></div>
      </div>
    </div>

    <!-- Scroll to bottom button -->
    {#if !shouldAutoScroll}
      <div class="scroll-to-bottom-wrapper">
        <button class="scroll-to-bottom" onclick={jumpToBottom} aria-label="Scroll to bottom">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M7 13l5 5 5-5M7 6l5 5 5-5"/>
          </svg>
        </button>
      </div>
    {/if}

    <!-- Input area -->
    <MessageInput
      bind:this={messageInput}
      replyTo={replyTo}
      isStreaming={isStreamingNow}
      activeThreadId={activeThreadId}
      onbatchsend={handleBatchSend}
      oncancelreply={handleCancelReply}
      onstop={sendStopGeneration}
      oncall={() => (voiceCallOpen = true)}
    />

    <!-- Invisible TTS playback manager -->
    <AudioAutoPlayer />
  </div>

  <!-- Canvas panel -->
  {#if activeCanvasId}
    <Canvas onreference={(canvasId, title) => {
      messageInput?.attachCanvasRef(canvasId, title);
    }} />
  {/if}

  <!-- Search overlay -->
  {#if searchOpen}
    <SearchPanel onresult={handleSearchResult} onclose={() => searchOpen = false} />
  {/if}

  <!-- Starred messages drawer -->
  <StarredDrawer bind:open={starredOpen} onopen={focusStarredMessage} />

  <!-- Live voice call surface (hands-free loop, dual-voice playback, dock) -->
  <VoiceCallOverlay
    open={voiceCallOpen}
    threadId={activeThreadId}
    threadName={activeThreadName}
    onclose={() => (voiceCallOpen = false)}
  />

  <!-- Studio drawer (image gen settings / references / gallery / stickers) -->
  <StudioDrawer bind:open={studioOpen} onopen={focusStarredMessage} />

  <!-- New thread modal -->
  {#if newThreadOpen}
    <div class="modal-backdrop" role="presentation">
      <button class="modal-backdrop-btn" onclick={closeNewThreadModal} aria-hidden="true" tabindex="-1"></button>
      <div class="thread-modal" role="dialog" aria-modal="true" aria-label="New thread">
        <div class="thread-modal-header">
          <div>
            <span class="thread-modal-eyebrow">New thread</span>
            <h2 class="thread-modal-title">Start a conversation</h2>
          </div>
          <button class="thread-modal-close" onclick={closeNewThreadModal} aria-label="Close" disabled={creatingThread}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <input
          class="thread-modal-input"
          type="text"
          placeholder="Leave blank for today's daily thread"
          bind:value={newThreadName}
          onkeydown={(e) => { if (e.key === 'Enter') submitNewThread(); }}
          disabled={creatingThread}
        />
        {#if allCompanions().length > 0}
          <div class="thread-modal-roster">
            <span class="thread-modal-roster-label">Who's in this thread</span>
            <div class="thread-modal-chips">
              {#each allCompanions() as c (c.id)}
                <CompanionChip
                  companion={c}
                  interactive
                  selected={newThreadSeated.includes(c.id)}
                  onclick={() => toggleSeat(c.id)}
                />
              {/each}
            </div>
          </div>
        {/if}
        <div class="thread-modal-actions">
          <button class="res-btn res-btn--ghost" onclick={closeNewThreadModal} disabled={creatingThread}>Cancel</button>
          <button class="res-btn res-btn--primary" onclick={submitNewThread} disabled={creatingThread}>
            {creatingThread ? 'Creating...' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .chat-page {
    display: flex;
    height: 100%;
    overflow: hidden;
    max-width: 100vw;
  }

  .sidebar-overlay {
    display: none;
  }

  .sidebar {
    width: var(--sidebar-width);
    height: 100%;
    flex-shrink: 0;
    background: var(--bg-primary);
    border-right: 1px solid var(--border);
    transition: width var(--transition-slow), opacity var(--transition);
    overflow: hidden;
  }

  .sidebar.collapsed {
    width: 0;
    border-right: none;
    opacity: 0;
    pointer-events: none;
  }

  .sidebar-toggle {
    display: none;
    padding: 0.375rem;
    color: var(--text-muted);
    border-radius: var(--radius-sm);
    transition: color var(--transition-fast), background var(--transition-fast);
  }

  .sidebar-toggle:hover {
    color: var(--text-secondary);
    background: var(--bg-hover);
  }

  @media (min-width: 769px) {
    .sidebar-toggle {
      display: flex;
      align-items: center;
      justify-content: center;
    }
  }

  .main-content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    height: 100%;
    position: relative;
    overflow-x: hidden;
  }

  .chat-header {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: calc(env(safe-area-inset-top, 0px) + 1rem) 1.25rem 1rem;
    background: var(--bg-secondary);
    border-bottom: none;
    box-shadow: 0 1px 0 0 var(--border);
    flex-shrink: 0;
  }

  .header-top {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex: 1;
    min-width: 0;
  }

  .menu-button {
    display: none;
    padding: 0.5rem;
    color: var(--text-muted);
    transition: color var(--transition);
  }

  .menu-button:hover {
    color: var(--gold-dim);
  }

  .header-info {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex: 1;
    min-width: 0;
  }

  .header-title {
    font-family: var(--font-heading);
    font-size: 1.25rem;
    font-weight: 400;
    color: var(--gold);
    letter-spacing: 0.06em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  /* Row 2 bar: roster (left) + nav-icon rail (right). Desktop: sits inline on
     the right of the header; the actions keep their normal wrapping-free row.
     Mobile: becomes a full-width line with the roster pinned left and the icon
     rail scrolling horizontally to its right. */
  .header-bar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-width: 0;
  }

  /* Thread-header roster — small overlapping face chips, tap to edit. The
     wrapper is the popover anchor (RosterEditor positions absolute to it). */
  .header-roster-wrapper {
    position: relative;
    flex-shrink: 0;
  }
  .header-roster {
    display: inline-flex;
    align-items: center;
    padding: 0.15rem 0.25rem;
    border-radius: 999px;
    border: 1px solid transparent;
    background: transparent;
    cursor: pointer;
    transition: all var(--transition);
  }
  .header-roster:hover {
    border-color: var(--border);
    background: var(--bg-tertiary);
  }
  /* Overlap the face chips into a stack so a full roster stays compact. The
     chip wrapper sheds its own chrome (border/padding) so the pink accent ring
     on the inner .avatar-ring is the visible ring — same weight as the picker/
     editor chips ("the GOOD one"), instead of the old washed-out separator. */
  .header-roster :global(.companion-chip) {
    padding: 0;
    border: none;
    background: transparent;
    margin-left: -0.4rem;
  }
  .header-roster :global(.companion-chip:first-child) {
    margin-left: 0;
  }
  /* A thin bg-coloured gap ring on the avatar ring keeps overlapping faces from
     merging, sitting OUTSIDE the pink ring so the accent stays the dominant
     colour. */
  .header-roster :global(.avatar-ring) {
    box-shadow: 0 0 0 2px var(--bg-secondary);
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .unread-badge {
    background: var(--gold-dim);
    color: var(--bg-primary);
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.125rem 0.5rem;
    border-radius: 1rem;
  }

  .header-icon-link {
    display: flex;
    align-items: center;
    color: var(--text-muted);
    transition: color var(--transition);
  }

  .header-icon-link:hover {
    color: var(--gold-dim);
    text-decoration: none;
  }

  .settings-link {
    display: flex;
    align-items: center;
    color: var(--text-muted);
    transition: color var(--transition);
  }

  .settings-link:hover {
    color: var(--gold-dim);
    text-decoration: none;
  }

  .canvas-trigger-wrapper {
    position: relative;
  }

  .header-icon-btn {
    display: flex;
    align-items: center;
    color: var(--text-muted);
    padding: 0.25rem;
    border-radius: 0.25rem;
    transition: color var(--transition);
  }

  .header-icon-btn:hover {
    color: var(--gold-dim);
  }

  .header-icon-btn.active {
    color: var(--gold);
  }


  .compaction-banner {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    background: var(--gold-ember);
    border-bottom: 1px solid var(--border);
    color: var(--gold-dim);
    font-size: 0.8125rem;
    flex-shrink: 0;
    animation: bannerFadeIn 0.3s ease-out;
  }

  .compaction-banner.compacting {
    animation: bannerFadeIn 0.3s ease-out, compactingPulse 2s ease-in-out infinite;
  }

  @keyframes bannerFadeIn {
    from { opacity: 0; transform: translateY(-0.25rem); }
    to { opacity: 1; transform: translateY(0); }
  }

  @keyframes compactingPulse {
    0%, 100% { background: var(--gold-ember); }
    50% { background: var(--gold-glow); }
  }

  .rate-limit-banner {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    background: var(--gold-ember);
    border-bottom: 1px solid var(--border);
    color: var(--gold);
    font-size: 0.8125rem;
    flex-shrink: 0;
    animation: bannerFadeIn 0.3s ease-out;
  }

  .messages-container {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    background: var(--bg-primary);
  }

  .scroll-to-bottom-wrapper {
    display: flex;
    justify-content: center;
    padding: 0.5rem 0;
    flex-shrink: 0;
  }

  .scroll-to-bottom {
    width: 2.25rem;
    height: 2.25rem;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 50%;
    color: var(--text-muted);
    cursor: pointer;
    box-shadow: var(--shadow-md);
    transition: all 0.15s;
    opacity: 0.85;
  }

  .scroll-to-bottom:hover {
    opacity: 1;
    color: var(--text-primary);
    transform: translateY(1px);
  }

  .messages-list {
    display: flex;
    flex-direction: column;
    padding: 1.5rem 1rem;
    min-height: 100%;
    max-width: 48rem;
    margin: 0 auto;
    width: 100%;
  }

  .loading-older,
  .thread-start {
    text-align: center;
    padding: 1rem;
    font-size: 0.75rem;
    color: var(--text-muted);
    letter-spacing: 0.04em;
  }

  .loading-older {
    font-style: italic;
  }

  .thread-start {
    font-family: var(--font-heading);
    opacity: 0.5;
  }

  .date-divider {
    display: flex;
    justify-content: center;
    align-items: center;
    width: 100%;
    margin: 1.25rem 0 0.5rem;
  }

  .date-divider-label {
    font-size: 0.6875rem;
    color: var(--text-primary);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    padding: 0.1875rem 0.75rem;
    border-radius: 999px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    gap: 0.5rem;
    padding: 2rem;
    text-align: center;
  }

  .empty-icon {
    font-size: 3rem;
    line-height: 1;
    margin-bottom: 0.25rem;
    opacity: 0.7;
  }

  .empty-title {
    font-family: var(--font-heading);
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
  }

  .empty-subtitle {
    font-size: 0.875rem;
    color: var(--text-muted);
    margin: 0 0 0.75rem;
  }

  .suggested-prompts {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.5rem;
    max-width: 480px;
  }

  .prompt-chip {
    padding: 0.5rem 1rem;
    background: var(--bg-surface);
    color: var(--text-secondary);
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 0.8125rem;
    cursor: pointer;
    transition: all 0.15s;
  }

  .prompt-chip:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
    border-color: var(--border-hover);
  }

  .message-wrapper {
    width: 100%;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  :global(.message-wrapper.highlight-flash) {
    animation: highlightFlash 2s ease-out;
  }

  @keyframes highlightFlash {
    0% { background: rgba(155, 114, 207, 0.2); }
    100% { background: transparent; }
  }

  /* Reduced-motion: drop the flash animation. The JS jump also skips adding the
     class and uses instant scroll, so this is a belt-and-suspenders guard. */
  @media (prefers-reduced-motion: reduce) {
    :global(.message-wrapper.highlight-flash) {
      animation: none;
    }
  }

  .activity-panel {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 1rem 1.25rem;
    border-radius: 0;
    align-self: flex-start;
    margin: 0.75rem 0;
    width: 100%;
  }

  .activity-header {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  .activity-label {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin-left: 0.25rem;
    font-style: italic;
    letter-spacing: 0.02em;
  }

  .activity-tools {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding-top: 0.25rem;
    border-top: 1px solid var(--border);
  }

  .activity-tool {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.75rem;
    font-family: var(--font-mono);
    opacity: 0.7;
    animation: fadeIn 0.3s ease-out;
  }

  .activity-tool.complete {
    opacity: 0.4;
  }

  .activity-tool.error {
    color: var(--color-error);
  }

  .tool-status {
    width: 1rem;
    text-align: center;
    flex-shrink: 0;
  }

  .activity-tool .tool-name {
    color: var(--gold-dim);
    white-space: nowrap;
  }

  .activity-tool .tool-input {
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tool-elapsed {
    color: var(--text-muted);
    font-size: 0.65rem;
    font-family: var(--font-mono);
    margin-left: auto;
    flex-shrink: 0;
  }

  /* Tail work: reply text landed, background work still running — calm the cursor */
  .message-wrapper.tail-working :global(.cursor) {
    display: none;
  }

  .tail-working-strip {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.25rem 0.75rem;
    color: var(--text-muted);
    font-size: 0.8rem;
    font-style: italic;
  }

  .tail-working-label {
    margin-left: 0.25rem;
  }

  .typing-dot {
    width: 0.3rem;
    height: 0.3rem;
    background: var(--gold-dim);
    border-radius: 50%;
    animation: typingBounce 1.4s infinite ease-in-out;
  }

  .typing-dot:nth-child(2) {
    animation-delay: 0.2s;
  }

  .typing-dot:nth-child(3) {
    animation-delay: 0.4s;
  }

  @keyframes typingBounce {
    0%, 60%, 100% {
      transform: translateY(0);
      opacity: 0.4;
    }
    30% {
      transform: translateY(-0.375rem);
      opacity: 1;
    }
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(-0.25rem); }
    to { opacity: 0.7; }
  }

  /* Mobile styles */
  @media (max-width: 768px) {
    .sidebar-overlay {
      display: block;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 99;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.3s;
    }

    .sidebar-overlay:has(+ .sidebar.open) {
      opacity: 1;
      pointer-events: auto;
    }

    .sidebar {
      position: fixed;
      top: 0;
      left: 0;
      bottom: 0;
      transform: translateX(-100%);
      transition: transform 0.3s;
      z-index: 100;
      width: 80%;
      max-width: 20rem;
    }

    .sidebar.open {
      transform: translateX(0);
    }

    .menu-button {
      display: block;
    }

    .chat-header {
      padding: calc(env(safe-area-inset-top, 0px) + 0.75rem) 0.75rem 0.75rem;
    }

    .messages-list {
      padding: 0.75rem;
      max-width: 100%;
    }

    /* Stack into two rows so nothing overlaps: identity on top, action rail below */
    .chat-header {
      flex-direction: column;
      align-items: stretch;
      gap: 0.5rem;
    }

    .header-top {
      gap: 0.5rem;
    }

    /* Let the model pill wrap to its own line below the name instead of
       squeezing the title. flex-wrap only triggers a wrap once the title
       stops shrinking (see .header-title below), so the name stays whole
       and the picker drops beneath it when the row runs out of room. */
    .header-info {
      gap: 0.375rem 0.5rem;
      min-width: 0;
      flex-wrap: wrap;
    }

    /* The names are the priority — never let them ellipsize on mobile.
       Holding the title at its natural width forces the pill to wrap. */
    .header-title {
      font-size: 1.0625rem;
      flex-shrink: 0;
    }

    /* Row 2 spans the width: roster pinned left, the icon rail takes the rest
       and scrolls horizontally. The ::after is a right-edge fade hinting more
       icons are a swipe away — an overlay (not a mask on the scroller) so it
       never touches the canvas dropdown that renders inside the rail. */
    .header-bar {
      width: 100%;
      gap: 0.5rem;
      position: relative;
    }
    .header-bar::after {
      content: '';
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      width: 1.75rem;
      pointer-events: none;
      background: linear-gradient(to right, transparent, var(--bg-secondary));
    }

    /* Horizontally-scrollable icon rail — matched to the Settings page-selector
       rail (.tabs): overflow-x auto, hidden scrollbar, no-wrap children. ≈4
       icons show at phone width; swipe reaches the rest. Every icon stays
       reachable and finger-sized; nothing is clipped away. */
    .header-actions {
      flex: 1 1 auto;
      min-width: 0;
      gap: 0.25rem;
      flex-wrap: nowrap;
      overflow-x: auto;
      overflow-y: hidden;
      scrollbar-width: none;
      -webkit-overflow-scrolling: touch;
      justify-content: flex-start;
      /* Room for finger overscroll past the last icon under the edge fade. */
      padding-right: 1.25rem;
    }

    .header-actions::-webkit-scrollbar {
      display: none;
    }

    /* Each rail item holds its size (no shrink) and keeps a finger-sized tap
       target so nothing collapses under the horizontal scroll. */
    .header-actions > * {
      flex: 0 0 auto;
    }

    .header-actions .header-icon-btn,
    .header-actions .header-icon-link,
    .header-actions .settings-link {
      min-width: 2.5rem;
      min-height: 2.5rem;
      justify-content: center;
    }
  }

  /* New thread modal */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 200;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .modal-backdrop-btn {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    border: none;
    cursor: default;
  }

  .thread-modal {
    position: relative;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 1.5rem;
    width: 90%;
    max-width: 400px;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  }

  .thread-modal-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
  }

  .thread-modal-eyebrow {
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
  }

  .thread-modal-title {
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--text-primary);
    margin-top: 0.25rem;
  }

  .thread-modal-close {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0.25rem;
    border-radius: 0.25rem;
  }

  .thread-modal-close:hover { color: var(--text-primary); }

  .thread-modal-input {
    height: 44px;
    padding: 0 1rem;
    background: var(--bg-input, var(--bg-tertiary));
    border: 1px solid var(--border);
    border-radius: 0.625rem;
    color: var(--text-primary);
    font-size: 0.875rem;
    font-family: var(--font-body);
    width: 100%;
  }

  .thread-modal-input:focus {
    outline: none;
    border-color: var(--gold-dim);
  }

  .thread-modal-input::placeholder {
    color: var(--text-muted);
  }

  .thread-modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  /* Thread-creation roster picker — companion chips, default seated. */
  .thread-modal-roster {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .thread-modal-roster-label {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--gold-dim);
  }
  .thread-modal-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

</style>
