import { ThemeMode, ThemeId } from './lib/theme';
import type { MessageSegment } from './bytelight/protocol';

export type { ThemeMode, ThemeId };

/** One archived memory that surfaced on a turn (the shimmer panel's row). */
export interface SurfacedCard {
  excerpt: string;
  date?: string;
  domain?: string;
  relevance?: number;
}

/**
 * The shiver — what ambient recall surfaced on a reply.
 *
 * `cards` are memories that actually rode the turn. `dejavu` is the
 * source-veiled near-miss: something felt familiar but nothing surfaced
 * clearly enough to show. Either alone is enough to draw the chip.
 */
export interface SurfacedMemory {
  cards: SurfacedCard[];
  dejavu: boolean;
}

export interface Message {
  id: string;
  timestamp: string;
  direction: 'inbound' | 'outbound';
  content: string;
  read: number;
  type?: 'text' | 'gif' | 'voice';
  reactions?: string[];
  isBookmarked?: boolean;
  status?: 'sent' | 'delivered' | 'read';
  /** The house talking rather than a companion — a slash-command result, a
   *  refusal notice, a timeout. Rendered centred and quiet so it cannot be
   *  mistaken for something one of them said. */
  isSystem?: boolean;
  sender?: string;
  /** A guest's own picture from the platform they came through, when it was
   *  captured. Absent is ordinary — an older message predates us storing it,
   *  and the rail falls back to their initial. */
  senderAvatar?: string;
  // Platform the message arrived through when it wasn't the phone itself
  // (currently 'Discord'). Guest messages pair this with sender for the
  // name label; the owner's own bridged messages show it as a badge.
  via?: string;
  // Slug of the companion who authored this message, when the backend
  // recorded one (per-companion sends). Lets the chat
  // attach the right avatar even without an in-text voice header.
  companionSlug?: string;
  // Who wrote this companion message, as stamped by the house: 'companion-a' or
  // 'companion-b' for a reply from his own lane (The Room), 'companion-c' for Companion C,
  // 'companion-a-b' for the shared lane. A single companion's stamp draws the
  // whole message as his bubble; the shared stamp splits by the speaker headers.
  companionId?: string;
  // Interleaved text/tool/thinking segments for finalized companion replies.
  segments?: MessageSegment[];
  // The shiver — ambient recall that rode this reply, when any did.
  surfacedMemory?: SurfacedMemory;
  // Inline sentinels ([IMG]:/[FILE:]) synthesized from metadata.attachments.
  // Already appended to `content`; kept separately so the voice splitter can
  // re-attach them when it rebuilds per-voice content from segments.
  attachmentTail?: string;
  // Preview text of the message this one is replying to (server-rendered).
  replyToPreview?: string;
  // Id of the message this one is replying to.
  replyToId?: string;
  // ISO timestamp the message was last edited, or undefined if pristine.
  editedAt?: string;
  // Spoken text for voice notes (type === 'voice') — backend stores it
  // on metadata.transcript when sc voice is invoked. Lets the bubble
  // show what was said alongside the play button.
  transcript?: string;
  // True when the message was sent via voice-to-text (speech input, not a
  // voice note recording). Lets the bubble show a mic icon so the companions
  // can see her speaking cadence.
  isVoiceInput?: boolean;
  // Hume prosody scores from the voice input, when available. Top 3 perceived
  // vocal expressions (e.g. { Amusement: 0.8, Interest: 0.6 }).
  prosody?: Record<string, number>;
}

export interface SendMessageRequest {
  content: string;
}

export interface AppTheme {
  mode: ThemeMode;
  id: ThemeId;
  skin?: 'none' | 'cosmos'; // atmosphere layer over any palette (BL skins)
  fx?: { aura?: number; glow?: number; motion?: number }; // skin effect intensity, percent (100 = default)
  accentOverride?: string | null; // BL accent model: custom hex beats everything
  accentPalette?: string | null; // BL named accent (ACCENT_PALETTES), mode-aware
  typography?: string | null; // BL typography preset name (TYPOGRAPHY_PRESETS)
  wallpaper?: string; // Base64 or URL (Single)
  lockScreenWallpaper?: string; // Base64 or URL for lock screen (falls back to wallpaper)
  wallpapers?: string[]; // Array of Base64 or URLs for slideshow
  slideshowEnabled?: boolean;
  customColors?: {
    light: Record<string, string>;
    dark: Record<string, string>;
  };
  stickyNoteColors?: string[];
  // Her shape slider — overrides the theme's radius token when set. The token
  // came across from the operator's theme system with the control left upstream; this
  // is the handle, put back on. undefined = follow the theme.
  shapeRadius?: number;
  // The lock screen's clock: the face, and for the classic face where it
  // sits and how big it is. Unset is today's clock, so nothing moves until one
  // is picked; lib/lock-clock.ts reads them.
  lockFace?: 'stacked' | 'dateline' | 'classic';
  lockClockPosition?: 'top' | 'middle' | 'low';
  lockClockSize?: 's' | 'm' | 'l';
  // Where each face's clock was held and dragged to, as the middle of the
  // clock in fractions of the screen. A face with no entry sits in its own
  // place (lockClockAtOf in lib/lock-clock.ts).
  lockClockAt?: Partial<Record<'stacked' | 'dateline' | 'classic', { x: number; y: number }>>;
  // Where the weather pill was dragged, the same way; one spot for every face
  // that shows it. Unset is its corner, top right (lockWeatherAtOf).
  lockWeatherAt?: { x: number; y: number };
  // What has been tucked away off the lock screen, by dragging it up into the
  // strip at the top or with its chip in Settings (lockHiddenOf). Unset is
  // nothing hidden.
  lockHidden?: ('clock' | 'weather')[];
  // The two corner shortcuts, left then right (app ids; null is an emptied
  // corner), and what the message card may show.
  lockShortcuts?: [string | null, string | null];
  lockShow?: 'names' | 'first-line' | 'nothing';
  // The Spotify card on the lock screen while a song is playing or paused.
  // Unset is on; false is the owner's switch in Settings (lockSpotifyOf in
  // lib/lock-spotify.ts).
  lockSpotify?: boolean;
  // How the lock screen's cards look: dark, light (for a light wallpaper), or
  // auto, read off the wallpaper behind them. Unset is dark (lockCardsOf in
  // lib/lock-cards.ts).
  lockCards?: 'dark' | 'light' | 'auto';
  // The home widgets, and the quiet line on the dock (lib/home-widgets.ts).
  // Unset is none, so the home screen stays as it was.
  homeWidgets?: ('companions' | 'note' | 'weather' | 'letter' | 'day' | 'status' | 'soundtrack')[];
  // Where each widget sits on the four-wide grid once any has been moved: its
  // left column and its bottom row, row 0 nearest the dock. Unset is the way
  // the grid always packed them (layoutWidgets in lib/home-widgets.ts).
  homeWidgetSpots?: Partial<Record<'companions' | 'note' | 'weather' | 'letter' | 'day' | 'status' | 'soundtrack', { col: number; row: number }>>;
  homeQuietLine?: boolean;
}

export interface ContactProfile {
  name: string;
  image: string; // Base64 or URL
  bio: string;
  status: string;
  phone: string;
  voiceId?: string;
}

export interface CustomEmoji {
  id: string;
  shortcode: string;
  url: string; // Base64
  pack_id?: string | null;
}

export interface EmojiPack {
  id: string;
  name: string;
}

export interface AppSettings {
  theme: AppTheme;
  contacts: Record<string, ContactProfile>;
  groupChatName?: string;
  osName?: string;
  fontFamily?: string;
  fontSize?: 'small' | 'medium' | 'large';
  workerUrl?: string;
  backendUrl?: string;
  pushRelayUrl?: string;
  pushNotificationsEnabled?: boolean;
  giphyApiKey?: string;
  elevenLabsApiKey?: string;
  customEmojis?: CustomEmoji[];
  // Ordered list of app IDs to show on the home-screen dock. If unset,
  // HomeScreen falls back to the default DOCK_APPS from the registry.
  // Capped at 4 entries by the settings UI but the read path tolerates
  // any length.
  dockAppIds?: string[];
  // Icon shown on the chat-input send button. Maps to the SEND_ICONS
  // table in lib/sendIcons.ts; falls back to the paper-plane default.
  sendIconId?: string;
  // The owner's own bubble avatar (small base64 data URL) and ring color,
  // shown beside her messages in main chat — the user-side counterpart of
  // the companion voice avatars. Syncs with the rest of appSettings.
  userAvatar?: string;
  userAvatarColor?: string;
}
