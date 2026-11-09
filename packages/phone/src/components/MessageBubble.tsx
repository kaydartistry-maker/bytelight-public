import React, { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { format } from 'date-fns';
import { cn } from '../lib/utils';
import { Message, ThemeMode, ContactProfile, CustomEmoji } from '../types';
import { ThemeConfig, contrastTextColor, resolveThemeColors } from '../lib/theme';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { CodeBlock } from './CodeBlock';
import { Check, CheckCheck, Star, Heart, Smile, ThumbsUp, MoreHorizontal, Trash2, Play, Square, Loader2, Mic, FileText, Download, Pencil, RefreshCw, Copy, Reply, X, Volume2, Plus } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { MessageSegments } from './MessageSegments';
import { SpeakerBubbles, SpeakerSegmentStack } from './SpeakerBubbles';
import { splitBySpeaker, splitInterleaved, wholeSpeakerFor, interleavedAs } from '../lib/speakers';
import { ImageLightbox } from './ImageLightbox';
import { resolveStickerRef, apiFetch } from '../bytelight';
import { copyToClipboard } from '../lib/clipboard';
import { fileBlockIsHref, houseFileLink, resolveMessageHref } from '../lib/message-links';
import { cleanForTTS } from '../lib/tts';
import { STANDARD_EMOJIS as EXTRA_EMOJIS } from '../lib/emoji';
import type { VoiceCompanion } from '../lib/voices';
import { saveToDevice } from '../lib/download';
import { thumbSrc } from '../lib/thumb';
import { prepareChatText } from '../lib/chat-text';

/**
 * A link in a message that points at something this house is serving. Nothing
 * in here navigates — readable text opens IN the bubble, and anything else
 * goes out through saveToDevice, which asks the server for a
 * Content-Disposition header and lets the shell's download listener take it.
 * Why that matters is written where the classifying happens: lib/message-links.
 */
const HouseFileLink = ({ href, label, textish }: { href: string; label: string; textish: boolean }) => {
  const [body, setBody] = useState<string | null>(null);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'error'>('idle');
  const [copied, setCopied] = useState(false);
  const MAX = 400_000;

  const openIt = async () => {
    if (!textish) { saveToDevice(href); return; }
    if (body !== null) { setBody(null); return; }
    setPhase('loading');
    try {
      const res = await apiFetch(href);
      if (!res.ok) throw new Error(String(res.status));
      const text = await res.text();
      setBody(text.length > MAX ? `${text.slice(0, MAX)}\n\n… truncated here. Save it to read the rest.` : text);
      setPhase('idle');
    } catch {
      setPhase('error');
    }
  };

  return (
    <span className="inline-block w-full">
      <button
        type="button"
        onClick={openIt}
        className="inline-flex max-w-full items-baseline gap-1.5 text-left underline underline-offset-2 active:opacity-60"
      >
        <FileText size={13} className="shrink-0 opacity-70" />
        <span className="break-all">{label}</span>
      </button>
      {phase === 'loading' && <span className="ml-1.5 text-[11px] opacity-60">opening…</span>}
      {phase === 'error' && (
        <span className="ml-1.5 text-[11px] opacity-70">
          couldn’t read it —{' '}
          <button type="button" className="underline" onClick={() => saveToDevice(href)}>save it instead</button>
        </span>
      )}
      {body !== null && (
        <span className="mt-2 block rounded-lg border border-white/10 bg-black/20">
          <span className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-[11px] opacity-70">
            <span className="truncate">{label}</span>
            <span className="flex shrink-0 items-center gap-2">
              <button type="button" className="underline" onClick={async () => setCopied(await copyToClipboard(body))}>
                {copied ? 'copied' : 'copy'}
              </button>
              <button type="button" className="underline" onClick={() => saveToDevice(href)}>save</button>
              <button type="button" className="underline" onClick={() => setBody(null)}>close</button>
            </span>
          </span>
          <span className="block max-h-[320px] overflow-auto whitespace-pre-wrap break-words px-2.5 pb-2.5 font-mono text-[11px] leading-snug">
            {body}
          </span>
        </span>
      )}
    </span>
  );
};

// `src` is what gets DRAWN — often a thumbnail, because a bubble is a couple
// of hundred pixels wide. `fullSrc` is the real picture, and it is what a
// hold-to-save and a tap-to-open must both reach for; saving the small copy
// would put the thumbnail in her camera roll.
const LongPressImage = ({ src, fullSrc, alt, className, onLoad, onShortTap, ...props }: any) => {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);
  const original = fullSrc ?? src;

  const startPress = () => {
    longPressFiredRef.current = false;
    timerRef.current = setTimeout(() => {
      longPressFiredRef.current = true;
      if (original) {
        // Ask the server for the file rather than the view. The blob round
        // trip was one thing in the way; the other is that Android's WebView
        // ignores a link's download attribute, so the header is what decides.
        saveToDevice(original);
      }
    }, 500);
  };

  const cancelPress = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const handleClick = (e: React.MouseEvent) => {
    // Suppress the short-tap action if the long-press fired so a download
    // doesn't immediately follow up with a lightbox open.
    if (longPressFiredRef.current) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (onShortTap && original) {
      e.stopPropagation();
      onShortTap(original);
    }
  };

  return (
    <img
      src={src}
      alt={alt}
      // A hold has to reach us rather than Android's own text-selection and
      // image-drag handling, or the timer never gets to fire.
      className={cn('select-none [-webkit-touch-callout:none]', className)}
      onTouchStart={startPress}
      onTouchEnd={cancelPress}
      onTouchMove={cancelPress}
      onMouseDown={startPress}
      onMouseUp={cancelPress}
      onMouseLeave={cancelPress}
      onClick={handleClick}
      referrerPolicy="no-referrer"
      decoding="async"
      onLoad={onLoad}
      {...props}
    />
  );
};

interface MessageBubbleProps {
  message: Message;
  onReact?: (emoji: string) => void;
  onBookmark?: (messageId: string) => void;
  onDelete?: () => void;
  onEdit?: (newContent: string, rerun: boolean) => Promise<void> | void;
  onReroll?: () => Promise<void> | void;
  /** How many messages a reroll would remove, this one included. Shown in the
   *  confirmation, because reroll's blast radius is everything after the
   *  message you tapped and nothing on screen said so. */
  rerollRemoves?: number;
  onReply?: () => void;
  onCopy?: () => void;
  // Multi-voice replies render as several virtual bubbles, but their actions
  // still belong to the original message. The parent supplies the complete
  // spoken text so the last bubble can copy the whole reply.
  copyText?: string;
  onJumpToReply?: (id: string) => void;
  themeConfig: ThemeConfig;
  themeMode: ThemeMode;
  elevenLabsApiKey?: string;
  contacts?: Record<string, ContactProfile>;
  /** Companion roster for per-speaker faces on split bubbles (same list the
   *  voice rail reads — slug/display_name/avatar_url/color/emoji). */
  voiceRoster?: Array<{ slug: string; display_name: string; avatar_url: string | null; color: string | null; emoji: string | null }>;
  isPrivateTab?: boolean;
  onMediaLoad?: () => void;
  customEmojis?: CustomEmoji[];
  // Multi-voice rendering: which companion this bubble speaks as (shows the
  // avatar rail) and where the bubble sits in its voice group — non-last
  // bubbles hide the timestamp/reactions so the group reads as one turn.
  voice?: VoiceCompanion | null;
  groupPos?: 'only' | 'first' | 'middle' | 'last';
  // The owner's avatar + ring color, mirrored on the right of her bubbles.
  userAvatar?: string;
  userAvatarColor?: string;
  // Meta-only preamble bubbles (leading thinking/tool badges before the
  // first voice) render centered with no speech-bubble tail.
  centered?: boolean;
}

const EMOJIS = ['❤️', '👍', '🔥', '😂', '😮'];

// ElevenLabs Voice IDs
// `?.` so the bubble also renders outside Vite (components/room-table-faces.test.ts).
const ELEVENLABS_API_KEY = import.meta.env?.VITE_ELEVENLABS_API_KEY || "";

export function MessageBubble({ message, onReact, onBookmark, onDelete, onEdit, onReroll, rerollRemoves, onReply, onCopy, copyText, onJumpToReply, themeConfig, themeMode, elevenLabsApiKey, contacts, voiceRoster, isPrivateTab, onMediaLoad, customEmojis, voice, groupPos = 'only', userAvatar, userAvatarColor, centered }: MessageBubbleProps) {
  const [showReactions, setShowReactions] = useState(false);
  const [showCustomReactions, setShowCustomReactions] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // A guest's picture lives on someone else's CDN and can stop answering.
  // Falling back to their initial keeps a broken image out of the rail.
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [showRerollConfirm, setShowRerollConfirm] = useState(false);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null);
  // Kept around after playback so the user can re-tap Download.
  const [audioBlobUrl, setAudioBlobUrl] = useState<string | null>(null);
  // Revoke any retained blob URL when the bubble unmounts.
  React.useEffect(
    () => () => {
      if (audioBlobUrl) URL.revokeObjectURL(audioBlobUrl);
    },
    [audioBlobUrl],
  );
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const [lightboxState, setLightboxState] = useState<{ images: string[]; index: number } | null>(null);

  // Copy a string to the clipboard. Falls back to a hidden textarea +
  // execCommand for non-secure contexts (the phone is often served over plain
  // HTTP on the LAN, which disables navigator.clipboard).
  const copyToClipboard = async (text: string) => {
    if (!text) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const el = document.createElement('textarea');
        el.value = text;
        el.style.position = 'fixed';
        el.style.opacity = '0';
        document.body.appendChild(el);
        el.focus();
        el.select();
        try { document.execCommand('copy'); } finally { document.body.removeChild(el); }
      }
      onCopy?.();
    } catch (err) {
      console.warn('Copy failed', err);
    }
  };
  
  const isUser = message.direction === 'inbound';
  const segments = !isUser ? message.segments : undefined;
  const hasSegments = Array.isArray(segments) && segments.length > 0;

  // --- The shiver: surfaced-memory shimmer --------------------------------
  // Ambient recall that rode this reply (backend whisper → message metadata).
  // A quiet glint you can ignore or tap to see what surfaced. Déjà vu is its
  // own fainter variant: something felt, nothing shown. Companion side only —
  // her own messages never carry recall.
  const surfacedMemory = !isUser ? message.surfacedMemory : undefined;
  const surfacedCards = surfacedMemory?.cards ?? [];
  const hasShimmer = !!surfacedMemory && (surfacedCards.length > 0 || surfacedMemory.dejavu);
  const isDejavuOnly = !!surfacedMemory?.dejavu && surfacedCards.length === 0;
  const [shimmerOpen, setShimmerOpen] = useState(false);
  const colors = themeConfig[themeMode];
  const mode = themeMode;
  const apiKey = elevenLabsApiKey || ELEVENLABS_API_KEY;
  
  let isGif = false;
  let isImage = false;
  let isVoice = false;
  let isFile = false;
  let fileName = '';
  let fileContent = '';
  let mediaUrl = '';
  // Multi-attachment: a single message can carry several [IMG]: sentinels
  // (the adapter appends one per metadata.attachment). We surface them as
  // a list and render a small grid; mediaUrl above stays populated with
  // the first one so the legacy single-image rendering paths still work.
  const mediaUrls: string[] = [];
  let textContent = (message.content || '').trim();

  // Discord raw-syntax cleanup for bridged messages (render-time, so it's
  // retroactive across history): mention tokens like <@id> render as noise —
  // drop user/role/channel refs, and turn custom emotes <a:name:id> into
  // inline images straight off the Discord CDN (gif when animated, png
  // otherwise; the demoji: branch of the img renderer sizes them like
  // emotes). New ingests also resolve mentions server-side via cleanContent.
  if (message.via && textContent.includes('<')) {
    textContent = textContent
      .replace(/<(a?):(\w+):(\d+)>/g, (_m, anim, name, id) =>
        `![demoji:${name}](https://cdn.discordapp.com/emojis/${id}.${anim ? 'gif' : 'png'}?size=48)`)
      // Bridged Discord stickers — the gateway appends <dsticker:name:id.ext>
      // tokens (stickers aren't message content on Discord's side); unfold
      // them into the same sticker: img form house stickers use.
      .replace(/<dsticker:([^:>]*):(\d+\.(?:png|gif))>/g, (_m, name, file) =>
        `![sticker:${name}](https://media.discordapp.net/stickers/${file}?size=160)`)
      .replace(/<@[!&]?\d+>/g, '')
      .replace(/<#\d+>/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  // Canvas chips (BL's <<canvas:id:title>> sentinels) — render as a tappable
  // chip; the link renderer below catches the #canvas= href and opens it.
  if (textContent.includes('<<canvas:')) {
    textContent = textContent.replace(/<<canvas:([a-zA-Z0-9-]+):(.+?)>>/g, (_m, id: string, title: string) => `[📄 ${title}](#canvas=${id})`);
  }

  const preparedText = prepareChatText({ text: textContent, resolveSticker: resolveStickerRef, customEmojis });
  textContent = preparedText.markdown;
  const stickerSharesText = preparedText.stickerSharesText;
  const emoteSizeClass = preparedText.emoteOnly ? '!h-12' : '!h-[1.75em]';
  let voiceSpeaker = '';
  let textToSpeak = '';

  // Check if content is a voice note
  if (textContent.startsWith('[VOICE]:')) {
    isVoice = true;
    textContent = textContent.replace('[VOICE]:', '').trim();
  } else if (message.type === 'voice') {
    isVoice = true;
  }

  // If it's a voice note, extract the speaker and the actual message for the audio player
  if (isVoice) {
    // Find first ": " to split speaker from message
    const firstColon = textContent.indexOf(': ');
    if (firstColon !== -1 && firstColon < 20) {
      voiceSpeaker = textContent.substring(0, firstColon).trim().toLowerCase();
      textToSpeak = textContent.substring(firstColon + 2).trim();
    } else {
      // Fallback if no colon is found
      textToSpeak = textContent;
    }
  }

  // Check if content contains a File
  if (textContent.includes('[FILE:')) {
    const match = textContent.match(/\[FILE:(.*?)\]:?\s*([\s\S]*)/);
    if (match) {
      isFile = true;
      fileName = match[1].trim() || 'document.pdf';
      fileContent = match[2];
      textContent = textContent.replace(match[0], '').trim();
    }
  }

  // Check if content contains a GIF or Image
  if (textContent.includes('[GIF]:')) {
    isGif = true;
    const parts = textContent.split('[GIF]:');
    textContent = parts[0].trim();
    mediaUrl = parts[1].trim();
  } else if (textContent.includes('[IMG]:')) {
    isImage = true;
    // The sentinel pattern is `[IMG]:<url>` and the adapter joins multiple
    // attachments with a space between each `[IMG]:url`. Splitting on the
    // sentinel and parsing each chunk lets us recover ALL urls instead of
    // just the first one (which was the old bug — multi-attachment
    // messages rendered only the first image on the bubble).
    const parts = textContent.split('[IMG]:');
    textContent = parts[0].trim();
    for (let i = 1; i < parts.length; i++) {
      let chunk = parts[i].trim();
      // [JSON]: tail (legacy single-image path) — strip it.
      if (chunk.includes('[JSON]:')) {
        chunk = chunk.split('[JSON]:')[0].trim();
      }
      // The next attachment's sentinel was already consumed by split,
      // but its url chunk may have whitespace separating multiple. Take
      // up to the first whitespace as the url; the rest (if any) is the
      // start of the next chunk and will be handled in the next iter…
      // except split already broke them apart. So just trim and use it.
      // Trailing space before next sentinel still ends up in the next
      // part as leading whitespace, which trim handles above.
      if (chunk) mediaUrls.push(chunk);
    }
    mediaUrl = mediaUrls[0] || '';
  } else {
    try {
      const parsed = JSON.parse(textContent);
      if (parsed.type === 'gif') {
        isGif = true;
        mediaUrl = parsed.url;
        textContent = '';
      }
    } catch (e) {
      // Not a JSON GIF
    }
    
    // Fallback: Check if the entire message is just a media URL
    if (!isGif && !isImage) {
      if (/^data:image\/(jpeg|jpg|png|gif|webp)[;,]/i.test(textContent)) {
        isImage = true;
        mediaUrl = textContent;
        textContent = '';
      } else {
        try {
          const url = new URL(textContent);
          const pathname = url.pathname.toLowerCase();
          const isTrustedDomain = (hostname: string, domain: string) => {
            return hostname === domain || hostname.endsWith('.' + domain);
          };
          if (
            pathname.match(/\.(jpeg|jpg|gif|png|webp)$/) || 
            (isTrustedDomain(url.hostname, 'giphy.com') && pathname.includes('/media/')) ||
            isTrustedDomain(url.hostname, 'media.tenor.com') ||
            isTrustedDomain(url.hostname, 'firebasestorage.googleapis.com')
          ) {
            isImage = true; // Treat as image to render it standalone
            mediaUrl = textContent;
            textContent = '';
          }
        } catch (e) {
          // Not a valid standalone URL
        }
      }
    }
  }

  const isMediaUrl = (url: string) => {
    if (/^data:image\/(jpeg|jpg|png|gif|webp)[;,]/i.test(url)) return true;
    try {
      const parsed = new URL(url);
      const pathname = parsed.pathname.toLowerCase();
      const isTrustedDomain = (hostname: string, domain: string) => {
        return hostname === domain || hostname.endsWith('.' + domain);
      };
      return (
        pathname.match(/\.(jpeg|jpg|gif|png|webp)$/) != null ||
        (isTrustedDomain(parsed.hostname, 'giphy.com') && pathname.includes('/media/')) ||
        isTrustedDomain(parsed.hostname, 'media.tenor.com') ||
        isTrustedDomain(parsed.hostname, 'firebasestorage.googleapis.com')
      );
    } catch (e) {
      return false;
    }
  };

  const handlePlayAudio = async () => {
    if (isPlaying && audioElement) {
      audioElement.pause();
      setIsPlaying(false);
      return;
    }

    if (isUser) return;

    setIsLoadingAudio(true);
    try {
      // Voice notes already have a generated audio file — content is the
      // URL (the [VOICE]: sentinel was stripped earlier). Play it
      // directly. Hitting /api/messages/:id/tts on these would 400 with
      // "Only text messages can be read aloud", since the backend gates
      // that route on content_type === 'text'.
      let audioUrl: string;
      if (isVoice) {
        // textContent is the file URL after [VOICE]: strip — it may carry
        // a "speaker: " prefix on some legacy messages, in which case
        // textToSpeak/textContent split already happened and the URL is
        // in textContent (no colon-prefix on a URL). Fall back to
        // textContent if textToSpeak isn't a URL.
        const candidate = (textToSpeak && /^https?:|^\//.test(textToSpeak.trim()))
          ? textToSpeak.trim()
          : textContent.trim();
        if (!candidate) throw new Error('No audio URL on voice message');
        audioUrl = candidate;
      } else {
        // Text message — route through the backend's read-aloud route so
        // the multi-voice splitter, per-companion voice IDs, and ffmpeg
        // stitching all apply. Browser-side ElevenLabs would only ever
        // produce one voice and read speaker labels out loud.
        const csrfToken =
          typeof document !== 'undefined'
            ? document.cookie.match(/bytelight_csrf=([^;]*)/)?.[1] || ''
            : '';
        const ttsRes = await fetch(`/api/messages/${encodeURIComponent(message.id)}/tts`, {
          method: 'POST',
          credentials: 'include',
          headers: csrfToken ? { 'x-csrf-token': csrfToken } : undefined,
        });
        if (!ttsRes.ok) {
          const data = await ttsRes.json().catch(() => ({}));
          throw new Error(data?.error || `TTS failed: HTTP ${ttsRes.status}`);
        }
        const data = (await ttsRes.json()) as { url?: string };
        if (!data.url) throw new Error('TTS response missing url');
        audioUrl = data.url;
      }

      const audio = new Audio(audioUrl);

      audio.onended = () => {
        setIsPlaying(false);
      };

      setAudioElement(audio);
      setAudioBlobUrl((prev) => {
        if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev);
        return audioUrl;
      });
      audio.play().catch(e => {
        console.error("Audio play error:", e);
        setIsPlaying(false);
      });
      setIsPlaying(true);
      setIsLoadingAudio(false);
    } catch (error) {
      console.error('Error playing audio:', error);
      setIsLoadingAudio(false);
    }
  };
  
  // Smart Sticker Detection inside standalone image blocks
  const isSticker = isImage && customEmojis?.some(e => e.url === mediaUrl);

  const handleDownloadFile = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!fileContent) return;
    
    // An ATTACHMENT arrives here as a bare url, not as the file's text. Blobbing
    // that saved a text file containing "/api/files/<id>" and called it done —
    // which is why an attached file has never actually been downloadable. Ask
    // the server for it instead: saveToDevice adds ?download=1, and the
    // Content-Disposition header is the only signal the Android WebView's
    // download listener reacts to.
    if (fileBlockIsHref(fileContent)) {
      saveToDevice(fileContent.trim(), fileName || undefined);
      return;
    }
    const blob = new Blob([fileContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName || 'document.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const resolvedColors = resolveThemeColors(colors);
  const autoUserText = contrastTextColor(
    resolvedColors.userBubbleBg,
    themeMode === 'dark' ? '#ffffff' : '#090807',
    resolvedColors.pageBg,
  );
  const autoCompText = contrastTextColor(
    resolvedColors.compBubbleBg,
    themeMode === 'dark' ? '#ffffff' : '#090807',
    resolvedColors.pageBg,
  );
  const automaticTextClass = (ink: string) => ink === '#ffffff' ? 'text-white' : 'text-black';
  const textColorClass = isPrivateTab
    ? (themeMode === 'light' ? 'text-black' : colors.compBubbleText)
    : themeConfig.id === 'custom'
      ? (isUser ? colors.userBubbleText : colors.compBubbleText)
      : automaticTextClass(isUser ? autoUserText : autoCompText);
  const isLightText = textColorClass === 'text-white' || /text-\[#[CDEFcdef]/.test(textColorClass);

  const isGroupLast = groupPos === 'only' || groupPos === 'last';
  const isGroupFirst = groupPos === 'only' || groupPos === 'first';

  // A system line is the house talking, not a companion: a slash-command
  // result, a refusal notice, a timeout. Left-aligned in the companion column
  // it reads as something one of them said, which is the one thing it never
  // is. Centred, narrow and quiet, with no avatar rail and no tail.
  //
  // A GUEST IS NOT THE HOUSE. Anyone who reaches us through a bridge is stored
  // with the same role as a system notice — that role only ever meant "not the
  // owner" — so a visitor was being drawn as furniture, and the avatar rail
  // written for them below could never fire: it required not-system, and they
  // are always system. The platform badge is the real discriminator, so it
  // decides here, once, and everything downstream reads this.
  const isGuest = !isUser && !!message.sender && !!message.via;
  const isSystem = message.isSystem === true && !isGuest;

  // Per-speaker split (carried over from the Svelte house): a mixed
  // Companion A/Companion B message renders as stacked per-speaker bubbles instead of one
  // slab. Only for plain companion text — segments, voice, system, guests and
  // media bubbles keep their existing shapes.
  const splitEligible = !isUser && !isPrivateTab && !isSystem && !isGuest && !isVoice && !isGif && !isImage;
  // A reply from one companion's own lane is stamped with him: draw it whole
  // as his bubble. The shared lane ('companion-a-b') splits by its headers.
  const wholeSpeaker = wholeSpeakerFor(message.companionId);
  const speakerRows =
    splitEligible && !hasSegments && textContent
      ? (wholeSpeaker ? [{ speaker: wholeSpeaker, text: textContent }] : splitBySpeaker(textContent))
      : null;
  // Finalized companion replies arrive as interleaved segments (text woven
  // with thinking/tool chips) — BL's splitInterleaved carries the speaker
  // split across the chips. Missing this path was why nothing ever split.
  const segRows = splitEligible && hasSegments
    ? (wholeSpeaker ? interleavedAs(segments!, wholeSpeaker) : splitInterleaved(segments!))
    : null;
  const segTextRows = segRows ? segRows.filter((r) => r.kind === 'text') : [];
  const isSegSplit =
    !!segRows &&
    (segTextRows.length > 1 ||
      (segTextRows.length === 1 && segTextRows[0].kind === 'text' && segTextRows[0].speaker !== 'fallback'));
  const isSplit = (!!speakerRows && (speakerRows.length > 1 || (!!wholeSpeaker && speakerRows.length === 1))) || isSegSplit;

  return (
    <div
      className={cn(
        "flex w-full group relative",
        isGroupLast ? "mb-6" : "mb-1.5",
        (isPrivateTab || isSystem) ? "justify-center" : (isUser && !centered) ? "justify-end" : "justify-start"
      )}
    >
      {/* Guest avatar rail — a visitor's own face from the platform they came
          through, ringed in the theme accent so they never read as a companion
          or the owner. Their initial is the fallback, not the design: an older
          message predates us capturing the picture, and the picture can 404. */}
      {isGuest && !isPrivateTab && !voice && (
        <div className="-ml-1.5 mr-2 mt-0.5 shrink-0 self-start" title={`${message.sender} · ${message.via}`}>
          {message.senderAvatar && !avatarFailed ? (
            <img
              src={message.senderAvatar}
              alt={message.sender}
              referrerPolicy="no-referrer"
              loading="lazy"
              decoding="async"
              onError={() => setAvatarFailed(true)}
              className="w-9 h-9 rounded-full object-cover border-2"
              style={{ borderColor: colors.accent }}
            />
          ) : (
            <div
              className={cn("w-9 h-9 rounded-full flex items-center justify-center text-base font-bold border-2", colors.compBubbleBg)}
              style={{ borderColor: colors.accent, color: themeMode === 'dark' ? '#fff' : '#000', opacity: 0.9 }}
            >
              {message.sender!.charAt(0).toUpperCase()}
            </div>
          )}
        </div>
      )}
      {/* Voice avatar rail — one face per speaking companion */}
      {!isUser && !isPrivateTab && !isSystem && voice && (
        <div className="-ml-1.5 mr-2 mt-0.5 shrink-0 self-start" title={voice.display_name}>
          {voice.avatar_url ? (
            <img
              src={voice.avatar_url}
              alt={voice.display_name}
              referrerPolicy="no-referrer"
              loading="lazy"
              decoding="async"
              className="w-9 h-9 rounded-full object-cover border-2"
              style={{ borderColor: voice.color || 'transparent' }}
            />
          ) : (
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center text-base border-2"
              style={{ borderColor: voice.color || 'transparent', background: 'rgba(127,127,127,0.15)' }}
            >
              {voice.emoji || voice.display_name.charAt(0)}
            </div>
          )}
        </div>
      )}
      <div className={cn(
        "flex flex-col max-w-[85%] sm:max-w-[75%]",
        (isPrivateTab || isSystem) ? "items-center" : (isUser && !centered) ? "items-end" : "items-start",
        // Indent meta-only preamble bubbles by the avatar-rail width so
        // their left edge lines up with the voice bubbles below them.
        centered && !isPrivateTab && !isSystem && "ml-[38px]"
      )}>
        {/* Guest name label — who is speaking through the bridge.
            Bare text here sat straight on her wallpaper and had to compete with
            it, so the name wears the same skin as the bubble under it and the
            platform wears the accent tag her OWN bridged messages already carry.
            One visual language for anything that arrived over a bridge. */}
        {!isUser && !isPrivateTab && message.sender && message.via && isGroupFirst && (
          <div className="mb-1 flex items-center gap-1.5">
            <span
              className={cn(
                "text-[11px] font-bold px-1.5 py-0.5 border rounded-[var(--shape-chip)]",
                colors.compBubbleBg, colors.compBubbleText, colors.panelBorder
              )}
            >
              {message.sender}
            </span>
            <span
              className={cn("font-bold text-[9px] px-1.5 py-0.5 rounded-[var(--shape-chip)]")}
              style={{
                background: `color-mix(in srgb, ${colors.accent} 35%, transparent)`,
                color: themeMode === 'dark' ? '#fff' : '#000',
              }}
              title={`Reached us via ${message.via}`}
            >
              {message.via.toUpperCase()}
            </span>
          </div>
        )}
        <div className="relative max-w-full min-w-0">
          <div
            onClick={() => { if (isEditing) return; setShowActions(!showActions); }}
            data-user={isUser ? 'true' : 'false'}
            data-split={isSplit ? 'true' : undefined}
            className={cn(
              "bytelight-message-bubble transition-all duration-500 cursor-pointer rounded-[var(--shape-bubble)]",
              !isSplit && "overflow-hidden",
              (isGif || isImage) && !textContent ? "p-1" : isSplit ? "p-0" : "px-3.5 py-2.5",
              // NO backdrop-filter on a bubble. Her ask, and it is also the fix:
              // a bubble should be ONE painted thing, not glyphs sitting over a
              // live-blurred surface. Two surfaces can come apart — and on a tall
              // message they do, the compositor dropping the lower half of the
              // texture while the top still paints. Every theme resolves
              // --bytelight-comp-bubble to an opaque colour, so the blur was blurring
              // a backdrop that was already completely covered: it bought nothing
              // and cost the whole class of bug. Undo is putting the four
              // backdrop-blur classes back.
              isSystem
                // No tail either way, and quieter than a companion's — this is
                // the house answering, and it should read as furniture.
                ? `border ${colors.panelBg} ${colors.textMuted} ${colors.panelBorder} text-[12px] opacity-90`
                : isPrivateTab
                ? `border ${colors.compBubbleBg} ${colors.panelBorder}`
                : centered
                  ? `border ${colors.compBubbleBg} ${colors.compBubbleText} ${colors.panelBorder}`
                  : isUser
                    ? `rounded-tr-none border ${colors.userBubbleBg} ${colors.userBubbleText} ${colors.panelBorder}`
                    : isSplit
                      // The stack wrapper sheds its chrome — each speaker's
                      // inner bubble carries it instead (BL .split model).
                      ? colors.compBubbleText
                      : `rounded-tl-none border ${colors.compBubbleBg} ${colors.compBubbleText} ${colors.panelBorder}`
            )}
            style={isPrivateTab
              ? { color: (colors as any).noteText || (themeMode === 'light' ? '#000000' : '#ffffff') }
              : undefined}
          >
            {message.replyToPreview && !isEditing && isGroupFirst && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (message.replyToId) onJumpToReply?.(message.replyToId);
                }}
                disabled={!message.replyToId || !onJumpToReply}
                className={cn(
                  "block w-full text-left border-l-2 pl-2 pr-1 py-0.5 mb-1.5 text-[11px] opacity-70 truncate",
                  textColorClass,
                  message.replyToId && onJumpToReply && "cursor-pointer hover:opacity-100",
                )}
                style={{ borderLeftColor: colors.accent }}
              >
                {message.replyToPreview}
              </button>
            )}
            {isEditing && (
              <div className="flex flex-col gap-2 min-w-[280px] sm:min-w-[400px]">
                <textarea
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  rows={Math.min(10, Math.max(4, editValue.split('\n').length))}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                  className={cn(
                    "w-full bg-transparent resize-none focus:outline-none text-[15px] scrollbar-hide min-h-[100px]",
                    textColorClass,
                  )}
                  style={{ caretColor: colors.accent }}
                />
                <div className="flex gap-2 justify-end text-[11px] font-semibold uppercase tracking-wider">
                  <button
                    type="button"
                    disabled={editBusy}
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (!onEdit) return;
                      setEditBusy(true);
                      try { await onEdit(editValue, false); setIsEditing(false); }
                      finally { setEditBusy(false); }
                    }}
                    className="px-2 py-1 rounded hover:opacity-80 disabled:opacity-40"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    disabled={editBusy}
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (!onEdit) return;
                      setEditBusy(true);
                      try { await onEdit(editValue, true); setIsEditing(false); }
                      finally { setEditBusy(false); }
                    }}
                    className="px-2 py-1 rounded hover:opacity-80 disabled:opacity-40 font-bold underline underline-offset-2 decoration-1"
                  >
                    Save & Rerun
                  </button>
                  <button
                    type="button"
                    disabled={editBusy}
                    onClick={(e) => { e.stopPropagation(); setIsEditing(false); }}
                    className="px-2 py-1 rounded hover:opacity-80 disabled:opacity-40 opacity-70"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {!isEditing && (<>
            <div style={{ display: 'contents' }}>
            {isVoice && !isUser && (
              <>
                <div className={cn(
                  "flex items-center w-fit gap-2 mb-2 p-1.5 rounded-full border",
                  "bg-black/20 border-white/10"
                )}>
                  <button
                    onClick={(e) => { e.stopPropagation(); handlePlayAudio(); }}
                    disabled={isLoadingAudio || !apiKey}
                    className={cn(
                      "w-7 h-7 rounded-full transition-colors flex-shrink-0 flex items-center justify-center",
                      !apiKey ? "opacity-50 cursor-not-allowed" : "hover:opacity-90"
                    )}
                    style={{ backgroundColor: colors.accent, color: 'var(--bytelight-on-accent)' }}
                    title={!apiKey ? "ElevenLabs API key required" : (isPlaying ? "Stop" : "Play Voice Note")}
                  >
                    {isLoadingAudio ? <Loader2 size={14} className="animate-spin" /> : (isPlaying ? <Square size={12} fill="currentColor" /> : <Play size={12} fill="currentColor" className="ml-0.5" />)}
                  </button>

                  {/* Waveform — animates during generation and playback. */}
                  <div className="flex items-center gap-[3px] h-4 px-2">
                    {[40, 70, 40, 100, 60, 30, 80, 50, 90, 40, 60, 30, 70, 50, 80].map((h, i) => {
                      const active = isPlaying || isLoadingAudio;
                      return (
                        <div
                          key={i}
                          className={cn(
                            "w-[3px] rounded-full bg-current transition-all duration-200",
                            active && "animate-pulse",
                          )}
                          style={{
                            height: `${h}%`,
                            opacity: active ? 0.85 : 0.3,
                            animationDelay: `${i * 0.1}s`,
                            animationDuration: '0.8s',
                          }}
                        />
                      );
                    })}
                  </div>

                  <span className="text-[10px] font-medium opacity-70 pr-1">
                    {isLoadingAudio ? 'Generating…' : isPlaying ? 'Playing…' : 'Voice Note'}
                  </span>

                  {audioBlobUrl && (
                    <a
                      href={audioBlobUrl}
                      download={`voice-${message.id}.mp3`}
                      onClick={(e) => e.stopPropagation()}
                      className="opacity-60 hover:opacity-100 transition-opacity pr-1"
                      title="Download audio"
                    >
                      <Download size={12} />
                    </a>
                  )}
                </div>
                {message.transcript && (
                  <div className={cn("text-[13px] italic opacity-80 mb-2 px-1 select-text", textColorClass)}>
                    {message.transcript}
                  </div>
                )}
              </>
            )}

            {hasSegments && isSegSplit ? (
              <SpeakerSegmentStack
                rows={segRows!}
                roster={voiceRoster}
                colors={colors}
                textColorClass={textColorClass}
                isLightText={isLightText}
                themeConfig={themeConfig}
                themeMode={themeMode}
                customEmojis={customEmojis}
              />
            ) : hasSegments ? (
              <MessageSegments
                segments={segments!}
                themeConfig={themeConfig}
                themeMode={themeMode}
                customEmojis={customEmojis}
                textClass={textColorClass}
              />
            ) : isSplit ? (
              <SpeakerBubbles
                rows={speakerRows!}
                customEmojis={customEmojis}
                roster={voiceRoster}
                colors={colors}
                textColorClass={textColorClass}
                isLightText={isLightText}
              />
            ) : textContent && !isVoice && (
            <div className={cn(
                // [overflow-wrap:anywhere] handles the pathological case
                // — a very long unbroken string (URL, hash, paste of code)
                // that overflow-wrap:break-word still tries to keep whole.
                // 'anywhere' lets the browser break at any character if
                // there's no other opportunity, so the bubble never gets
                // clipped horizontally.
                "prose prose-sm max-w-none prose-p:leading-relaxed prose-p:my-0 prose-pre:bg-black/30 prose-img:inline prose-img:m-0 select-text [overflow-wrap:anywhere] min-w-0",
                isLightText ? "prose-invert" : "",
                isUser && isLightText ? "prose-code:text-white/80" : "",
                isUser && !isLightText ? "prose-code:text-black/80" : "",
                textColorClass,
                (isGif || (isImage && !isSticker) || isFile) ? "mb-3" : "",
                isVoice ? "italic" : ""
              )}
              style={{
                fontFamily: 'inherit',
                '--tw-prose-body': 'inherit',
                '--tw-prose-headings': 'inherit',
                '--tw-prose-links': 'inherit',
                '--tw-prose-bold': 'inherit',
                '--tw-prose-counters': 'inherit',
                '--tw-prose-bullets': 'inherit',
                '--tw-prose-quotes': 'inherit',
                '--tw-prose-quote-borders': 'inherit',
                '--tw-prose-captions': 'inherit',
                '--tw-prose-code': 'inherit',
                '--tw-prose-th-borders': 'inherit',
                '--tw-prose-td-borders': 'inherit',
                '--tw-prose-invert-body': 'inherit',
                '--tw-prose-invert-headings': 'inherit',
                '--tw-prose-invert-links': 'inherit',
                '--tw-prose-invert-bold': 'inherit',
                '--tw-prose-invert-counters': 'inherit',
                '--tw-prose-invert-bullets': 'inherit',
                '--tw-prose-invert-quotes': 'inherit',
                '--tw-prose-invert-quote-borders': 'inherit',
                '--tw-prose-invert-captions': 'inherit',
                '--tw-prose-invert-code': 'inherit',
                '--tw-prose-invert-th-borders': 'inherit',
                '--tw-prose-invert-td-borders': 'inherit',
              } as React.CSSProperties}
              >
                <div className="flex gap-2 items-start">
                  {isUser && (isVoice || message.isVoiceInput) && (
                    <Mic size={16} className="mt-1 flex-shrink-0 opacity-70" />
                  )}
                  <div className="flex-1 min-w-0">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm, remarkBreaks]}
                      components={{
                        p: ({ children }) => <span className="block">{children}</span>,
                        // Discord-style "-# whisper" subtext (preprocessed to h6 above)
                        h6: ({ children }) => <span className="block text-[11px] leading-snug opacity-60 italic">{children}</span>,
                        pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
                        a: ({ node, href, children, ...props }) => {
                          if (href && href.startsWith('#canvas=')) {
                            const canvasId = href.slice('#canvas='.length);
                            return (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  window.dispatchEvent(new CustomEvent('bytelight:open-canvas', { detail: { canvasId } }));
                                }}
                                className="inline-flex max-w-full items-center gap-1 rounded-full border border-current/30 px-2 py-0.5 text-[12px] font-semibold no-underline opacity-90 hover:opacity-100 align-middle"
                              >
                                <span className="truncate">{children}</span>
                              </button>
                            );
                          }
                          const safeHref = resolveMessageHref(href, window.location.href);
                          if (safeHref && isMediaUrl(safeHref)) {
                            return (
                              <span className="my-2 inline-block w-full">
                                <LongPressImage
                                  src={thumbSrc(safeHref, 768)}
                                  fullSrc={safeHref}
                                  alt="Media content"
                                  className={cn("max-w-full h-auto rounded-lg object-cover max-h-[300px] bg-black/20 cursor-zoom-in")}
                                  onLoad={onMediaLoad}
                                  onShortTap={(s: string) => setLightboxState({ images: [s], index: 0 })}
                                />
                              </span>
                            );
                          }
                          // Anything we serve under /api/ opens without leaving the app.
                          const childText = React.Children.toArray(children)
                            .filter((c): c is string => typeof c === 'string')
                            .join('');
                          const house = houseFileLink(safeHref, window.location.href, href, childText);
                          if (house) {
                            return <HouseFileLink href={house.href} label={house.label} textish={house.textish} />;
                          }
                          // An empty href is not a link — never render one, it reloads the app.
                          if (!safeHref) return <span {...props}>{children}</span>;
                          return <a href={safeHref} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>;
                        },
                        img: ({ node, src, alt, ...props }) => {
                          // Sticker ref — the alt text starts with "sticker:" and
                          // src is the resolved /stickers/<pack>/<file> URL.
                          if (alt?.startsWith('sticker:') && src) {
                            return (
                              <img
                                src={src}
                                alt={alt.slice('sticker:'.length)}
                                className={cn(
                                  '!inline-block !w-auto object-contain',
                                  stickerSharesText
                                    ? '!h-[1.75em] !max-h-[1.75em] !my-0 mx-0.5 align-text-bottom'
                                    : 'max-h-32 align-bottom',
                                )}
                                referrerPolicy="no-referrer"
                              />
                            );
                          }
                          // Bridged Discord emote — alt is "demoji:name", src the Discord CDN url.
                          if (alt?.startsWith('demoji:') && src) {
                            const name = alt.slice('demoji:'.length);
                            return (
                              <img
                                src={src}
                                alt={`:${name}:`}
                                title={`:${name}:`}
                                className={cn('!inline-block !w-auto !my-0 mx-0.5 align-text-bottom rounded-sm object-contain transition-transform hover:scale-110', emoteSizeClass)}
                                referrerPolicy="no-referrer"
                              />
                            );
                          }
                          // Custom Emoji rendering lookup (standardized format)
                          if (src?.startsWith('emoji:') || alt?.startsWith('emoji:')) {
                            const shortcode = (src?.startsWith('emoji:') ? src : alt)?.split(':')[1];
                            const emoji = customEmojis?.find(e => e.shortcode === shortcode);
                            if (emoji) {
                              return (
                                <img
                                  src={emoji.url}
                                  alt={shortcode}
                                  className={cn('!inline-block !w-auto !my-0 mx-0.5 align-text-bottom rounded-sm object-contain transition-transform hover:scale-110', emoteSizeClass)}
                                  referrerPolicy="no-referrer"
                                />
                              );
                            }
                          }

                          // Support for existing explicit image tags match custom emoji URLs
                          const matchedEmoji = customEmojis?.find(e => e.url === src);
                          if (matchedEmoji) {
                            return (
                              <img
                                src={matchedEmoji.url}
                                alt={matchedEmoji.shortcode}
                                className={cn('!inline-block !w-auto !my-0 mx-0.5 align-text-bottom rounded-sm object-contain transition-transform hover:scale-110', emoteSizeClass)}
                                referrerPolicy="no-referrer"
                              />
                            );
                          }

                          const safeSrc = (() => {
                            if (!src) return undefined;
                            if (/^data:image\/(jpeg|jpg|png|gif|webp)[;,]/i.test(src)) return src;
                            if (src.startsWith('/')) return src;
                            try {
                              const url = new URL(src);
                              return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined;
                            } catch {
                              return undefined;
                            }
                          })();
                          
                          if (!safeSrc) return null;
                          
                          return (
                            <LongPressImage
                              src={thumbSrc(safeSrc, 768)}
                              fullSrc={safeSrc}
                              alt={alt || "Image"}
                              className={cn("max-w-full h-auto rounded-lg object-cover max-h-[300px] bg-black/20 my-2 cursor-zoom-in")}
                              onLoad={onMediaLoad}
                              onShortTap={(s: string) => setLightboxState({ images: [s], index: 0 })}
                              {...props}
                            />
                          );
                        }
                      }}
                    >
                      {textContent}
                    </ReactMarkdown>
                  </div>
                </div>
              </div>
            )}

            {isFile && (
              <div 
                onClick={!isUser ? handleDownloadFile : undefined}
                className={cn(
                  "flex items-center gap-3 p-3 rounded-lg mt-2 mb-1 border transition-colors",
                  isUser ? "bg-black/10 border-black/10" : "bg-black/20 border-white/10 cursor-pointer hover:bg-black/20 dark:hover:bg-white/20"
                )}
                title={!isUser ? "Download file" : undefined}
              >
                <FileText size={24} className="opacity-80" />
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="text-sm font-medium truncate">{fileName}</span>
                  {!isUser && <span className="text-xs opacity-60">Click to download</span>}
                </div>
                {!isUser && <Download size={16} className="opacity-50" />}
              </div>
            )}

            {(isGif || (isImage && !isSticker)) && (() => {
              // Resolve every attachment URL to a safe src, then render
              // either a single big image (1) or a 2-col grid (2+). GIF
              // path always has exactly one url so it falls into the
              // single branch automatically.
              const candidates = mediaUrls.length > 0 ? mediaUrls : (mediaUrl ? [mediaUrl] : []);
              const sources = candidates
                .map((u) => {
                  if (/^data:image\/(jpeg|jpg|png|gif|webp)[;,]/i.test(u)) return u;
                  if (u.startsWith('/')) return u;
                  try {
                    const parsed = new URL(u);
                    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null;
                  } catch {
                    return null;
                  }
                })
                .filter((s): s is string => !!s);
              if (sources.length === 0) return null;
              if (sources.length === 1) {
                const src = sources[0];
                return (
                  <div className="relative min-w-[240px]">
                    {/* Attachments are how every image we send actually
                        arrives, and this path never had a hold-to-save on it
                        — only the ones written into message text did. */}
                    <LongPressImage
                      src={thumbSrc(src, 768)}
                      fullSrc={src}
                      alt={isGif ? 'GIF' : 'Photo'}
                      className={cn(
                        'w-full h-auto object-cover min-h-[180px] bg-black/20 cursor-zoom-in rounded-[var(--shape-surface)]',
                      )}
                      onLoad={onMediaLoad}
                      onShortTap={() => setLightboxState({ images: sources, index: 0 })}
                    />
                  </div>
                );
              }
              return (
                <div className="grid grid-cols-2 gap-1 min-w-[240px]">
                  {sources.map((src, i) => (
                    <LongPressImage
                      key={`${src}-${i}`}
                      src={thumbSrc(src, 480)}
                      fullSrc={src}
                      alt={`Photo ${i + 1}`}
                      className={cn(
                        'w-full h-32 object-cover bg-black/20 cursor-zoom-in rounded-[var(--shape-surface)]',
                      )}
                      loading="lazy"
                      onLoad={onMediaLoad}
                      onShortTap={() => setLightboxState({ images: sources, index: i })}
                    />
                  ))}
                </div>
              );
            })()}
            </div>
            </>)}
          </div>

          {/* Actions belong to the stored message, not each virtual
              companion bubble. Anchor one tray beneath the final voice. */}
          {isGroupLast && <div className={cn(
            "absolute transition-all flex items-center gap-1 px-2 py-1 rounded-full border z-20",
            colors.panelBg,
            colors.panelBorder,
            isUser 
              ? "right-0 top-full mt-1 sm:right-full sm:mr-2 sm:top-0 sm:mt-0 sm:left-auto" 
              : "left-0 top-full mt-1 sm:left-full sm:ml-2 sm:top-0 sm:mt-0 sm:right-auto",
            showActions ? "opacity-100 scale-100" : "opacity-0 scale-90 pointer-events-none group-hover:opacity-100 group-hover:scale-100 group-hover:pointer-events-auto"
          )}>
            {!showDeleteConfirm && !showRerollConfirm ? (
              <>
                {!isUser && (
                  <button 
                    onClick={(e) => { e.stopPropagation(); setShowReactions((v) => !v); setShowCustomReactions(false); }}
                    className={cn("p-1 transition-colors", "hover:opacity-100", colors.textMuted)}
                    style={{ color: showReactions ? colors.accent : undefined }}
                    title="React"
                  >
                    <Smile size={16} />
                  </button>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); onBookmark?.(message.id); }}
                  className={cn("p-1 transition-colors", "hover:opacity-100", colors.textMuted)}
                  style={{ color: message.isBookmarked ? colors.accent : undefined }}
                  title="Bookmark"
                >
                  <Star size={16} fill={message.isBookmarked ? "currentColor" : "none"} />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); void copyToClipboard(copyText || textContent || message.content || ''); }}
                  className={cn("p-1 transition-colors opacity-60 hover:opacity-100", colors.textMuted)}
                  title="Copy"
                >
                  <Copy size={16} />
                </button>
                {onReply && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onReply(); }}
                    className={cn("p-1 transition-colors opacity-60 hover:opacity-100", colors.textMuted)}
                    title="Reply"
                  >
                    <Reply size={16} />
                  </button>
                )}
                {isUser && onEdit && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setEditValue(message.content || ''); setIsEditing(true); setShowActions(false); }}
                    className={cn("p-1 transition-colors opacity-60 hover:opacity-100", colors.textMuted)}
                    title="Edit"
                  >
                    <Pencil size={16} />
                  </button>
                )}
                {!isUser && (
                  <button
                    onClick={(e) => { e.stopPropagation(); void handlePlayAudio(); }}
                    disabled={isLoadingAudio}
                    className={cn("p-1 transition-colors opacity-60 hover:opacity-100 disabled:opacity-40", colors.textMuted)}
                    style={isPlaying ? { color: colors.accent } : undefined}
                    title={apiKey ? (isPlaying ? 'Stop' : 'Read aloud') : 'Set ElevenLabs key in Settings → Data'}
                  >
                    {isLoadingAudio ? <Loader2 size={16} className="animate-spin" /> : isPlaying ? <Square size={14} fill="currentColor" /> : <Volume2 size={16} />}
                  </button>
                )}
                {!isUser && onReroll && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setShowRerollConfirm(true); }}
                    className={cn("p-1 transition-colors opacity-60 hover:opacity-100", colors.textMuted)}
                    title="Reroll"
                  >
                    <RefreshCw size={16} />
                  </button>
                )}
                {onDelete && (
                  <button 
                    onClick={(e) => { e.stopPropagation(); setShowDeleteConfirm(true); }}
                    className={cn("p-1 transition-colors opacity-60 hover:opacity-100", colors.textMuted)}
                    style={{ color: colors.accent }}
                    title="Delete"
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </>
            ) : showDeleteConfirm ? (
              <div className="flex items-center gap-2 px-1 py-0.5">
                <span className="text-[11px] font-bold">Delete?</span>
                <button 
                  onClick={(e) => { e.stopPropagation(); onDelete(); setShowDeleteConfirm(false); }}
                  className="bytelight-on-accent text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded transition-colors opacity-90 hover:opacity-100"
                  style={{ backgroundColor: colors.accent }}
                >
                  Yes
                </button>
                <button 
                  onClick={(e) => { e.stopPropagation(); setShowDeleteConfirm(false); }}
                  className={cn("text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded hover:bg-black/5 dark:hover:bg-white/5 transition-colors", colors.textMuted)}
                >
                  No
                </button>
              </div>
            ) : (
              /*
                Reroll asks too, and says how much it takes. It soft-deletes
                from this message onward, so tapping it on something from
                hours ago clears the rest of the conversation — and it sits
                one button away from read-aloud, which is exactly how that
                gets tapped by accident.
              */
              <div className="flex items-center gap-2 px-1 py-0.5">
                <span className="text-[11px] font-bold">
                  {rerollRemoves && rerollRemoves > 1 ? `Reroll? Removes ${rerollRemoves}` : 'Reroll?'}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); void onReroll?.(); setShowRerollConfirm(false); }}
                  className="bytelight-on-accent text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded transition-colors opacity-90 hover:opacity-100"
                  style={{ backgroundColor: colors.accent }}
                >
                  Yes
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setShowRerollConfirm(false); }}
                  className={cn("text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded hover:bg-black/5 dark:hover:bg-white/5 transition-colors", colors.textMuted)}
                >
                  No
                </button>
              </div>
            )}

          </div>}

          {/* Reaction tray rendered as a bottom sheet (portal'd) — same
              shape as the model picker. The inline anchored popover got
              clipped off-screen on narrow mobile widths. */}
          {showReactions && typeof document !== 'undefined' && createPortal(
            <AnimatePresence>
              <motion.div
                key="reaction-backdrop"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => { setShowReactions(false); setShowCustomReactions(false); }}
                className="fixed inset-0 z-40 bg-black/40"
              />
              <motion.div
                key="reaction-sheet"
                initial={{ y: '100%' }}
                animate={{ y: 0 }}
                exit={{ y: '100%' }}
                transition={{ type: 'spring', stiffness: 360, damping: 32 }}
                className={cn(
                  'fixed inset-x-0 bottom-0 z-50 max-h-[60%] flex flex-col rounded-t-3xl border-t',
                  colors.panelBg,
                  colors.panelBorder,
                  colors.textMain,
                )}
                style={{ paddingBottom: 'var(--sab, 0px)' }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between px-4 pt-3 pb-2">
                  <span className={cn('text-sm font-semibold', colors.textMain)}>React</span>
                  <button
                    onClick={() => { setShowReactions(false); setShowCustomReactions(false); }}
                    className={cn('rounded-full p-1.5', colors.textMuted)}
                    title="Close"
                  >
                    <X size={16} />
                  </button>
                </div>

                {/* Preset row */}
                <div className="flex items-center justify-around px-4 pb-3">
                  {EMOJIS.map((emoji) => (
                    <button
                      key={emoji}
                      onClick={() => {
                        onReact?.(emoji);
                        setShowReactions(false);
                        setShowCustomReactions(false);
                      }}
                      className="hover:scale-125 transition-transform text-2xl leading-none"
                    >
                      {emoji}
                    </button>
                  ))}
                  <button
                    onClick={() => setShowCustomReactions((v) => !v)}
                    className={cn(
                      'flex items-center justify-center rounded-full border w-9 h-9 transition-colors',
                      colors.panelBorder,
                      colors.textMuted,
                    )}
                    style={showCustomReactions ? { color: colors.accent, borderColor: colors.accent } : undefined}
                    title="More"
                  >
                    <Plus size={16} />
                  </button>
                </div>

                {showCustomReactions && (
                  <div className={cn('border-t flex-1 overflow-y-auto scrollbar-hide px-4 py-3 space-y-3', colors.panelBorder)}>
                    <div>
                      <div className={cn('mb-1.5 text-[10px] uppercase tracking-widest opacity-60', colors.textMuted)}>
                        Emoji
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {EXTRA_EMOJIS.map((e) => (
                          <button
                            key={e}
                            onClick={() => {
                              onReact?.(e);
                              setShowReactions(false);
                              setShowCustomReactions(false);
                            }}
                            className="hover:scale-125 transition-transform text-xl leading-none w-8 h-8 flex items-center justify-center"
                          >
                            {e}
                          </button>
                        ))}
                      </div>
                    </div>

                    {customEmojis && customEmojis.length > 0 && (
                      <div>
                        <div className={cn('mb-1.5 text-[10px] uppercase tracking-widest opacity-60', colors.textMuted)}>
                          Custom
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {customEmojis.map((emoji) => (
                            <button
                              key={emoji.id}
                              onClick={() => {
                                onReact?.(`:${emoji.shortcode}:`);
                                setShowReactions(false);
                                setShowCustomReactions(false);
                              }}
                              className="hover:scale-125 transition-transform p-0.5"
                              title={`:${emoji.shortcode}:`}
                            >
                              <img
                                src={emoji.url}
                                alt={emoji.shortcode}
                                className="h-7 w-auto object-contain rounded-sm"
                                referrerPolicy="no-referrer"
                              />
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </motion.div>
            </AnimatePresence>,
            document.body,
          )}

          {/* Displayed Reactions */}
          {message.reactions && message.reactions.length > 0 && isGroupLast && (
            <div className={cn(
              "absolute -bottom-3 flex gap-0.5 border rounded-full px-1.5 py-0.5 z-10",
              colors.panelBg,
              colors.panelBorder,
              isUser ? "right-2" : "left-2"
            )}>
              {message.reactions.map((r, i) => {
                // Custom-emote reactions ride as :shortcode: strings — look
                // them up in the loaded customEmojis and render the image
                // when we have a hit; otherwise fall back to plain text.
                const isShortcode = r.startsWith(':') && r.endsWith(':') && r.length > 2;
                if (isShortcode && customEmojis) {
                  const code = r.slice(1, -1);
                  const emoji = customEmojis.find((e) => e.shortcode === code);
                  if (emoji) {
                    return (
                      <img
                        key={i}
                        src={emoji.url}
                        alt={r}
                        title={r}
                        className="h-[14px] w-auto object-contain"
                        referrerPolicy="no-referrer"
                      />
                    );
                  }
                }
                return (
                  <span key={i} className="text-[12px]">{r}</span>
                );
              })}
            </div>
          )}
        </div>

        {isGroupLast && (
        <div
          className={cn(
            "flex items-center gap-1.5 text-[10px] mt-1.5 font-bold",
            themeMode === 'light' ? "text-black" : "text-white",
            isUser && !isPrivateTab ? "flex-row-reverse" : "flex-row",
            isPrivateTab ? "self-end" : ""
          )}
        >
          {message.type === 'voice' && <span className="font-bold text-[9px] bg-black/10 dark:bg-white/10 px-1 rounded">VOICE</span>}
          {isUser && message.prosody && Object.keys(message.prosody).length > 0 && (
            <span
              className="text-[9px] opacity-70 font-normal"
              title={Object.entries(message.prosody).slice(0, 3).map(([k, v]) => `${k}: ${Math.round(v * 100)}%`).join(', ')}
            >
              {Object.entries(message.prosody).slice(0, 2).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(' · ')}
            </span>
          )}
          {isUser && message.via && (
            <span
              className="font-bold text-[9px] px-1 rounded"
              style={{ background: `color-mix(in srgb, ${colors.accent} 35%, transparent)`, color: themeMode === 'dark' ? '#fff' : '#000' }}
              title={`Sent via ${message.via}`}
            >
              {message.via.toUpperCase()}
            </span>
          )}
          <span
            className={cn(
              "bytelight-message-time",
              isUser && !isPrivateTab ? "bytelight-theme-user-bubble" : "bytelight-theme-comp-bubble",
            )}
          >
            {format(new Date(message.timestamp), 'MMM d, h:mm a')}
          </span>
          {message.editedAt && (
            <span className="opacity-60 text-[9px] font-medium italic" title={`Edited ${format(new Date(message.editedAt), 'MMM d, h:mm a')}`}>
              (edited)
            </span>
          )}
          {isUser && (
            <span className="flex items-center">
              {message.status === 'read' || message.read === 1 ? (
                <CheckCheck size={12} style={{ color: colors.accent }} />
              ) : (
                <Check size={12} />
              )}
            </span>
          )}
          {message.isBookmarked && (
            <Star size={10} fill="currentColor" style={{ color: colors.accent }} />
          )}
          {hasShimmer && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setShimmerOpen((v) => !v); }}
              title={isDejavuOnly ? 'Something felt familiar' : 'This reply carried remembered context'}
              aria-label={isDejavuOnly ? 'Déjà vu — something felt familiar' : 'Show surfaced memory'}
              aria-expanded={shimmerOpen}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[9px] leading-none tracking-wide transition-opacity',
                isDejavuOnly ? 'border-dashed italic opacity-50' : 'opacity-70',
                shimmerOpen && 'opacity-100',
              )}
              style={{ borderColor: isDejavuOnly ? 'currentColor' : colors.accent }}
            >
              <span
                aria-hidden="true"
                className={cn('h-1.5 w-1.5 rounded-full', !isDejavuOnly && 'bytelight-shimmer-glint')}
                style={
                  isDejavuOnly
                    ? { background: 'currentColor', opacity: 0.6 }
                    : { background: colors.accent, boxShadow: `0 0 5px 1px ${colors.accent}` }
                }
              />
              <span>{isDejavuOnly ? 'déjà vu' : 'recalled'}</span>
            </button>
          )}
        </div>
        )}
        {hasShimmer && shimmerOpen && (
          <div
            className={cn(
              'mt-1.5 rounded-md border border-l-2 px-2.5 py-2 text-[11px]',
              isDejavuOnly && 'italic opacity-85',
            )}
            style={{
              borderLeftColor: isDejavuOnly ? 'currentColor' : colors.accent,
              borderColor: `color-mix(in srgb, currentColor 15%, transparent)`,
              background: `color-mix(in srgb, ${colors.accent} 6%, transparent)`,
            }}
          >
            {isDejavuOnly ? (
              <p className="m-0 leading-relaxed opacity-70">
                Something about this felt familiar — a memory just out of reach. Nothing surfaced
                clearly enough to show.
              </p>
            ) : (
              <>
                <p className="m-0 mb-1.5 text-[9px] uppercase tracking-widest opacity-60">
                  Surfaced from the archive
                </p>
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {surfacedCards.map((card, i) => (
                    <li key={i} className="flex flex-col gap-0.5">
                      <span className="leading-relaxed">{card.excerpt}</span>
                      <span className="flex flex-wrap gap-1.5 text-[9px] opacity-60">
                        {card.date && <span>{card.date}</span>}
                        {card.domain && <span>{card.domain}</span>}
                        {typeof card.relevance === 'number' && (
                          <span style={{ color: colors.accent }}>
                            {Math.round(card.relevance * 100)}%
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
                {surfacedMemory?.dejavu && (
                  <p className="m-0 mt-1.5 italic leading-relaxed opacity-60">
                    …and something else felt familiar, just out of reach.
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>
      {/* Owner avatar rail — mirrors the companion rail on the right */}
      {isUser && !isPrivateTab && userAvatar && (
        <div className="ml-2 -mr-1.5 mt-0.5 shrink-0 self-start" title="You">
          <img
            src={userAvatar}
            alt="You"
            loading="lazy"
            decoding="async"
            className="w-9 h-9 rounded-full object-cover border-2"
            style={{ borderColor: userAvatarColor || 'transparent' }}
          />
        </div>
      )}
      {lightboxState && (
        <ImageLightbox
          images={lightboxState.images}
          startIndex={lightboxState.index}
          onClose={() => setLightboxState(null)}
        />
      )}
    </div>
  );
}
