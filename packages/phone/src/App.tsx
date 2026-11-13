import React, { useState, useEffect, useRef, useMemo } from 'react';
import { isBackSwipe } from './lib/edge-swipe';
import { runBackHandler } from './lib/back-stack';
import localforage from 'localforage';
import { MessageBubble } from './components/MessageBubble';
import { TypingIndicator } from './components/TypingIndicator';
import { ChatInput } from './components/ChatInput';
import { Message, AppTheme, ContactProfile, AppSettings, CustomEmoji } from './types';
import { Loader2, Smartphone, Search, X, Star, Settings, ChevronLeft, ChevronDown, Download, Square, Wifi, WifiOff, Menu } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn, haptic } from './lib/utils';
import { SettingsDashboard } from './components/SettingsDashboard';
import { ContactInfo } from './components/ContactInfo';
import { HomeScreen } from './components/HomeScreen';
import { LockScreen } from './components/LockScreen';
import { NotesApp } from './components/NotesApp';
import { JournalApp } from './components/JournalApp';
import { LibraryApp } from './components/LibraryApp';
import { LettersApp } from './components/LettersApp';
import { TreehouseApp } from './components/TreehouseApp';
import { FieldNotesApp } from './components/FieldNotesApp';
import { StudioApp } from './components/StudioApp';
import { ThreadSwitcher } from './components/ThreadSwitcher';
import { AppDrawer } from './components/AppDrawer';
import { StatusApp } from './components/StatusApp';
import { IntegrationsApp } from './components/IntegrationsApp';
import { AgentApp } from './components/AgentApp';
import { PacksApp } from './components/PacksApp';
import { CommandCenterApp } from './components/CommandCenterApp';
import { ModelPill } from './components/ModelPill';
import { CanvasApp } from './components/CanvasApp';
import { XRayApp } from './components/XRayApp';
import { GamesApp } from './components/GamesApp';
import { CompanionsApp } from './components/CompanionsApp';
import { WeatherApp } from './components/WeatherApp';
import { SpotifyApp } from './components/SpotifyApp';

interface DBCompanion {
  id: string;
  slug: string;
  display_name: string;
  avatar_url: string | null;
  color: string | null;
  emoji: string | null;
}

// Companion rows from main are normalised in one place (lib/companion-row).
function toDbCompanion(c: Record<string, unknown>): DBCompanion {
  const { id, slug, display_name, avatar_url, color, emoji } = normalizeCompanionRow(c);
  return { id, slug, display_name, avatar_url, color, emoji };
}
import { MemoryApp } from './components/MemoryApp';
import { ArtifactsApp } from './components/ArtifactsApp';
import { FilesApp } from './components/FilesApp';
import { InboxApp } from './components/InboxApp';
import { VoiceModeOverlay } from './components/VoiceModeOverlay';
import { StudioJobTray } from './components/StudioJobTray';
import { APPS, DOCK_APPS, migrateAppIds, type AppDef } from './lib/apps';
import { lockCardsOf } from './lib/lock-cards';
import { lockSpotifyOf } from './lib/lock-spotify';
import { lockClockAtOf, lockFaceOf, lockHiddenOf, lockPositionOf, lockShortcutsOf, lockShowOf, lockSizeOf, lockWeatherAtOf, withClockAt, withHidden } from './lib/lock-clock';
import { useLockUnread } from './bytelight/lock-unread';
import { homeSpotsOf, homeWidgetsOf } from './lib/home-widgets';

import { Share } from '@capacitor/share';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

import { THEMES, contrastTextColor, resolveThemeColors, themeRadiusPx, shapeVarsFor, withAccentOverride, TYPOGRAPHY_PRESETS, fontStack, monoStack } from './lib/theme';
import {
  BytelightLoginGate,
  useMessages,
  useStreaming,
  usePresence,
  useConnectionState,
  useLoadingThread,
  useThreads,
  useActiveThreadId,
  useTotalUnread,
  useIsStreaming,
  sendUserMessage,
  sendUserMessageToThread,
  deleteMessage as ksDeleteMessage,
  editMessage,
  regenerateMessage,
  RerollChangedError,
  addReaction,
  removeReaction,
  toPhoneMessage,
  stopGeneration,
  syncEmojis,
  listEmojiPacks,
  loadStickers,
  apiFetch,
  switchThread,
  loadThread,
  loadThreadAround,
  loadOlderMessages,
  fetchServerSettings,
  pushServerSettings,
  useBytelight,
  markRead,
  unlockVoicePlayback,
  proveAliveOrReconnect,
  useLimitWarning,
  useStarredBy,
  isStarredByMe,
  toggleStar,
  loadMyStars,
  loadProfiles,
  useProfiles,
} from './bytelight';
import { subscribeStickers } from './bytelight/stickers';
import { fetchOwnerFromPreferences, ownerFromCompanionsPayload } from './lib/owner';
import { StreamingReply } from './components/StreamingReply';
import { collectLocalExtras } from './components/SetupSync';
import { ContextIndicator } from './components/ContextIndicator';
import { CompactionBanner } from './components/CompactionBanner';
import { RateLimitBanner } from './components/RateLimitBanner';
import { SearchResults, type SearchResult } from './components/SearchResults';
import { StarredSheet } from './components/StarredSheet';
import { DateDivider } from './components/DateDivider';
import { splitMessageVoices } from './lib/voices';
import { deliverLastCrashReport } from './bytelight/pocket-voice';
import { normalizeCompanionRow } from './lib/companion-row';
import { buildSearchRequest, parseSearchPage, searchDelayMs, type SearchMode } from './lib/search-domain';
import { pushJumpFromMessage, pushJumpFromSearch, stripPushJumpParams, type PushJump } from './bytelight/push-target';

// A push tap that cold-started the app carries its target in the URL. Read
// once at load and strip it, so a later reload doesn't jump again.
const launchPushJump: PushJump | null = (() => {
  if (typeof window === 'undefined') return null;
  const jump = pushJumpFromSearch(window.location.search);
  if (jump) window.history.replaceState(window.history.state, '', stripPushJumpParams(window.location.href));
  return jump;
})();

// A page address (/settings, /memory, an old /chat link) opens that screen.
// The app has no router: read the first path segment once at load, match it
// to an app id (plus the old classic names), and put the address back to /
// so the bar never shows a screen the app has since left.
const PATH_APP_ALIASES: Record<string, string> = {
  chat: 'messages',
  cc: 'commandcenter',
  'command-center': 'commandcenter',
};
const launchPathApp: AppDef | null = (() => {
  if (typeof window === 'undefined') return null;
  const segment = window.location.pathname.split('/').filter(Boolean)[0]?.toLowerCase();
  if (!segment) return null;
  const id = PATH_APP_ALIASES[segment] ?? segment;
  const app = APPS.find((entry) => entry.id === id) ?? null;
  window.history.replaceState(window.history.state, '', '/' + window.location.search + window.location.hash);
  return app;
})();

const DEFAULT_THEME: AppTheme = {
  mode: 'dark',
  id: 'cobalt',
};

const DEFAULT_CONTACTS: Record<string, ContactProfile> = {
  companion1: {
    name: 'Companion',
    image: 'https://picsum.photos/seed/companion/800/800',
    bio: 'Your AI companion.',
    status: 'Online',
    phone: '(555) 000-0000',
  }
};

function AppBackground({ theme }: { theme: AppTheme }) {
  const [slideshowIndex, setSlideshowIndex] = useState(0);

  useEffect(() => {
    if (!theme.slideshowEnabled || !theme.wallpapers || theme.wallpapers.length <= 1) return;
    
    const interval = setInterval(() => {
      setSlideshowIndex((prev) => (prev + 1) % theme.wallpapers!.length);
    }, 10000); // 10 seconds
    
    return () => clearInterval(interval);
  }, [theme.slideshowEnabled, theme.wallpapers]);

  if (theme.slideshowEnabled && theme.wallpapers && theme.wallpapers.length > 0) {
    return (
      <AnimatePresence>
        <motion.img 
          key={slideshowIndex}
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.8 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.5 }}
          className="absolute inset-0 z-0 pointer-events-none w-full h-full object-cover"
          src={theme.wallpapers[slideshowIndex % theme.wallpapers.length]}
          alt="Slideshow"
          referrerPolicy="no-referrer"
        />
      </AnimatePresence>
    );
  }

  if (theme.wallpaper) {
    return (
      <img 
        className="absolute inset-0 z-0 opacity-80 pointer-events-none w-full h-full object-cover"
        src={theme.wallpaper}
        alt="Wallpaper"
        referrerPolicy="no-referrer"
      />
    );
  }

  return null;
}

export type OsScreen =
  | 'locked'
  | 'home'
  | 'appdrawer'
  | 'messages'
  | 'weather'
  | 'notes'
  | 'status'
  | 'integrations'
  | 'agent'
  | 'packs'
  | 'commandcenter'
  | 'canvas'
  | 'xray'
  | 'companions'
  | 'memory'
  | 'journal'
  | 'letters'
  | 'fieldnotes'
  | 'spotify'
  | 'treehouse'
  | 'studio'
  | 'files'
  | 'artifacts'
  | 'inbox'
  | 'games'
  | 'library';

export default function App() {
  // byte-light opens on home as it always has; the lock button on home (or
  // Aerie's default, 'locked') brings the lock screen up.
  const [osState, setOsState] = useState<OsScreen>('home');
  // Where the Messages chat header back button returns to — 'home' unless
  // Messages was launched from the app drawer.
  const [messagesReturnTo, setMessagesReturnTo] = useState<'home' | 'appdrawer'>('home');
  // Where the current full-screen app's back button returns to — set at
  // launch time so back always goes to wherever the app was opened from
  // (home shortcut vs app drawer), no per-app hardcoding. Also carries
  // 'messages' when a screen is opened from inside a thread (e.g. tapping
  // the chat-header avatars), so back drops you into the conversation you
  // came from rather than out to home.
  const [appReturnTo, setAppReturnTo] = useState<'home' | 'appdrawer' | 'messages'>('appdrawer');
  // A tapped canvas chip in the thread opens the Canvas app on that document.
  const [canvasOpenId, setCanvasOpenId] = useState<string | null>(null);
  useEffect(() => {
    const h = (e: Event) => {
      const id = (e as CustomEvent).detail?.canvasId;
      if (id) { setCanvasOpenId(id); setAppReturnTo('messages'); setOsState('canvas'); }
    };
    window.addEventListener('bytelight:open-canvas', h);
    return () => window.removeEventListener('bytelight:open-canvas', h);
  }, []);
  const [showThreadSwitcher, setShowThreadSwitcher] = useState(false);
  const [voiceSession, setVoiceSession] = useState<{ threadId: string; threadName: string } | null>(null);
  const [voiceMinimized, setVoiceMinimized] = useState(false);

  // Safe-area insets come from the index.css env() defaults on all platforms.
  // The Android shell needs no special floor since APK v1.2: it opted out of
  // edge-to-edge, so the WebView already sits below the system bars.

  // Global button haptics — one listener so every tappable control in the
  // house ticks (composer icons, pickers, headers, future buttons included)
  // without per-component wiring. Tiles layer their own firmer open-pulse
  // on top of this press tick.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const el = e.target as Element | null;
      if (el?.closest?.('button, [role="button"]')) haptic(55);
    };
    document.addEventListener('pointerdown', onPointerDown, { passive: true });
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);
  // Messages stream live from the Bytelight backend over WebSocket.
  const ksMessages = useMessages();
  const ksStreaming = useStreaming();
  const ksIsStreaming = useIsStreaming();
  const ksPresence = usePresence();
  const ksConnection = useConnectionState();
  const ksLoadingThread = useLoadingThread();
  const ksThreads = useThreads();
  const ksActiveThreadId = useActiveThreadId();
  // The lock screen's message card counts our unread words, read off the rows
  // of each room with something waiting, never the room's counter, which
  // counts everybody a listening cafe says (bytelight/lock-unread.ts).
  const lockThreads = useBytelight((s) => s.threads);
  const ksIsViewingAround = useBytelight((s) => s.isViewingAround);
  const totalUnread = useTotalUnread();

  const activeThread = useMemo(
    () => ksThreads.find((t) => t.id === ksActiveThreadId) || null,
    [ksThreads, ksActiveThreadId],
  );

  const messages = useMemo<Message[]>(
    () =>
      ksMessages
        .filter((m) => !m.deleted_at && !(m.role === 'companion' && m.content === '[No response]'))
        .map(toPhoneMessage),
    [ksMessages],
  );

  // What main's reroll will soft-delete: every live stored message from the
  // target onward (services/db/messages.ts getRerollPreview). Counted from the
  // raw list, not `messages` — that hides "[No response]" rows the server
  // still counts, and carries local-only command notices it never stored.
  const rerollCount = (id: string): number => {
    const from = ksMessages.findIndex((m) => m.id === id);
    if (from === -1) return 0;
    return ksMessages.slice(from).filter((m) => !m.deleted_at && !m.id.startsWith('cmd-')).length;
  };


  const isLoading = ksLoadingThread || (ksConnection !== 'connected' && ksMessages.length === 0);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Main's limit_warning frame: a subscription lane crossed a usage
  // threshold. Shown in the same pill as errors, held for two minutes like
  // the Svelte toast it mirrors.
  // Seed the viewer's stars each time the socket (re)connects; frames keep
  // them live in between.
  useEffect(() => {
    if (ksConnection === 'connected') {
      void loadMyStars();
      void loadProfiles();
    }
  }, [ksConnection]);
  // Main's profiles: live photos/emoji for every identity, the owner included.
  const ksProfiles = useProfiles();

  const limitWarning = useLimitWarning();
  useEffect(() => {
    if (!limitWarning) return;
    const reset = limitWarning.resetsAt ? new Date(limitWarning.resetsAt) : null;
    const resetNote = reset && !Number.isNaN(reset.getTime())
      ? ` · resets ${reset.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
      : '';
    setError(`${limitWarning.label} at ${limitWarning.percent}%${resetNote}`);
    const t = setTimeout(() => setError(null), 120_000);
    return () => clearTimeout(t);
  }, [limitWarning]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState<SearchMode>('keyword');
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  // Header star opens main's Starred sheet (every thread, every actor).
  const [showStarred, setShowStarred] = useState(false);

  // Server-side search — debounced fetch against /api/search. Results render
  // in a panel below the header; clicking jumps to the message (loading the
  // target thread first if needed).
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchGenerationRef = useRef(0);
  const lastSearchModeRef = useRef<SearchMode>(searchMode);
  useEffect(() => {
    const generation = ++searchGenerationRef.current;
    const delay = searchDelayMs(lastSearchModeRef.current, searchMode);
    lastSearchModeRef.current = searchMode;
    if (!isSearching) return;
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults([]);
      setSearchTotal(0);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    const handle = setTimeout(async () => {
      try {
        const res = await apiFetch(buildSearchRequest(q, searchMode));
        if (!res.ok) throw new Error(`Search failed: ${res.status}`);
        const data = parseSearchPage(await res.json());
        if (generation !== searchGenerationRef.current) return;
        setSearchResults(data.results);
        setSearchTotal(data.total);
      } catch (err) {
        if (generation !== searchGenerationRef.current) return;
        console.warn('[Bytelight] Search failed:', err);
        setSearchResults([]);
        setSearchTotal(0);
      } finally {
        if (generation === searchGenerationRef.current) setSearchLoading(false);
      }
    }, delay);
    return () => clearTimeout(handle);
  }, [searchQuery, searchMode, isSearching]);
  
  // Modals
  const [showSettings, setShowSettings] = useState(false);
  const [showContactInfo, setShowContactInfo] = useState(false);

  // Theme State
  const [theme, setTheme] = useState<AppTheme>(() => {
    const saved = localStorage.getItem('bytelight_theme');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        // Handle legacy theme migration
        if (parsed.accentColor) {
          return { mode: parsed.mode || 'dark', id: 'monochrome' };
        }
        
        // Handle theme name migrations
        if (parsed.id === 'light-orange') parsed.id = 'peach';
        if (parsed.id === 'light-yellow') parsed.id = 'lemon';
        if (parsed.id === 'light-blue') parsed.id = 'sky';

        // Strip wallpapers from localStorage load to prevent flashing old cached wallpapers
        // that failed to update due to quota limits
        delete parsed.wallpaper;
        delete parsed.lockScreenWallpaper;
        delete parsed.wallpapers;
        return parsed;
      } catch (e) {}
    }
    return DEFAULT_THEME;
  });
  // Read only while the lock screen is up and its message card can show.
  const lockUnread = useLockUnread(lockThreads, osState === 'locked' && lockShowOf(theme.lockShow) !== 'nothing');

  // Update theme-color meta tag, Native Status Bar, and Body Background
  useEffect(() => {
    const activeTheme = withAccentOverride(THEMES[theme.id] || THEMES['monochrome'], theme.accentOverride, theme.accentPalette);
    const colors = activeTheme[theme.mode];
    const resolved = resolveThemeColors(colors);
    const pageBgColor = theme.id === 'custom'
      ? (theme.customColors?.[theme.mode]?.pageBg || (theme.mode === 'light' ? '#FFFFFF' : '#000000'))
      : resolved.pageBg;

    // Use black for the home screen (when wallpaper is active),
    // otherwise use pageBgColor so status bar matches opaque headers.
    // When Settings is open (showSettings), always use pageBgColor since
    // Settings has an opaque header that needs the status bar to match.
    let themeColor = pageBgColor;
    if (!showSettings && osState === 'home' && theme.wallpaper) {
      themeColor = '#000000';
    } else if (theme.mode === 'light') {
      // Daylight status bar stays clean white (owner's call, Jul 2026) —
      // tinted light pageBg hexes read as off-colors up there (teal's
      // mint came out bluish against the status icons).
      themeColor = '#FFFFFF';
    }

    // Replace the meta node instead of mutating it — Chrome-on-Android
    // PWAs often skip repainting the status bar when only the content
    // attribute changes, which left the previous mode's color up top
    // until the app was fully relaunched.
    document.querySelector('meta[name="theme-color"]')?.remove();
    const metaThemeColor = document.createElement('meta');
    metaThemeColor.setAttribute('name', 'theme-color');
    metaThemeColor.setAttribute('content', themeColor);
    document.head.appendChild(metaThemeColor);
    
    // Set the body color so iOS overscroll and safe-areas match perfectly
    document.body.style.backgroundColor = themeColor;
    document.documentElement.style.backgroundColor = themeColor;

    // Update Native Capacitor / Cordova properties
    const cap = (window as any).Capacitor;
    if (cap && cap.isNativePlatform && cap.isNativePlatform()) {
      const syncNativeBars = async () => {
        try {
          if (cap.Plugins && cap.Plugins.StatusBar) {
            await cap.Plugins.StatusBar.setBackgroundColor({ color: themeColor });
            await cap.Plugins.StatusBar.setStyle({
              style: theme.mode === 'dark' ? 'DARK' : 'LIGHT'
            });
          }
        } catch (e) {}
        
        try {
          if ((window as any).NavigationBar) {
            (window as any).NavigationBar.backgroundColorByHexString(themeColor, theme.mode !== 'dark');
          }
        } catch (e) {}
      };
      syncNativeBars();
    }
  }, [theme, osState, showSettings]);

  const customThemeStyles = useMemo(() => {
    if (theme.id !== 'custom' || !theme.customColors) return null;
    const modeColors = theme.customColors[theme.mode];
    
    // Default to monochrome logic if custom colors are missing
    const isDark = theme.mode === 'dark';
    
    return `
      :root {
        --custom-pageBg: ${modeColors.pageBg || (isDark ? '#09090B' : '#F4F4F5')};
        --custom-panelBg: ${modeColors.panelBg || (isDark ? '#18181B' : '#ffffff')};
        --custom-panelBorder: ${modeColors.panelBorder || (isDark ? '#FAFAFA' : '#18181B')};
        --custom-textMain: ${modeColors.textMain || (isDark ? '#FAFAFA' : '#18181B')};
        --custom-textMuted: ${modeColors.textMuted || (isDark ? '#FAFAFA' : '#18181B')};
        --custom-userBubbleBg: ${modeColors.userBubbleBg || (isDark ? '#FAFAFA' : '#18181B')};
        --custom-userBubbleText: ${modeColors.userBubbleText || (isDark ? '#09090B' : '#ffffff')};
        --custom-compBubbleBg: ${modeColors.compBubbleBg || (isDark ? '#FAFAFA' : '#18181B')};
        --custom-compBubbleText: ${modeColors.compBubbleText || (isDark ? '#FAFAFA' : '#18181B')};
        --custom-accent: ${modeColors.accent || (isDark ? '#FAFAFA' : '#18181B')};
        --custom-accentText: ${modeColors.accentText || modeColors.accent || (isDark ? '#FAFAFA' : '#18181B')};
      }
    `;
  }, [theme]);

  // Contacts State
  const [contacts, setContacts] = useState<Record<string, ContactProfile>>(() => {
    const saved = localStorage.getItem('bytelight_contacts');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {}
    }
    return DEFAULT_CONTACTS;
  });

  // DB Companions (for header display)
  const [dbCompanions, setDbCompanions] = useState<DBCompanion[]>([]);
  // The same call reports who owns the house, so views that show the owner's
  // name next to ours read it from the server instead of carrying one inside.
  const [ownerName, setOwnerName] = useState('You');
  useEffect(() => {
    apiFetch('/api/companions')
      .then(res => res.ok ? res.json() : null)
      .then(async data => {
        if (data?.companions) setDbCompanions(data.companions.map(toDbCompanion));
        const owner = ownerFromCompanionsPayload(data) ?? await fetchOwnerFromPreferences();
        if (owner?.name) setOwnerName(owner.name);
      })
      .catch(() => {});
    // Re-read once main's profiles land so the rows pick up the live photos.
  }, [ksProfiles]);

  // Companions assigned to the active thread — the chat header shows only
  // these avatars. Threads with no explicit assignments fall back to all
  // companions.
  const [threadCompanions, setThreadCompanions] = useState<DBCompanion[]>([]);
  useEffect(() => {
    if (!ksActiveThreadId) { setThreadCompanions([]); return; }
    let stale = false;
    apiFetch(`/api/threads/${ksActiveThreadId}/roster`)
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (!stale) setThreadCompanions((data?.roster ?? []).map(toDbCompanion)); })
      .catch(() => { if (!stale) setThreadCompanions([]); });
    return () => { stale = true; };
  }, [ksActiveThreadId, ksProfiles]);

  const beginVoiceConversation = () => {
    if (!ksActiveThreadId || !activeThread) return;
    // Prime the shared AudioContext inside the actual tap. The overlay does
    // its own preflight, but iOS will not let a later async TTS response
    // become the first sound-producing action on the page.
    void unlockVoicePlayback().catch(() => {
      /* The overlay leaves a tap-to-retry surface if the WebView insists. */
    });
    setVoiceMinimized(false);
    setVoiceSession({ threadId: ksActiveThreadId, threadName: activeThread.name });
  };

  const closeVoiceConversation = () => {
    setVoiceMinimized(false);
    setVoiceSession(null);
  };

  const sendVoiceConversationTurn = (text: string, metadata: Record<string, unknown>) => {
    const session = voiceSession;
    if (!session) throw new Error('The voice conversation has ended');
    if (ksConnection !== 'connected') throw new Error('Bytelight is reconnecting');
    sendUserMessageToThread(session.threadId, text, 'text', metadata);
  };

  // A conversation belongs to its thread, not to the Messages screen. Moving
  // through Studio, GIF Lab, or a game collapses it into the global dock;
  // changing threads still ends it so a late transcript can never land in a
  // different room.
  useEffect(() => {
    if (!voiceSession) return;
    if (ksActiveThreadId !== voiceSession.threadId) {
      closeVoiceConversation();
    } else if (osState !== 'messages') {
      setVoiceMinimized(true);
    }
  }, [osState, ksActiveThreadId, voiceSession]);

  const forceScrollWindow = useRef<number>(Date.now() + 3000);
  // Holds a message id while a search-jump is in flight. The auto-scroll
  // effect that fires on thread switch checks this and bails out, so the
  // 4 staggered scrollToBottom timeouts (10ms / 100ms / 500ms / 1200ms)
  // don't yank the view back to the bottom after we've scrolled to the
  // search target.
  const pendingJumpMessageId = useRef<string | null>(null);

  // App Settings State
  const [appSettings, setAppSettings] = useState<AppSettings>(() => {
    const saved = localStorage.getItem('bytelight_settings');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed.dockAppIds)) parsed.dockAppIds = migrateAppIds(parsed.dockAppIds);
        return { groupChatName: 'Bytelight', osName: 'Bytelight OS', fontFamily: 'font-sans', workerUrl: '', giphyApiKey: '', elevenLabsApiKey: '', customEmojis: [], ...parsed };
      } catch (e) {}
    }
    return { theme: DEFAULT_THEME, contacts: DEFAULT_CONTACTS, groupChatName: 'Bytelight', osName: 'Bytelight OS', fontFamily: 'font-sans', workerUrl: '', giphyApiKey: '', elevenLabsApiKey: '', customEmojis: [] };
  });
  // The owner's photo is shared with the Svelte client through profiles.user;
  // a phone-only avatar from older settings is the fallback.
  const ownerAvatar = ksProfiles?.user?.image || appSettings.userAvatar;

  // Update document title
  useEffect(() => {
    document.title = appSettings.osName || 'Bytelight OS';
  }, [appSettings.osName]);

  // Sync System Bars removed, merged into theme-color effect above

  // The phone is served same-origin with the Bytelight backend.
  const apiBase = '/api';

  // Server-stored BYOK secrets fetched after connect (see effect below).
  // Fall back to legacy localStorage values for first boot before the
  // migration runs. import.meta.env still wins as the dev fallback.
  const [serverSecrets, setServerSecrets] = useState<{ elevenLabsApiKey?: string; giphyApiKey?: string }>({});
  const giphyApiKey = serverSecrets.giphyApiKey || appSettings.giphyApiKey || import.meta.env.VITE_GIPHY_API_KEY || '';
  const elevenLabsApiKey = serverSecrets.elevenLabsApiKey || appSettings.elevenLabsApiKey || '';

  // Resolve the user's chosen dock apps from saved ids, with a sensible
  // fallback to the registry's defaults. Missing/renamed ids are dropped.
  const dockApps = useMemo<AppDef[]>(() => {
    const ids = appSettings.dockAppIds;
    if (!ids || ids.length === 0) return DOCK_APPS;
    const byId = new Map(APPS.map((a) => [a.id, a]));
    return migrateAppIds(ids).map((id) => byId.get(id)).filter((a): a is AppDef => !!a);
  }, [appSettings.dockAppIds]);

  const [isLoaded, setIsLoaded] = useState(false);
  // Goes true once we've reconciled local state with whatever the server
  // had stored. Until then, we don't push changes back — would race the
  // initial fetch and risk overwriting newer server state with stale
  // localStorage from a different browser.
  const serverSettingsHydrated = useRef(false);

  // Load from localforage on mount (for large data like base64 images)
  useEffect(() => {
    const loadPersistedData = async () => {
      try {
        const savedTheme = await localforage.getItem<AppTheme>('bytelight_theme');
        if (savedTheme) {
          setTheme(savedTheme);
        }

        const savedContacts = await localforage.getItem<any>('bytelight_contacts');
        if (savedContacts) {
          setContacts(savedContacts);
        }

        const savedSettings = await localforage.getItem<any>('bytelight_settings');
        if (savedSettings) {
          const migrated = {
            ...savedSettings,
            ...(Array.isArray(savedSettings.dockAppIds) ? { dockAppIds: migrateAppIds(savedSettings.dockAppIds) } : {}),
          };
          setAppSettings(prev => ({ ...prev, ...migrated }));
        }
      } catch (e) {
        console.error('Failed to load data from localforage:', e);
      } finally {
        setIsLoaded(true);
      }
    };
    loadPersistedData();
  }, []);

  // After local cache is loaded + we're authenticated, reconcile against
  // the server blob so theme/contacts/appSettings follow the user across
  // browsers. Server wins for keys it knows about; if the server is
  // empty, the next push effect will seed it from whatever loaded
  // locally. Guarded by serverSettingsHydrated so we don't re-fire on
  // every state change.
  const authenticated = useBytelight((s) => s.auth.authenticated);

  // A native crash cannot report itself — the session cookie is HttpOnly, so
  // the dying process has nothing to authenticate with. The shell leaves the
  // report on the device and this hands it over once we are logged in again.
  useEffect(() => {
    if (!authenticated) return;
    void deliverLastCrashReport();
  }, [authenticated]);

  useEffect(() => {
    if (!isLoaded) return;
    if (!authenticated) return;
    if (serverSettingsHydrated.current) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const attempt = async () => {
      try {
        const blob = await fetchServerSettings();
        if (cancelled) return;
        if (blob) {
          if (blob.theme) setTheme((prev) => ({ ...prev, ...blob.theme! }));
          if (blob.contacts) setContacts((prev) => ({ ...prev, ...blob.contacts! }));
          if (blob.appSettings) {
            const serverAppSettings = {
              ...blob.appSettings,
              ...(Array.isArray(blob.appSettings.dockAppIds)
                ? { dockAppIds: migrateAppIds(blob.appSettings.dockAppIds) }
                : {}),
            };
            setAppSettings((prev) => ({ ...prev, ...serverAppSettings }));
          }
        }
        // Only mark hydration complete when the fetch SUCCEEDED. A null
        // blob here means the server confirmed it has no stored settings
        // — safe to mark hydrated so the push effect seeds the server
        // with our local state. Errors (network / auth / parse) throw
        // and land in the catch below, leaving hydration false so the
        // push effect stays blocked and CAN'T overwrite the real
        // server-side data with local defaults.
        serverSettingsHydrated.current = true;
      } catch (err) {
        console.warn('[Settings] sync failed, will retry once:', err);
        if (cancelled || retryTimer) return;
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          if (!cancelled) void attempt();
        }, 5000);
      }
    };
    void attempt();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [isLoaded, authenticated]);

  // Local metadata for reactions and bookmarks (persisted in localStorage)
  const [localMetadata, setLocalMetadata] = useState<Record<string, { reactions?: string[], isBookmarked?: boolean }>>(() => {
    const saved = localStorage.getItem('bytelight_metadata');
    return saved ? JSON.parse(saved) : {};
  });

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const isNearBottom = () => {
    const container = scrollContainerRef.current;
    if (!container) return true;
    // Allow a 400px threshold for reading
    return container.scrollHeight - container.scrollTop - container.clientHeight < 400;
  };

  // Scroll a specific message into view and flash a ring around it. Used by
  // search-result jumps. The element is rendered with data-msg-id below.
  // Retries a few times if the element isn't in the DOM yet (React may still
  // be rendering the new messages after loadThreadAround).
  const scrollToMessageId = (messageId: string, retries = 5) => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const el = container.querySelector<HTMLElement>(`[data-msg-id="${messageId}"]`);
    if (!el) {
      if (retries > 0) {
        setTimeout(() => scrollToMessageId(messageId, retries - 1), 100);
      }
      return;
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('msg-flash');
    el.style.color = colors.accent;
    setTimeout(() => {
      el.classList.remove('msg-flash');
      el.style.color = '';
    }, 1800);
  };

  const handleSearchSelect = async (result: SearchResult) => {
    setIsSearching(false);
    setSearchQuery('');
    if (osState !== 'messages') setOsState('messages');
    // Suppresses the thread-switch auto-scroll-to-bottom timeouts so they
    // don't override our scrollToMessageId. Held for ~1.5s — slightly longer
    // than the latest staggered scrollToBottom (1200ms) — then released so
    // normal auto-scroll on new messages can resume.
    pendingJumpMessageId.current = result.messageId;
    const release = () => {
      pendingJumpMessageId.current = null;
    };

    const alreadyLoaded = ksMessages.some((m) => m.id === result.messageId);
    if (alreadyLoaded && result.threadId === ksActiveThreadId) {
      // No thread switch — scroll to the message, but keep the guard up
      // for a bit so other scroll effects don't override us.
      setTimeout(() => {
        scrollToMessageId(result.messageId);
        setTimeout(release, 1500);
      }, 50);
      return;
    }

    await loadThreadAround(result.threadId, result.messageId);
    // Two paints so React has mounted the bubbles with data-msg-id, then
    // scroll. Outlasts the 1200ms scrollToBottom timeouts so the page
    // stays put after we've placed it.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollToMessageId(result.messageId);
        setTimeout(release, 1500);
      });
    });
  };

  // Push taps: the service worker hands over a thread (and the message, when
  // the push was a reply), in the launch URL or as a message to this window.
  // Held until the socket is connected, then landed with the same jump
  // Starred and search use; a thread-only push just opens the thread.
  const [pushJump, setPushJump] = useState<PushJump | null>(launchPushJump);
  const handleSearchSelectRef = useRef(handleSearchSelect);
  handleSearchSelectRef.current = handleSearchSelect;
  useEffect(() => {
    const container = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
    if (!container) return;
    const onMessage = (event: MessageEvent) => {
      const jump = pushJumpFromMessage(event.data);
      if (jump) setPushJump(jump);
    };
    container.addEventListener('message', onMessage);
    container.startMessages();
    return () => container.removeEventListener('message', onMessage);
  }, []);
  useEffect(() => {
    if (!pushJump || ksConnection !== 'connected') return;
    setPushJump(null);
    if (pushJump.messageId) {
      void handleSearchSelectRef.current({ threadId: pushJump.threadId, messageId: pushJump.messageId } as SearchResult);
      return;
    }
    setIsSearching(false);
    setSearchQuery('');
    if (osState !== 'messages') setOsState('messages');
    switchThread(pushJump.threadId);
  }, [pushJump, ksConnection]);

  // Track scroll position so the floating "jump to latest" button can show
  // once the user has scrolled up out of the auto-scroll window.
  // Also: when the user scrolls near the top, page in the previous 50 messages
  // so threads with thousands of rows aren't capped at the first slice.
  const loadingOlderRef = useRef(false);
  const hasMoreOlderRef = useRef(true);
  useEffect(() => {
    // Reset paging guards whenever the active thread changes.
    loadingOlderRef.current = false;
    hasMoreOlderRef.current = true;
  }, [ksActiveThreadId]);
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const onScroll = () => {
      const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
      setIsAtBottom(atBottom);

      // Within 200px of the top — fire a load-older page (once at a time).
      if (
        container.scrollTop < 200 &&
        !loadingOlderRef.current &&
        hasMoreOlderRef.current &&
        ksActiveThreadId &&
        messages.length > 0
      ) {
        loadingOlderRef.current = true;
        const prevHeight = container.scrollHeight;
        const prevTop = container.scrollTop;
        loadOlderMessages(ksActiveThreadId)
          .then((hasMore) => {
            hasMoreOlderRef.current = hasMore;
            // Preserve scroll position so the user doesn't snap up after prepend.
            requestAnimationFrame(() => {
              const c = scrollContainerRef.current;
              if (c) c.scrollTop = prevTop + (c.scrollHeight - prevHeight);
            });
          })
          .finally(() => {
            loadingOlderRef.current = false;
          });
      }
    };
    onScroll();
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, [osState, ksActiveThreadId, messages.length]);

  const scrollToBottom = (instant?: boolean, force?: boolean) => {
    // A search-jump is mid-flight — its target scroll has priority over
    // the thread-switch auto-scroll-to-bottom that fired alongside it.
    if (pendingJumpMessageId.current) return;
    const isForced = force || Date.now() < forceScrollWindow.current;
    if (!isForced && !isNearBottom()) return;
    
    // Safely scroll the specific container to avoid full-page body jumping
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: instant ? 'auto' : 'smooth'
      });
    }
  };

  // Auto-scroll on tab switch or app open
  useEffect(() => {
    forceScrollWindow.current = Date.now() + 3000;
    if (osState === 'messages' && isLoaded) {
      setTimeout(() => scrollToBottom(true, true), 10);
      setTimeout(() => scrollToBottom(true, true), 100); 
      // Add generous timeouts to catch large images unbuffering on initial switch
      setTimeout(() => scrollToBottom(true, true), 500); 
      setTimeout(() => scrollToBottom(true, true), 1200); 
    }
  }, [ksActiveThreadId, osState, isLoaded]); // Explicitly do NOT depend on message lengths here to avoid fighting the user scroll

  // Keep the thread pinned to the newest message as it streams in.
  useEffect(() => {
    if (osState === 'messages') scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [osState, messages.length, ksStreaming.tokens]);

  // Guarantee we land at the newest message when a thread's messages first
  // arrive — independent of the 3s force-scroll window above. On a slow load
  // (weak network) the staggered timeouts all fire against an empty/stale
  // container and expire before the messages render, so the fallback scroll
  // sees "not near bottom" and gives up, parking the view mid-thread. This
  // fires once per thread the moment its messages populate, so opening the
  // app always drops you at the bottom. Same-thread paging/streaming don't
  // re-trigger it (ref already matches); leaving messages re-arms it.
  const loadScrollThreadRef = useRef<string | null>(null);
  useEffect(() => {
    if (osState !== 'messages') { loadScrollThreadRef.current = null; return; }
    if (!ksActiveThreadId || messages.length === 0) return;
    if (loadScrollThreadRef.current === ksActiveThreadId) return;
    // Don't override a search-jump in progress
    if (pendingJumpMessageId.current) return;
    loadScrollThreadRef.current = ksActiveThreadId;
    requestAnimationFrame(() => scrollToBottom(true, true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [osState, ksActiveThreadId, messages.length]);

  // Auto-mark the active thread read whenever the user is actually looking
  // at it. Without this, the backend keeps bumping unread_count on every
  // companion reply (agent.ts:917 / pulse path :678) and the badge sticks
  // around even though the messages are right there on screen. Conditions
  // mirror what counts as "viewing": on the messages screen, with an
  // active thread, and the tab is in the foreground.
  const latestMessageId = ksMessages.length > 0 ? ksMessages[ksMessages.length - 1].id : null;
  useEffect(() => {
    if (osState !== 'messages') return;
    if (!ksActiveThreadId) return;
    if (!latestMessageId) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    markRead(ksActiveThreadId, latestMessageId);
  }, [osState, ksActiveThreadId, latestMessageId]);

  // Re-mark on tab refocus so messages that arrived while the tab was
  // backgrounded (visibility-gated effect above skipped them) clear the
  // moment the user looks again.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (osState !== 'messages' || !ksActiveThreadId || !latestMessageId) return;
      markRead(ksActiveThreadId, latestMessageId);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [osState, ksActiveThreadId, latestMessageId]);
  useEffect(() => {
    if (theme.mode === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme.mode]);

  // Persist Theme (Local)
  useEffect(() => {
    if (!isLoaded) return;
    localforage.setItem('bytelight_theme', theme).catch(e => {
      console.error('Failed to save theme to localforage:', e);
    });
    try {
      const themeForLocalStorage = { ...theme };
      delete themeForLocalStorage.wallpaper;
      delete themeForLocalStorage.lockScreenWallpaper;
      delete themeForLocalStorage.wallpapers;
      localStorage.setItem('bytelight_theme', JSON.stringify(themeForLocalStorage));
    } catch (e) {}
  }, [theme, isLoaded]);

  // Persist Contacts
  useEffect(() => {
    if (!isLoaded) return;
    localforage.setItem('bytelight_contacts', contacts).catch(e => {
      console.error('Failed to save contacts to localforage:', e);
      setError('Failed to save contact image. The image might be too large.');
      setTimeout(() => setError(null), 5000);
    });
    try {
      localStorage.setItem('bytelight_contacts', JSON.stringify(contacts));
    } catch (e) {}
  }, [contacts, isLoaded]);

  useEffect(() => {
    if (!isLoaded) return;
    localforage.setItem('bytelight_settings', appSettings).catch(e => {
      console.error('Failed to save settings to localforage:', e);
    });
    try {
      localStorage.setItem('bytelight_settings', JSON.stringify(appSettings));
    } catch (e) {}
  }, [appSettings, isLoaded]);

  // Push theme + contacts + appSettings to /api/settings whenever any
  // of them change. Debounced 1s so quickly-typed changes don't fire a
  // PUT per keystroke. Gated on serverSettingsHydrated.current so we
  // never overwrite the server with localStorage before reconciling.
  useEffect(() => {
    if (!isLoaded || !authenticated) return;
    if (!serverSettingsHydrated.current) return;
    const t = setTimeout(() => {
      void pushServerSettings({ theme, contacts, appSettings, extras: collectLocalExtras() });
    }, 1000);
    return () => clearTimeout(t);
  }, [theme, contacts, appSettings, isLoaded, authenticated]);

  // Reconcile custom emojis with the backend on first successful connect:
  // upload any legacy base64 entries, pull anything new, and write the
  // merged set back. Idempotent — gated to run once per session.
  // Sticker refs can render before the async catalog has arrived. The catalog
  // is module state, so without this signal those already-mounted bubbles keep
  // showing literal ::pack_sticker:: text until some unrelated render happens.
  const [stickerCatalogRevision, bumpStickerCatalogRevision] = useState(0);
  useEffect(
    () => subscribeStickers(() => bumpStickerCatalogRevision((revision) => revision + 1)),
    [],
  );

  const emojiSyncRan = useRef(false);
  // Pack list — used by the chat-input emoji picker to render one tab
  // per pack. Refreshed alongside customEmojis on boot and whenever
  // the user changes packs via the Packs app.
  const [emojiPacks, setEmojiPacks] = useState<{ id: string; name: string }[]>([]);
  async function refreshEmojiPacks() {
    try {
      setEmojiPacks(await listEmojiPacks());
    } catch {
      /* non-fatal — picker just falls back to a single Custom view */
    }
  }
  useEffect(() => {
    if (!isLoaded) return;
    if (ksConnection !== 'connected') return;
    if (emojiSyncRan.current) return;
    emojiSyncRan.current = true;
    void (async () => {
      try {
        const merged = await syncEmojis(appSettings.customEmojis || []);
        setAppSettings((prev) => ({ ...prev, customEmojis: merged }));
        void refreshEmojiPacks();
      } catch (err) {
        console.warn('[Bytelight] Emoji sync failed:', err);
      }
    })();
    // Prime the sticker cache so the picker opens fast and bubbles can
    // render inline ::pack_sticker:: refs without a per-message fetch.
    void loadStickers();
  }, [isLoaded, ksConnection]);

  // BYOK secrets bootstrap. Migrate any legacy localStorage keys to the
  // server-stored secrets store on first connect, then pull the canonical
  // values back into local state so client-side TTS / GIF search can use
  // them. After migration the localStorage copies are cleared.
  const secretsBootstrapRan = useRef(false);
  useEffect(() => {
    if (!isLoaded) return;
    if (ksConnection !== 'connected') return;
    if (secretsBootstrapRan.current) return;
    secretsBootstrapRan.current = true;
    void (async () => {
      const migrations: Array<[keyof AppSettings, string]> = [
        ['elevenLabsApiKey', 'elevenlabs_api_key'],
        ['giphyApiKey', 'giphy_api_key'],
      ];
      for (const [appKey, serverName] of migrations) {
        const localValue = (appSettings as unknown as Record<string, unknown>)[appKey];
        if (typeof localValue !== 'string' || !localValue.trim()) continue;
        try {
          const check = await apiFetch(`/api/secrets/${serverName}`);
          if (check.status === 404) {
            await apiFetch(`/api/secrets/${serverName}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ value: localValue }),
            });
          }
          // Clear the local copy regardless — the server now owns it.
          setAppSettings((prev) => ({ ...prev, [appKey]: '' }));
        } catch (err) {
          console.warn(`[Bytelight] Secret migration ${serverName} failed:`, err);
        }
      }
      // Fetch canonical values for client-side use.
      try {
        const [el, gp] = await Promise.all([
          apiFetch('/api/secrets/elevenlabs_api_key'),
          apiFetch('/api/secrets/giphy_api_key'),
        ]);
        const next: typeof serverSecrets = {};
        if (el.ok) next.elevenLabsApiKey = (await el.json()).value;
        if (gp.ok) next.giphyApiKey = (await gp.json()).value;
        setServerSecrets(next);
      } catch (err) {
        console.warn('[Bytelight] Secret fetch failed:', err);
      }

      // Sync any contact voice IDs to the backend secrets store so the
      // companion's own sc.mjs voice tool can find them. PUT only when
      // the server doesn't already have a value — we don't want this
      // boot-time loop to clobber a value the user just typed elsewhere.
      for (const [contactId, contact] of Object.entries(contacts)) {
        const vid = contact?.voiceId?.trim();
        if (!vid) continue;
        const slug = contactId.toLowerCase();
        try {
          const check = await apiFetch(`/api/secrets/elevenlabs_voice_id:${encodeURIComponent(slug)}`);
          if (check.status === 404) {
            await apiFetch(`/api/secrets/elevenlabs_voice_id:${encodeURIComponent(slug)}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ value: vid }),
            });
          }
        } catch (err) {
          console.warn(`[Bytelight] Voice-ID sync ${slug} failed:`, err);
        }
      }
    })();
  }, [isLoaded, ksConnection]);

  const updateTheme = (updates: Partial<AppTheme>) => {
    setTheme(prev => ({ ...prev, ...updates }));
  };

  const updateContact = (id: string, updates: Partial<ContactProfile> | null) => {
    setContacts(prev => {
      const prevContact = prev[id];
      if (updates === null) {
        const newContacts = { ...prev };
        delete newContacts[id];
        // If this contact had a voice ID, also drop the backend secret so
        // sc.mjs voice doesn't keep trying to use a stale ID.
        if (prevContact?.voiceId) {
          void apiFetch(`/api/secrets/elevenlabs_voice_id:${encodeURIComponent(id.toLowerCase())}`, { method: 'DELETE' }).catch(() => {});
        }
        return newContacts;
      }
      // Push voice-ID changes into the backend secrets store. Slug = the
      // contact id, lowercased — VoiceService.listSecretsByPrefix picks
      // these up regardless of whether the contact is registered as a
      // companion in the DB.
      if ('voiceId' in updates && updates.voiceId !== prevContact?.voiceId) {
        const slug = id.toLowerCase();
        const v = updates.voiceId;
        if (v && v.trim()) {
          void apiFetch(`/api/secrets/elevenlabs_voice_id:${encodeURIComponent(slug)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: v.trim() }),
          }).catch(() => {});
        } else {
          void apiFetch(`/api/secrets/elevenlabs_voice_id:${encodeURIComponent(slug)}`, { method: 'DELETE' }).catch(() => {});
        }
      }
      return {
        ...prev,
        [id]: { ...prev[id], ...updates }
      };
    });
  };

  const updateAppSettings = (updates: Partial<typeof appSettings>) => {
    setAppSettings(prev => ({ ...prev, ...updates }));
  };

  const exportChat = async (_type: 'main' | 'private' = 'main') => {
    const sourceMessages = messages;
    const formattedText = sourceMessages.map(msg => {
      const date = new Date(msg.timestamp).toLocaleString();
      const sender = msg.direction === 'inbound' ? 'You' : (msg.sender || Object.values(contacts).map(c => c.name).join(' & '));
      
      let content = msg.content.trim();
      
      // Handle Voice Notes
      if (content.startsWith('[VOICE]:')) {
        const voiceContent = content.replace('[VOICE]:', '').trim();
        const firstColon = voiceContent.indexOf(': ');
        if (firstColon !== -1 && firstColon < 20) {
          const speaker = voiceContent.substring(0, firstColon).trim();
          const text = voiceContent.substring(firstColon + 2).trim();
          content = `[Voice Note from ${speaker}]: ${text}`;
        } else {
          content = `[Voice Note]: ${voiceContent}`;
        }
      } else if (msg.type === 'voice') {
        content = `[Voice Note]: ${content}`;
      }
      
      // Handle GIFs
      if (content.includes('[GIF]:')) {
        const parts = content.split('[GIF]:');
        const textPart = parts[0].trim();
        const urlPart = parts[1].trim();
        content = textPart ? `${textPart}\n[GIF sent]: ${urlPart}` : `[GIF sent]: ${urlPart}`;
      } else if (msg.type === 'gif') {
        content = `[GIF sent]: ${content}`;
      }
      
      // Handle Images
      if (content.includes('[IMG]:')) {
        const parts = content.split('[IMG]:');
        const textPart = parts[0].trim();
        const urlPart = parts[1] ? parts[1].trim() : '';
        
        if (msg.direction === 'inbound') {
          content = textPart ? `${textPart}\n[Image sent]` : '[Image sent]';
        } else {
          if (/^data:/i.test(urlPart)) {
            content = textPart ? `${textPart}\n[Image sent]` : '[Image sent]';
          } else {
            content = textPart ? `${textPart}\n[Image sent]: ${urlPart}` : `[Image sent]: ${urlPart}`;
          }
        }
      }

      // Handle Files
      if (content.includes('[FILE:')) {
        const fileMatch = content.match(/\[FILE:(.*?)\]:?/);
        if (fileMatch) {
          const fileName = fileMatch[1] || 'document.pdf';
          const parts = content.split(fileMatch[0]);
          const textPart = parts[0].trim();
          content = textPart ? `${textPart}\n[File sent: ${fileName}]` : `[File sent: ${fileName}]`;
        }
      }
      
      // Handle JSON GIFs (fallback)
      if (content.startsWith('{') && content.endsWith('}')) {
        try {
          const parsed = JSON.parse(content);
          if (parsed.type === 'gif' && parsed.url) {
            content = `[GIF sent]: ${parsed.url}`;
          }
        } catch (e) {}
      }
      
      // Handle raw URLs that are media
      try {
        const url = new URL(content);
        const pathname = url.pathname.toLowerCase();
        const isTrustedDomain = (hostname: string, domain: string) => {
          return hostname === domain || hostname.endsWith('.' + domain);
        };
        if (pathname.match(/\.(gif)$/) || 
            (isTrustedDomain(url.hostname, 'giphy.com') && pathname.includes('/media/')) ||
            isTrustedDomain(url.hostname, 'media.tenor.com')) {
          content = `[GIF sent]: ${content}`;
        } else if (pathname.match(/\.(jpeg|jpg|png|webp)$/) || 
            isTrustedDomain(url.hostname, 'firebasestorage.googleapis.com')) {
          if (msg.direction === 'inbound') {
            content = '[Image sent]';
          } else {
            content = `[Image sent]: ${content}`;
          }
        }
      } catch (e) {}
      
      return `[${date}] ${sender}:\n${content}\n`;
    }).join('\n----------------------------------------\n\n');

    const fileName = `bytelight-chat-export-${new Date().toISOString().split('T')[0]}.txt`;

    try {
      try {
        const fileResult = await Filesystem.writeFile({
          path: fileName,
          data: formattedText,
          directory: Directory.Cache,
          encoding: Encoding.UTF8
        });

        await Share.share({
          title: 'Exported Chat',
          text: 'Here is the exported chat history.',
          url: fileResult.uri,
          dialogTitle: 'Share Chat Export'
        });
        return;
      } catch (capacitorErr) {
        // Fallback for web
        const blob = new Blob([formattedText], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 100);
      }
    } catch (e) {
      console.error('Failed to export chat:', e);
      setError('Failed to export chat. Please try again.');
      setTimeout(() => setError(null), 5000);
    }
  };

  // Persist metadata
  useEffect(() => {
    try {
      localStorage.setItem('bytelight_metadata', JSON.stringify(localMetadata));
    } catch (e) {
      console.error('Failed to save metadata to localStorage:', e);
    }
  }, [localMetadata]);


  const sendMessage = (content: string | unknown, _type: 'text' | 'gif' | 'voice' = 'text') => {
    // ChatInput sends an { text, attachments } object when media is attached —
    // the files are already uploaded to /api/files, so only a small reference
    // rides the WebSocket. Plain messages are still passed as a string.
    const isObjPayload = !!content && typeof content === 'object';
    const objPayload = isObjPayload ? (content as { text?: string; attachments?: unknown[]; metadata?: Record<string, unknown> }) : null;
    const hasAttachments = !!objPayload && Array.isArray(objPayload.attachments) && objPayload.attachments.length > 0;
    const hasMetadata = !!objPayload?.metadata && Object.keys(objPayload.metadata).length > 0;
    const replyId = replyTo?.id;
    setIsSending(true);
    try {
      if (hasAttachments || hasMetadata) {
        // Merge attachments and metadata into the single metadata blob
        // sendUserMessage forwards to the server. Backend keys we care
        // about: `attachments` (image refs) and `prosody` (Hume tone
        // scores, prepended to the agent prompt by the message hook).
        const metadata: Record<string, unknown> = { ...(objPayload?.metadata ?? {}) };
        if (hasAttachments) metadata.attachments = objPayload!.attachments;
        sendUserMessage(objPayload!.text || '', 'text', metadata, replyId);
      } else {
        const text = typeof content === 'string' ? content : String(content ?? '');
        if (!text.trim()) {
          setIsSending(false);
          return;
        }
        sendUserMessage(text, 'text', undefined, replyId);
      }
      setReplyTo(null);
    } catch (err) {
      console.error('[Bytelight] Send error:', err);
      setError('Failed to send. Check connection.');
      setTimeout(() => setError(null), 5000);
    } finally {
      setTimeout(() => setIsSending(false), 300);
    }
  };

  const deleteMessage = (id: string) => {
    ksDeleteMessage(id).catch((err) => {
      console.error('[Bytelight] Delete failed:', err);
      setError('Failed to delete. Try again.');
      setTimeout(() => setError(null), 5000);
    });
  };

  const handleReact = (messageId: string, emoji: string) => {
    const target = messages.find((m) => m.id === messageId);
    if (target?.reactions?.includes(emoji)) {
      removeReaction(messageId, emoji);
    } else {
      addReaction(messageId, emoji);
    }
  };

  // The bubble star is main's star for the human actor — shared with the
  // Svelte client and live across devices via message_starred/unstarred.
  const handleBookmark = (messageId: string) => {
    toggleStar(messageId).catch((err) => {
      console.error('[Bytelight] Star failed:', err);
      setError('Could not star that message.');
      setTimeout(() => setError(null), 5000);
    });
  };

  // Routes an app-registry entry to either a full-screen view or a modal.
  // Settings is the only modal-style app; everything else swaps the OS
  // into a full-screen view and closes back to its launch origin (closeApp).
  const openApp = (app: AppDef) => {
    if (app.kind === 'modal') {
      if (app.id === 'settings') {
        setShowSettings(true);
        // Switch to home so app drawer doesn't bleed through the modal
        setOsState('home');
      }
    } else if (app.screen) {
      const origin = osState === 'appdrawer' ? 'appdrawer' : 'home';
      // Remember where the app was opened from so its back button can
      // return there — apps live on the home grid or in the drawer and
      // the owner rearranges them freely.
      setAppReturnTo(origin);
      if (app.screen === 'messages') setMessagesReturnTo(origin);
      setOsState(app.screen);
    }
  };

  // Open the screen a page address asked for (launchPathApp), once.
  const launchPathOpened = useRef(false);
  useEffect(() => {
    if (!launchPathApp || launchPathOpened.current) return;
    launchPathOpened.current = true;
    openApp(launchPathApp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Back returns to wherever the app was launched from (home vs drawer).
  // Apps entered outside openApp() fall back to the last recorded origin.
  const closeApp = () => setOsState(appReturnTo);

  // The Android back gesture and the back button are the same event, and it is
  // the one that actually reaches her: gesture navigation owns BOTH screen edges
  // and hands the app a back event rather than a swipe. Without a listener here
  // Capacitor falls back to browser history, which this phone does not use for
  // navigation — so back did nothing, whichever edge she came in from.
  //
  // The native half of this is already inside the installed APK (capacitor-app
  // ships in it), so this is a web change and needs no new build.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let remove: (() => void) | undefined;
    void CapacitorApp.addListener('backButton', () => {
      if (showSettings) { setShowSettings(false); return; }
      if (osState === 'appdrawer') { setOsState('home'); return; }
      // Ask the innermost screen first. An app three pages deep gets to step
      // back one page instead of the whole thing shutting — see back-stack.
      if (runBackHandler()) return;
      if (osState !== 'home' && osState !== 'locked') { closeApp(); return; }
      // Nothing behind the home screen. Put the app away rather than closing it,
      // because a back press that quits is how a conversation gets lost.
      void CapacitorApp.minimizeApp();
    }).then((handle) => { remove = () => { void handle.remove(); }; });
    return () => { remove?.(); };
  }, [osState, showSettings, appReturnTo]);

  // Swipe in from the left edge to go back, as well as tapping the button.
  //
  // Navigation here is state rather than history, so there is nothing for a
  // browser gesture to walk — this listens for the shape of the gesture and
  // then does exactly what the back button does. It never calls preventDefault
  // and never captures, so a gesture it misreads still does whatever it was
  // always going to do; the worst case is a swipe that also closes an app,
  // rather than an app whose own scrolling has been taken away from it.
  //
  // Home and the drawer have nothing behind them, so the listener only
  // arms inside an app, and never while Settings is up — that modal has its own
  // way out and closing the app underneath it would be answering the wrong door.
  useEffect(() => {
    const insideApp = osState !== 'locked' && osState !== 'home' && osState !== 'appdrawer';
    // In the APK the SYSTEM takes an edge swipe before the WebView ever sees a
    // pointer — Android's gesture navigation owns both edges and turns the swipe
    // into a back event, which the listener below answers. So this one is for a
    // browser, where no such gesture exists. Running both would mean two things
    // answering one swipe.
    if (Capacitor.isNativePlatform()) return;
    if (!insideApp || showSettings) return;
    let start: { x: number; y: number; at: number } | null = null;
    const down = (e: PointerEvent) => {
      start = e.isPrimary ? { x: e.clientX, y: e.clientY, at: Date.now() } : null;
    };
    const up = (e: PointerEvent) => {
      const from = start;
      start = null;
      if (!from) return;
      if (isBackSwipe({
        startX: from.x,
        dx: e.clientX - from.x,
        dy: e.clientY - from.y,
        elapsedMs: Date.now() - from.at,
      })) {
        if (!runBackHandler()) closeApp();
      }
    };
    window.addEventListener('pointerdown', down, { passive: true });
    window.addEventListener('pointerup', up, { passive: true });
    window.addEventListener('pointercancel', () => { start = null; }, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
    };
  }, [osState, showSettings, appReturnTo]);


  // Slideshow Effect moved to AppBackground component

  // Local reactions overlay plus main's stars. Starred messages across
  // threads live in the Starred sheet, not an in-place filter.
  const starredBy = useStarredBy();
  const filteredMessages = useMemo(() => {
    return messages.map(msg => ({
      ...msg,
      ...localMetadata[msg.id],
      isBookmarked: isStarredByMe(starredBy, msg.id),
      status: (msg.direction === 'outbound' ? 'read' : (msg.read ? 'read' : 'delivered')) as 'read' | 'sent' | 'delivered'
    }));
  }, [messages, localMetadata, starredBy]);

  // The router broadcasts presence 'active' for the whole turn and 'dormant'
  // when it ends, so that — not the presence of a streaming placeholder — is the
  // authority on whether anyone is working. Without it, a mid-turn reply landing
  // as its own message cleared the placeholder and the room went silent-looking
  // while a build carried on underneath: no indicator, no stop button.
  const awaitingResponse = ksPresence === 'waking' || ksPresence === 'active'
    || (!!ksStreaming.messageId && !ksStreaming.tokens);
  const generating = ksIsStreaming || awaitingResponse;

  // Esc stops an in-progress generation.
  useEffect(() => {
    if (!generating) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stopGeneration();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [generating]);

  const activeTheme = withAccentOverride(THEMES[theme.id] || THEMES['monochrome'], theme.accentOverride, theme.accentPalette);
  const colors = activeTheme[theme.mode];
  const activeFontFamily = appSettings.fontFamily || activeTheme.fontFamily;

  // Bubble handlers read through a ref at call time so the memoized bubble
  // list below never holds stale closures (handleReact closes over messages,
  // scrollToMessageId over the accent color, etc.).
  const bubbleHandlersRef = useRef({ handleReact, handleBookmark, deleteMessage, setReplyTo, setError, scrollToMessageId, scrollToBottom });
  bubbleHandlersRef.current = { handleReact, handleBookmark, deleteMessage, setReplyTo, setError, scrollToMessageId, scrollToBottom };

  // The rendered bubble list is memoized so App re-renders that don't touch
  // message data (scroll-position state, streaming ticks, typing indicator,
  // toasts) skip re-splitting voices and re-parsing markdown for the whole
  // history — unchanged element references let React bail out of each
  // bubble's subtree entirely.
  const renderedMessages = useMemo(() => {
    const voiceRoster = threadCompanions.length > 0 ? threadCompanions : dbCompanions;
    return filteredMessages.flatMap((msg, index) => {
      const prev = index > 0 ? filteredMessages[index - 1] : null;
      const showDate =
        !prev ||
        new Date(prev.timestamp).toDateString() !== new Date(msg.timestamp).toDateString();
      const nodes: React.ReactNode[] = [];
      if (showDate) {
        nodes.push(
          <DateDivider
            key={`date-${msg.id}`}
            timestamp={msg.timestamp}
            themeConfig={activeTheme}
            themeMode={theme.mode}
          />,
        );
      }
      // Multi-voice companion replies split into one bubble per
      // speaking companion, each with its avatar. Headerless
      // messages (and all user messages) render as one bubble.
      const voiceSections = splitMessageVoices(msg, voiceRoster);
      // Segment-backed replies keep their rendered speech in text segments
      // rather than message.content. Copy the complete spoken reply while
      // deliberately excluding thought cards, tool pills, and recycle seams.
      const copyText = Array.isArray(msg.segments) && msg.segments.length > 0
        ? msg.segments
          .filter((segment) => segment.type === 'text')
          .map((segment) => segment.content)
          .join('')
          .trim()
        : (msg.content || '');
      const bubbleFor = (m: typeof msg, voice: any, pos: 'only' | 'first' | 'middle' | 'last', centered?: boolean) => (
        <MessageBubble
          message={m}
          voice={voice}
          voiceRoster={voiceRoster}
          groupPos={pos}
          centered={centered}
          onReact={(emoji) => bubbleHandlersRef.current.handleReact(msg.id, emoji)}
          onBookmark={() => bubbleHandlersRef.current.handleBookmark(msg.id)}
          onDelete={() => bubbleHandlersRef.current.deleteMessage(msg.id)}
          onEdit={async (newContent, rerun) => {
            try {
              await editMessage(msg.id, newContent, rerun);
            } catch (err) {
              console.error('[Bytelight] Edit failed:', err);
              bubbleHandlersRef.current.setError('Could not edit message.');
              setTimeout(() => bubbleHandlersRef.current.setError(null), 5000);
            }
          }}
          // How much a reroll would take with it. It soft-deletes from the
          // target message onward, so rerolling something from hours ago
          // clears the whole rest of the conversation — the number is the
          // difference between a confident tap and a mild panic attack.
          rerollRemoves={rerollCount(msg.id)}
          onReroll={async () => {
            try {
              await regenerateMessage(msg.id, rerollCount(msg.id));
            } catch (err) {
              console.error('[Bytelight] Regenerate failed:', err);
              bubbleHandlersRef.current.setError(
                err instanceof RerollChangedError ? err.message : 'Could not regenerate.',
              );
              setTimeout(() => bubbleHandlersRef.current.setError(null), 5000);
            }
          }}
          onReply={() => bubbleHandlersRef.current.setReplyTo(msg)}
          copyText={copyText}
          onJumpToReply={(id) => bubbleHandlersRef.current.scrollToMessageId(id)}
          themeConfig={activeTheme}
          themeMode={theme.mode}
          elevenLabsApiKey={elevenLabsApiKey}
          isPrivateTab={false}
          onMediaLoad={() => bubbleHandlersRef.current.scrollToBottom(true)}
          customEmojis={appSettings.customEmojis}
          userAvatar={ownerAvatar}
          userAvatarColor={appSettings.userAvatarColor}
        />
      );
      if (voiceSections && voiceSections.length > 0) {
        voiceSections.forEach((sec, vi) => {
          const pos = voiceSections.length === 1
            ? 'only'
            : vi === 0 ? 'first' : vi === voiceSections.length - 1 ? 'last' : 'middle';
          nodes.push(
            <motion.div
              key={`${msg.id}-${index}-v${vi}`}
              data-msg-id={vi === 0 ? msg.id : undefined}
              initial={{ opacity: 0, y: 10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.2 }}
            >
              {bubbleFor(
                { ...msg, content: sec.content, segments: sec.segments },
                sec.voice,
                pos,
                // Leading meta-only section (thinking/tool badges
                // before the first voice) → centered, no tail.
                sec.voice === null && !sec.content.trim(),
              )}
            </motion.div>,
          );
        });
      } else {
        nodes.push(
          <motion.div
            key={`${msg.id}-${index}`}
            data-msg-id={msg.id}
            initial={{ opacity: 0, y: 10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.2 }}
          >
            {bubbleFor(msg, undefined, 'only')}
          </motion.div>,
        );
      }
      return nodes;
    });
  }, [
    stickerCatalogRevision,
    filteredMessages,
    threadCompanions,
    dbCompanions,
    activeTheme,
    theme.mode,
    elevenLabsApiKey,
    appSettings.customEmojis,
    ownerAvatar,
    appSettings.userAvatarColor,
  ]);

  useEffect(() => {
    // Root font size drives every rem-based size in the UI. 16px is the
    // browser default Tailwind is designed against; the font-size setting
    // nudges it. Forcing 14px shrank the whole UI ~13% on every device.
    const sizeMap: Record<string, string> = { small: '14px', medium: '16px', large: '18px' };
    document.documentElement.style.fontSize = sizeMap[appSettings.fontSize || 'medium'] || '16px';
  }, [appSettings.fontSize]);

  // One semantic palette feeds every screen. Components still consume the
  // legacy utility-class contract, while shared surfaces/bubbles and loose
  // wallpaper text read these resolved values directly.
  useEffect(() => {
    const root = document.documentElement;
    const resolved = resolveThemeColors(colors);
    const customMode = theme.id === 'custom' ? theme.customColors?.[theme.mode] : undefined;
    const accentForContrast = customMode?.accent || resolved.accent;
    const userBubbleText = theme.id === 'custom'
      ? resolved.userBubbleText
      : contrastTextColor(resolved.userBubbleBg, theme.mode === 'dark' ? '#ffffff' : '#090807', resolved.pageBg);
    const compBubbleText = theme.id === 'custom'
      ? resolved.compBubbleText
      : contrastTextColor(resolved.compBubbleBg, theme.mode === 'dark' ? '#ffffff' : '#090807', resolved.pageBg);
    const gradientPoleForInk = (ink: string, fallbackInk: string) => {
      const resolvedInk = ink.startsWith('var(') ? fallbackInk : ink;
      const inkIsLight = contrastTextColor(resolvedInk, '#ffffff') === '#090807';
      return inkIsLight ? '#000000' : '#ffffff';
    };
    const customUserInk = customMode?.userBubbleText || (theme.mode === 'dark' ? '#09090B' : '#ffffff');
    const customCompInk = customMode?.compBubbleText || (theme.mode === 'dark' ? '#FAFAFA' : '#18181B');
    // On the custom theme, resolveThemeColors hands back `var(--custom-*)`
    // indirections rather than colours. That is fine for a plain background,
    // but color-mix() is invalid-at-computed-value-time if its colour argument
    // hasn't resolved yet — and an invalid color-mix drops the WHOLE
    // declaration, so a tile paints with no fill and no text. Feed the real
    // value through when we have it; same trick gradientPoleForInk already
    // uses on the ink side.
    const solid = (value: string, real?: string) =>
      real && value.startsWith('var(') ? real : value;

    root.style.setProperty('--scrollbar-thumb', solid(resolved.accent, customMode?.accent));
    root.style.setProperty('--scrollbar-track', theme.mode === 'dark' ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.1)');
    root.style.setProperty('--bytelight-accent', solid(resolved.accent, customMode?.accent));
    // The filled-button color rooms ported from Aerie paint with (Story Shelf,
    // Theater, …). Never defined here, so those buttons came out unpainted:
    // dark on dark. It is the theme's own accent.
    root.style.setProperty('--bytelight-selected-fill', solid(resolved.accent, customMode?.accent));
    root.style.setProperty('--bytelight-on-accent', contrastTextColor(accentForContrast, theme.mode === 'dark' ? '#090807' : '#ffffff'));
    root.style.setProperty('--bytelight-page', solid(resolved.pageBg, customMode?.pageBg));
    root.style.setProperty('--bytelight-header', theme.mode === 'light' ? '#ffffff' : solid(resolved.pageBg, customMode?.pageBg));
    root.style.setProperty('--bytelight-panel-base', solid(resolved.panelBg, customMode?.panelBg));
    root.style.setProperty('--bytelight-border', solid(resolved.panelBorder, customMode?.panelBorder));
    root.style.setProperty('--bytelight-text', resolved.textMain);
    root.style.setProperty('--bytelight-text-muted', resolved.textMuted);
    root.style.setProperty('--bytelight-user-bubble', solid(resolved.userBubbleBg, customMode?.userBubbleBg));
    root.style.setProperty('--bytelight-user-bubble-text', userBubbleText);
    root.style.setProperty('--bytelight-user-bubble-pole', gradientPoleForInk(
      theme.id === 'custom' ? customUserInk : userBubbleText,
      customUserInk,
    ));
    root.style.setProperty('--bytelight-comp-bubble', solid(resolved.compBubbleBg, customMode?.compBubbleBg));
    root.style.setProperty('--bytelight-comp-bubble-text', compBubbleText);
    root.style.setProperty('--bytelight-comp-bubble-pole', gradientPoleForInk(
      theme.id === 'custom' ? customCompInk : compBubbleText,
      customCompInk,
    ));
    root.style.setProperty('--bytelight-surface', `color-mix(in srgb, ${resolved.panelBg} 72%, transparent)`);
    root.style.setProperty('--bytelight-surface-strong', `color-mix(in srgb, ${resolved.panelBg} 90%, transparent)`);
    root.style.setProperty('--bytelight-hairline', resolved.panelBorder);
    root.style.setProperty('--bytelight-icon', `color-mix(in srgb, ${resolved.textMain} 90%, transparent)`);
    root.style.setProperty('--bytelight-label', `color-mix(in srgb, ${resolved.textMain} 82%, transparent)`);
    root.style.setProperty('--bytelight-loose-shadow', theme.mode === 'dark' ? 'rgba(0, 0, 0, 0.96)' : 'rgba(255, 255, 255, 0.96)');
    // Shape: the theme's radius class is the default, her slider overrides.
    // --shape-scale drives every rounded-* utility via the @theme tokens in
    // index.css, so the whole phone slides, not just the chat chrome.
    const shapeBase = theme.shapeRadius ?? themeRadiusPx((THEMES[theme.id] || THEMES.monochrome).radius);
    root.style.setProperty('--shape-scale', String(shapeBase / 16));
    for (const [k, v] of Object.entries(shapeVarsFor(shapeBase))) root.style.setProperty(k, v);
    // Skins layer atmosphere (aura, glow, glass) over ANY palette — the
    // BL model: the accent stays whatever she picked, the skin is the room.
    root.classList.toggle('skin-cosmos', theme.skin === 'cosmos');
    root.style.setProperty('--fx-aura', String((theme.fx?.aura ?? 100) / 100));
    root.style.setProperty('--fx-glow', String((theme.fx?.glow ?? 100) / 100));
    root.style.setProperty('--fx-motion', String((theme.fx?.motion ?? 100) / 100));
    // BL typography: a chosen preset pins the three font vars inline on <html>
    // (wins over the skin's class-level heading); unset lets the skin breathe.
    const preset = TYPOGRAPHY_PRESETS.find((t) => t.name === theme.typography);
    if (preset) {
      root.style.setProperty('--font-heading', fontStack(preset.heading));
      root.style.setProperty('--font-body', fontStack(preset.body));
      root.style.setProperty('--font-mono-choice', monoStack(preset.mono));
    } else {
      root.style.removeProperty('--font-heading');
      root.style.removeProperty('--font-body');
      root.style.removeProperty('--font-mono-choice');
    }
  }, [colors, theme.mode, theme.id, theme.customColors, theme.shapeRadius, theme.skin, theme.fx, theme.accentOverride, theme.accentPalette, theme.typography]);

  return (
    <div
      className={cn(
        // Pinned to the screen's edges rather than sized in viewport units:
        // after the keyboard closed, a 100svh height could hold the keyboard-up
        // height for a couple of seconds and leave a block of page color under
        // the message box. Edges follow the window the moment it changes.
        "bytelight-root fixed inset-0 flex flex-col overflow-hidden transition-colors duration-500",
        colors.pageBg,
        colors.textMain,
        activeFontFamily
      )}
      data-theme-mode={theme.mode}
      style={{ paddingBottom: 'var(--sab)' }}
    >
      {customThemeStyles && <style>{customThemeStyles}</style>}
      {/* Global Wallpaper Layer */}
      <AppBackground theme={theme} />
      {/* The Cosmos aura lives on the house itself, under every screen: the
          chat, the drawer and every app show it through their own glass.
          Painted only under .skin-cosmos (index.css). */}
      <div aria-hidden="true" className="bytelight-cosmos-aura pointer-events-none absolute inset-0 z-0" />

      {/* Bytelight auth gate — overlays everything when a passcode is required */}
      <BytelightLoginGate />

      {/* Mounted above every screen, so it only ever gets to draw a status dot
          out here. The failure text is hers to read inside the Studio — her
          call, Sep 1 2026, after an uncapped one covered the app drawer AND a
          thread AND the composer under it. */}
      <StudioJobTray onOpen={() => setOsState('studio')} inStudio={osState === 'studio'} />

      <AnimatePresence initial={false}>
        {osState === 'locked' && (
          <LockScreen
            key="locked"
            onUnlock={() => setOsState('home')}
            wallpaper={theme.lockScreenWallpaper || theme.wallpaper}
            face={lockFaceOf(theme.lockFace)}
            position={lockPositionOf(theme.lockClockPosition)}
            size={lockSizeOf(theme.lockClockSize)}
            shortcuts={lockShortcutsOf(theme.lockShortcuts).map((id) => (id ? APPS.find((a) => a.id === id) ?? null : null))}
            onOpenApp={(app) => { setOsState('home'); openApp(app); }}
            show={lockShowOf(theme.lockShow)}
            unread={lockUnread}
            faces={dbCompanions.slice(0, 3).map((c) => ({ url: c.avatar_url, color: c.color, name: c.display_name }))}
            messagesApp={APPS.find((a) => a.id === 'messages')}
            writers={dbCompanions.map((c) => ({ slug: c.slug, name: c.display_name, color: c.color, url: c.avatar_url }))}
            notesApp={APPS.find((a) => a.id === 'notes')}
            spotify={lockSpotifyOf(theme.lockSpotify)}
            spotifyApp={APPS.find((a) => a.id === 'spotify')}
            cards={lockCardsOf(theme.lockCards)}
            clockAt={lockClockAtOf(theme.lockClockAt, lockFaceOf(theme.lockFace))}
            onMoveClock={(at) => setTheme((prev) => ({ ...prev, lockClockAt: withClockAt(prev.lockClockAt, lockFaceOf(prev.lockFace), at) }))}
            weatherAt={lockWeatherAtOf(theme.lockWeatherAt)}
            onMoveWeather={(at) => updateTheme({ lockWeatherAt: at })}
            showClock={!lockHiddenOf(theme.lockHidden).has('clock')}
            showWeather={!lockHiddenOf(theme.lockHidden).has('weather')}
            onHide={(piece) => setTheme((prev) => ({ ...prev, lockHidden: withHidden(prev.lockHidden, piece, true) }))}
          />
        )}
        {osState === 'home' && !showSettings && (
          <HomeScreen
            key="home"
            onOpenApp={openApp}
            onOpenDrawer={() => setOsState('appdrawer')}
            onLock={() => setOsState('locked')}
            wallpaper={theme.wallpaper}
            themeConfig={activeTheme}
            themeMode={theme.mode}
            messagesBadge={totalUnread}
            dockApps={dockApps}
            widgets={homeWidgetsOf(theme.homeWidgets)}
            widgetSpots={homeSpotsOf(theme.homeWidgetSpots)}
            quietLine={!!theme.homeQuietLine}
            companions={dbCompanions.map((c) => ({ slug: c.slug, name: c.display_name, avatar: c.avatar_url, color: c.color }))}
            stickyNoteColors={theme.stickyNoteColors}
            themeAccent={theme.id === 'custom' ? theme.customColors?.[theme.mode]?.accent : undefined}
            onThemeChange={updateTheme}
          />
        )}
        {osState === 'appdrawer' && (
          <AppDrawer
            key="appdrawer"
            onClose={() => setOsState('home')}
            onOpenApp={openApp}
            themeConfig={activeTheme}
            themeMode={theme.mode}
          />
        )}
        {osState === 'status' && (
          <StatusApp
            key="status"
            onClose={closeApp}
            themeConfig={activeTheme}
            themeMode={theme.mode}
          />
        )}
        {osState === 'memory' && (
          <MemoryApp
            key="memory"
            onClose={closeApp}
            themeConfig={activeTheme}
            themeMode={theme.mode}
          />
        )}
        {osState === 'integrations' && (
          <IntegrationsApp
            key="integrations"
            onClose={closeApp}
            themeConfig={activeTheme}
            themeMode={theme.mode}
          />
        )}
        {osState === 'agent' && (
          <AgentApp
            key="agent"
            onClose={closeApp}
            // Integrations opens on Providers; back still returns to where Agent was opened from.
            onOpenIntegrations={() => setOsState('integrations')}
            themeConfig={activeTheme}
            themeMode={theme.mode}
          />
        )}
        {osState === 'packs' && (
          <PacksApp
            key="packs"
            onClose={closeApp}
            themeConfig={activeTheme}
            themeMode={theme.mode}
            onEmojisChanged={async () => {
              const merged = await syncEmojis(appSettings.customEmojis || []);
              setAppSettings((prev) => ({ ...prev, customEmojis: merged }));
              void refreshEmojiPacks();
            }}
          />
        )}
        {osState === 'commandcenter' && (
          <CommandCenterApp
            key="commandcenter"
            onClose={closeApp}
            themeConfig={activeTheme}
            themeMode={theme.mode}
          />
        )}
        {osState === 'xray' && (
          <XRayApp
            key="xray"
            onClose={closeApp}
            themeConfig={activeTheme}
            themeMode={theme.mode}
          />
        )}
        {osState === 'canvas' && (
          <CanvasApp
            key="canvas"
            onClose={() => { setCanvasOpenId(null); closeApp(); }}
            themeConfig={activeTheme}
            themeMode={theme.mode}
            openId={canvasOpenId}
            onSentToChat={() => { setCanvasOpenId(null); setOsState('messages'); }}
          />
        )}
        {osState === 'companions' && (
          <CompanionsApp
            key="companions"
            onClose={closeApp}
            themeConfig={activeTheme}
            themeMode={theme.mode}
          />
        )}
        {osState === 'weather' && (
          <WeatherApp
            key="weather"
            onClose={closeApp}
            themeConfig={activeTheme}
            themeMode={theme.mode}
          />
        )}
        {osState === 'journal' && (
          <JournalApp
            key="journal"
            onClose={closeApp}
            themeConfig={activeTheme}
            themeMode={theme.mode}
          />
        )}
        {osState === 'library' && (
          <LibraryApp
            key="library"
            onClose={closeApp}
            themeConfig={activeTheme}
            themeMode={theme.mode}
          />
        )}
        {osState === 'letters' && (
          <LettersApp
            key="letters"
            onClose={closeApp}
            themeConfig={activeTheme}
            themeMode={theme.mode}
          />
        )}
        {osState === 'games' && (
          <GamesApp
            key="games"
            onClose={closeApp}
            themeConfig={activeTheme}
            themeMode={theme.mode}
          />
        )}
        {osState === 'treehouse' && (
          <TreehouseApp
            key="treehouse"
            onClose={closeApp}
            themeConfig={activeTheme}
            themeMode={theme.mode}
            userAvatar={ownerAvatar}
            userAvatarColor={appSettings.userAvatarColor}
            ownerName={ownerName}
          />
        )}
        {osState === 'fieldnotes' && (
          <FieldNotesApp
            key="fieldnotes"
            onClose={closeApp}
            themeConfig={activeTheme}
            themeMode={theme.mode}
          />
        )}
        {osState === 'spotify' && (
          <SpotifyApp
            key="spotify"
            onClose={closeApp}
            themeConfig={activeTheme}
            themeMode={theme.mode}
          />
        )}
        {osState === 'notes' && (
          <NotesApp
            key="notes"
            onClose={closeApp}
            themeConfig={activeTheme}
            themeMode={theme.mode}
            stickyNoteColors={theme.stickyNoteColors}
            themeAccent={theme.id === 'custom' ? theme.customColors?.[theme.mode]?.accent : undefined}
            apiBase={apiBase}
            companionNames={Object.values(contacts).map(c => c.name)}
          />
        )}
        {osState === 'studio' && (
          <StudioApp
            key="studio"
            onClose={closeApp}
            // Same jump as Starred and search: leaves Studio for the message.
            onJumpToMessage={(threadId, messageId) => {
              void handleSearchSelect({ threadId, messageId } as SearchResult);
            }}
            themeConfig={activeTheme}
            themeMode={theme.mode}
          />
        )}
        {osState === 'artifacts' && (
          <ArtifactsApp
            key="artifacts"
            onClose={closeApp}
            themeConfig={activeTheme}
            themeMode={theme.mode}
          />
        )}
        {osState === 'files' && (
          <FilesApp
            key="files"
            onClose={closeApp}
            themeConfig={activeTheme}
            themeMode={theme.mode}
          />
        )}
        {osState === 'inbox' && (
          <InboxApp
            key="inbox"
            onClose={closeApp}
            themeConfig={activeTheme}
            themeMode={theme.mode}
          />
        )}
      </AnimatePresence>

      {/* Messages App (Always rendered but hidden if not active to preserve state) */}
      <div className={cn(
        "absolute inset-0 flex flex-col z-10 transition-opacity duration-300",
        osState === 'messages' ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
      )}>
        {/* Header */}
        <header
          className={cn(
            "bytelight-shell-header relative flex flex-col z-10 transition-all duration-500",
            // Daylight chrome is clean white so the header fuses with the
            // white status bar (original design); midnight keeps pageBg,
            // which matches the theme-color meta exactly.
            theme.mode === 'light' ? 'bg-white' : colors.pageBg
          )}
          style={{ paddingTop: 'var(--sat)' }}
        >
          <div className="flex flex-col px-4 sm:px-6 py-3 sm:py-4 gap-2 sm:gap-3">
            <div className="flex items-center justify-between">
              <div className="flex min-w-0 items-center gap-1 sm:gap-2">
                <button
                  onClick={() => { setOsState(messagesReturnTo); setMessagesReturnTo('home'); }}
                  className={cn(
                    "p-2 -ml-2 rounded-full transition-colors hover:bg-black/10 dark:hover:bg-white/10",
                    colors.textMuted
                  )}
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
                {/* BL's thread door: three lines, left side, opens the left
                    drawer. The centered name-pill trigger is gone. */}
                <button
                  onClick={() => setShowThreadSwitcher(true)}
                  className={cn(
                    "p-2 rounded-full transition-colors hover:bg-black/10 dark:hover:bg-white/10",
                    colors.textMuted
                  )}
                  aria-label="Threads"
                  title="Threads"
                >
                  <Menu className="h-5 w-5" />
                </button>
            </div>

            <div className="flex shrink-0 items-center gap-1 sm:gap-2">
              {isSearching ? (
                <motion.div 
                  initial={{ width: 0, opacity: 0 }} 
                  animate={{ width: 'auto', opacity: 1 }}
                  className={cn(
                    "flex items-center rounded-full px-4 py-2 border transition-all duration-300",
                    colors.panelBg,
                    colors.panelBorder
                  )}
                >
                  <Search size={16} className={cn("mr-2", colors.textMuted)} />
                  <input 
                    autoFocus
                    type="text"
                    placeholder={searchMode === 'semantic' ? 'Search by meaning...' : 'Search by keyword...'}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className={cn("bg-transparent border-none outline-none text-sm w-32 sm:w-56 font-medium", colors.textMain)}
                  />
                  <button
                    onClick={() => setSearchMode((mode) => mode === 'keyword' ? 'semantic' : 'keyword')}
                    className={cn('mx-2 h-7 w-7 rounded-full text-sm font-semibold', colors.textMuted)}
                    style={searchMode === 'semantic' ? { background: colors.accent, color: 'var(--bytelight-on-accent)' } : undefined}
                    title={searchMode === 'semantic' ? 'Semantic search. Switch to keyword.' : 'Keyword search. Switch to semantic.'}
                    aria-label="Toggle search mode"
                  >
                    {searchMode === 'semantic' ? '✦' : '#'}
                  </button>
                  <button onClick={() => { setIsSearching(false); setSearchQuery(''); }}>
                    <X size={16} className={cn("hover:opacity-100 transition-colors opacity-60", colors.textMain)} />
                  </button>
                </motion.div>
              ) : (
                <>
                  <button 
                    onClick={() => setIsSearching(true)}
                    className={cn("p-2 sm:p-2.5 rounded-full transition-all opacity-60 hover:opacity-100", colors.textMuted)}
                    title="Search"
                  >
                    <Search size={20} strokeWidth={1.5} />
                  </button>
                  <button 
                    onClick={() => setShowStarred(!showStarred)}
                    className={cn("p-2 sm:p-2.5 rounded-full transition-all flex items-center justify-center", showStarred ? `opacity-100 ${colors.accentText}` : `opacity-60 hover:opacity-100 ${colors.textMuted}`)}
                    style={{ color: showStarred ? (theme.id === 'monochrome' ? (theme.mode === 'light' ? '#000000' : '#ffffff') : colors.accent) : undefined }}
                    title="Starred"
                  >
                    <Star size={20} strokeWidth={1.5} fill={showStarred ? "currentColor" : "none"} />
                  </button>
                  <button
                    onClick={() => exportChat('main')}
                    disabled={!activeThread || messages.length === 0}
                    className={cn("p-2 sm:p-2.5 rounded-full transition-all opacity-60 hover:opacity-100 disabled:opacity-30", colors.textMuted)}
                    title="Export this thread"
                  >
                    <Download size={20} strokeWidth={1.5} />
                  </button>
                  {ksConnection !== 'connected' && (
                    // Tappable on purpose: when this pill is on screen she is
                    // already waiting behind it, and closing the whole app was
                    // the only way to ask for a retry sooner than the backoff.
                    <button
                      onClick={() => proveAliveOrReconnect()}
                      className={cn(
                        'flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-bold uppercase tracking-wider transition-opacity active:opacity-60',
                        colors.panelBorder,
                      )}
                      style={{ color: colors.accent }}
                      title={`WebSocket: ${ksConnection} — tap to reconnect now`}
                    >
                      <WifiOff size={11} />
                      {ksConnection === 'reconnecting' ? '…' : 'offline'}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
                {/* Faces and the room's name get their own row, left-aligned.
                    The card's only door. Repointed to the Companions screen on Jun 9 2026
                    during the header overhaul, which left ContactInfo rendered behind a
                    switch nothing could turn on — unreachable for eleven weeks. It belongs
                    here: the faces at the top of a conversation open the people in it. The
                    Companions screen is still in the app drawer. */}
                <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center justify-start gap-3 sm:gap-4 cursor-pointer group" onClick={() => setShowContactInfo(true)}>
              <div className="relative flex shrink-0 -space-x-2 sm:-space-x-3">
                {(threadCompanions.length > 0 ? threadCompanions : dbCompanions.length > 0 ? dbCompanions : Object.values(contacts)).map((c: any, index: number) => (
                  <div 
                    key={c.id || c.slug || index}
                    className="w-8 h-8 sm:w-10 sm:h-10 rounded-full flex items-center justify-center overflow-hidden transition-all duration-500 group-hover:scale-110 border-2"
                    style={{ 
                      backgroundColor: (c.color || colors.accent) + '22',
                      borderColor: c.color || colors.accent,
                      zIndex: 10 - index,
                      transform: `rotate(${index % 2 === 0 ? 3 : -3}deg)`
                    }}
                  >
                    {c.avatar_url || c.image ? (
                      <img src={c.avatar_url || c.image} className="w-full h-full object-cover" alt={c.display_name || c.name} />
                    ) : (
                      <span className="text-sm">{c.emoji || '💬'}</span>
                    )}
                  </div>
                ))}
                <span 
                  className={cn(
                    "absolute bottom-0 right-0 w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full border-2 z-20",
                    theme.id === 'monochrome' && theme.mode === 'light' ? "border-black" : "border-white dark:border-neutral-900"
                  )} 
                  style={{ backgroundColor: theme.id === 'monochrome' && theme.mode === 'light' ? 'white' : colors.accent }}
                />
              </div>
              {!isSearching && (
                <motion.div className="min-w-0" initial={{ opacity: 0, x: -5 }} animate={{ opacity: 1, x: 0 }}>
                  <h1
                    className="text-xl sm:text-2xl italic tracking-tight leading-none truncate"
                    style={{ color: 'var(--bytelight-accent)', fontFamily: 'var(--font-heading, inherit)' }}
                  >
                    {activeThread?.name || appSettings.groupChatName || 'Bytelight'}
                  </h1>
                </motion.div>
              )}
            </div>
                </div>
        </div>
        
        {!isSearching && (
          <div className="w-full flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 pb-3 sm:pb-4 px-4">
            <ModelPill themeConfig={activeTheme} themeMode={theme.mode} />
            <RateLimitBanner themeConfig={activeTheme} themeMode={theme.mode} />
            <ContextIndicator themeConfig={activeTheme} themeMode={theme.mode} />
          </div>
        )}
        {showStarred && !isSearching && (
          <StarredSheet
            onSelect={(threadId, messageId) => {
              setShowStarred(false);
              void handleSearchSelect({ threadId, messageId } as SearchResult);
            }}
            onClose={() => setShowStarred(false)}
            themeConfig={activeTheme}
            themeMode={theme.mode}
          />
        )}
        {isSearching && searchQuery.trim() && (
          <SearchResults
            query={searchQuery}
            results={searchResults}
            total={searchTotal}
            loading={searchLoading}
            onSelect={handleSearchSelect}
            themeConfig={activeTheme}
            themeMode={theme.mode}
          />
        )}
      </header>

      <CompactionBanner themeConfig={activeTheme} themeMode={theme.mode} />

      {/* Message Thread */}
      <main ref={scrollContainerRef} className="bytelight-wallpaper-text flex-1 overflow-y-auto overflow-x-hidden px-4 py-6 scrollbar-hide relative z-1">
        <div className="max-w-4xl mx-auto min-h-full flex flex-col">
          {isLoading && messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center flex-1 py-20 opacity-40">
              <Loader2 className="animate-spin mb-2" size={32} />
              <p className="text-sm">Connecting to byte-light...</p>
            </div>
          ) : filteredMessages.length === 0 ? (
            <div className="flex flex-col items-center justify-end flex-1 pb-4 text-center px-10">
              <div className={cn(
                "w-16 h-16 rounded-full flex items-center justify-center mb-4",
                theme.mode === 'dark' ? "bg-[#2A2A2A]" : "bg-black/5"
              )}>
                {searchQuery ? <Search className="text-gray-500" size={32} /> : <Smartphone className="text-gray-500" size={32} />}
              </div>
              <h2 className={cn("text-xl font-medium mb-2", colors.textMain)}>{searchQuery ? 'No results found' : 'No messages yet'}</h2>
              {searchQuery && (
                <p className={cn("text-sm max-w-xs mb-8", colors.textMuted)}>
                  We couldn't find any messages matching "{searchQuery}"
                </p>
              )}
            </div>
          ) : (
            <div className="flex-1 flex flex-col justify-end">
              <AnimatePresence initial={false}>
                {renderedMessages}


                <StreamingReply themeConfig={activeTheme} themeMode={theme.mode} />

                {(ksIsStreaming || awaitingResponse) && !isSending && (
                  <TypingIndicator
                    key="typing-indicator"
                    themeConfig={activeTheme}
                    themeMode={theme.mode}
                  />
                )}
              </AnimatePresence>
            </div>
          )}
        </div>
      </main>

      {/* Error Toast */}
      {error && (
        <div 
          className={cn("fixed bottom-24 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full text-xs font-medium z-50 backdrop-blur-sm opacity-90", colors.userBubbleText)}
          style={{ backgroundColor: colors.accent }}
        >
          {error}
        </div>
      )}

      {/* Input Area */}
      <ChatInput
        onSend={sendMessage}
        onError={(err) => {
          setError(err);
          setTimeout(() => setError(null), 5000);
        }}
        giphyApiKey={giphyApiKey}
        disabled={isSending}
        themeConfig={activeTheme}
        themeMode={theme.mode}
        customEmojis={appSettings.customEmojis}
        emojiPacks={emojiPacks}
        sendIconId={appSettings.sendIconId}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        threadId={ksActiveThreadId}
        isAtBottom={isAtBottom}
        onJumpToLatest={() => {
          if (ksIsViewingAround && ksActiveThreadId) {
            // We're viewing a search-around window — reload the thread to get
            // the actual latest messages, then scroll to bottom.
            loadThread(ksActiveThreadId).then(() => scrollToBottom(true, true));
          } else {
            scrollToBottom(false, true);
          }
        }}
        generating={generating}
        onStopGeneration={() => stopGeneration()}
        voiceConversationActive={!!voiceSession}
        onStartVoiceConversation={ksActiveThreadId ? beginVoiceConversation : undefined}
      />

      </div>

      {/* Thread switcher — slides in over the Messages app */}
      <ThreadSwitcher
        isOpen={showThreadSwitcher}
        onClose={() => setShowThreadSwitcher(false)}
        themeConfig={activeTheme}
        themeMode={theme.mode}
        companions={dbCompanions}
      />

      {/* Voice belongs to the whole phone, not only the Messages screen.
          When minimized it can ride above Studio and every other
          Bytelight room; restoring returns her to the thread that owns the call. */}
      <VoiceModeOverlay
        open={!!voiceSession}
        minimized={voiceMinimized}
        threadId={voiceSession?.threadId ?? null}
        threadName={voiceSession?.threadName}
        companions={threadCompanions.length > 0 ? threadCompanions : dbCompanions}
        themeConfig={activeTheme}
        themeMode={theme.mode}
        onSend={sendVoiceConversationTurn}
        onClose={closeVoiceConversation}
        onMinimize={() => setVoiceMinimized(true)}
        onRestore={() => {
          setOsState('messages');
          setVoiceMinimized(false);
        }}
      />

      {/* Modals (Moved outside so they overlay the entire OS) */}
      <AnimatePresence>
        {showSettings && (
          <SettingsDashboard
            theme={theme}
            appSettings={appSettings}
            onThemeChange={updateTheme}
            onSettingsChange={updateAppSettings}
            onClose={() => {
              setShowSettings(false);
              setOsState('appdrawer');
            }}
          />
        )}
        {showContactInfo && (
          <ContactInfo 
            themeConfig={activeTheme} 
            themeMode={theme.mode}  contacts={contacts} onUpdateContact={updateContact}
            initialRows={dbCompanions}
            userAvatar={ownerAvatar}
            userAvatarColor={appSettings.userAvatarColor}
            onClose={() => setShowContactInfo(false)} 
          />
        )}
      </AnimatePresence>
    </div>
  );
}
