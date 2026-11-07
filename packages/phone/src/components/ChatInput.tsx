import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Sticker, Film, Camera, ImagePlus, Mic, PhoneCall, Square, X, FileText, Smile, Loader2, ChevronDown } from 'lucide-react';
import { getSendIcon } from '../lib/sendIcons';
import { GifPicker } from './GifPicker';
import { EmojiPicker } from './EmojiPicker';
import { StickerPicker } from './StickerPicker';
import { CommandPalette } from './CommandPalette';
import { ShortcodePalette, type ShortcodeMatch } from './ShortcodePalette';
import { ModelPalette, type ModelOption } from './ModelPalette';
import { loadStickers, getStickerPacks, subscribeStickers } from '../bytelight/stickers';
import { matchShortcodeToken, applyShortcode } from '../lib/shortcodes';
import { matchModelArgToken, applyModelArg } from '../lib/model-arg';
import { getCanvasRefs, subscribeCanvasRefs, removeCanvasRef, clearCanvasRefs, canvasRefSentinels, type CanvasRef } from '../lib/canvas-refs';
import { AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils';
import { ThemeConfig } from '../lib/theme';
import { ThemeMode, CustomEmoji, EmojiPack, Message } from '../types';
import {
  apiFetch,
  sendCommand,
  stopGeneration,
  useCommandRegistry,
  type CommandRegistryEntry,
  useBytelight,
  startVoiceRecording,
  stopVoiceRecording,
  cancelVoiceRecording,
  clearTranscription,
  isRecordingSupported,
} from '../bytelight';
import * as pdfjsLib from 'pdfjs-dist';
// @ts-ignore
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const MAX_IMAGES = 8;
const MAX_DOCS = 8;

// A picked image: uploaded to /api/files the moment it is selected, the same
// way the desktop composer does it. previewUrl is a blob: URL for the thumbnail.
interface ImageAttachment {
  id: string;
  previewUrl: string;
  status: 'uploading' | 'ready' | 'error';
  meta?: unknown;
}

// A picked document — the file's text (PDFs extracted via pdf.js) is held in
// memory and embedded into the message at send-time as [FILE:name]:<content>,
// the same shape MessageBubble's parser strips out of the visible bubble.
interface DocumentAttachment {
  id: string;
  name: string;
  data: string;
}

function newId(): string {
  // Not crypto.randomUUID() — that needs a secure context, and the phone is
  // served over plain HTTP on the LAN.
  return `img-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Resize/compress a picked image to a JPEG blob for upload. Animated GIFs are
// returned untouched so the canvas does not flatten the animation.
async function processImage(file: File): Promise<Blob> {
  if (file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif')) {
    return file;
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
  if (!/^data:image\//i.test(dataUrl)) throw new Error('That file is not an image');
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Could not load the image'));
    el.src = dataUrl;
  });
  const max = 1280;
  let width = img.width;
  let height = img.height;
  if (width > max || height > max) {
    if (width >= height) {
      height = Math.round((height * max) / width);
      width = max;
    } else {
      width = Math.round((width * max) / height);
      height = max;
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is unavailable');
  ctx.drawImage(img, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.82),
  );
  if (!blob) throw new Error('Could not compress the image');
  return blob;
}

// Send icon color based on theme mode — light mode gets white icon, dark mode gets black icon
function getSendIconColor(mode: 'light' | 'dark') {
  return mode === 'light' ? 'text-white' : 'text-black';
}

interface ChatInputProps {
  onSend: (content: string | any, type: 'text' | 'gif' | 'voice') => void;
  onError?: (error: string) => void;
  giphyApiKey?: string;
  disabled?: boolean;
  themeConfig: ThemeConfig;
  themeMode: ThemeMode;
  customEmojis?: CustomEmoji[];
  emojiPacks?: EmojiPack[];
  replyTo?: Message | null;
  onCancelReply?: () => void;
  threadId?: string | null;
  // Optional override for the send-button icon; defaults to a paper plane.
  sendIconId?: string;
  isAtBottom?: boolean;
  onJumpToLatest?: () => void;
  generating?: boolean;
  onStopGeneration?: () => void;
  // A foreground voice conversation owns transcription while open. The
  // composer remains mounted underneath, but must not consume the same
  // completed transcript into its draft.
  voiceConversationActive?: boolean;
  onStartVoiceConversation?: () => void;
}

const DRAFT_KEY_PREFIX = 'bytelight_draft_';

export function ChatInput({ onSend, onError, giphyApiKey, disabled, themeConfig, themeMode, customEmojis, emojiPacks, replyTo, onCancelReply, threadId, sendIconId, isAtBottom = true, onJumpToLatest, generating = false, onStopGeneration, voiceConversationActive = false, onStartVoiceConversation }: ChatInputProps) {
  // Resolve once per render; falls back to the paper plane.
  const SendIcon = getSendIcon(sendIconId);
  const [content, setContent] = useState('');
  // The action row's disappearing act is BL's, copied whole: the row itself
  // renders always, but sits at max-height 0 until the composer has focus or
  // something pending — see .bytelight-toolbar in index.css. No toggle button.
  // Stop control is BL's too: a quiet square
  // beside the send arrow while streaming, gated by a confirm so a stray tap
  // can't kill a reply she wanted. Auto-dismiss if the reply finishes first.
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  useEffect(() => { if (!generating) setShowStopConfirm(false); }, [generating]);
  // Pending canvas chips (BL's pendingCanvasRefs) — live in lib/canvas-refs
  // because the Canvas app is a different screen; sentinels prepend on send.
  const [canvasRefs, setCanvasRefs] = useState<CanvasRef[]>(getCanvasRefs());
  useEffect(() => subscribeCanvasRefs(() => setCanvasRefs(getCanvasRefs())), []);
  // Track the threadId we last loaded a draft for so the load-on-switch
  // effect doesn't fight the user's typing on the same thread.
  const loadedThreadRef = useRef<string | null>(null);

  // Load any saved draft when the active thread changes; persist the draft
  // back to localStorage whenever the composer text changes.
  useEffect(() => {
    if (!threadId) return;
    if (loadedThreadRef.current === threadId) return;
    loadedThreadRef.current = threadId;
    try {
      const saved = localStorage.getItem(DRAFT_KEY_PREFIX + threadId);
      setContent(saved || '');
    } catch {
      setContent('');
    }
  }, [threadId]);

  useEffect(() => {
    if (!threadId) return;
    if (loadedThreadRef.current !== threadId) return;
    try {
      if (content) localStorage.setItem(DRAFT_KEY_PREFIX + threadId, content);
      else localStorage.removeItem(DRAFT_KEY_PREFIX + threadId);
    } catch {
      /* localStorage full or unavailable — skip silently */
    }
  }, [content, threadId]);

  const [isVoiceNote, setIsVoiceNote] = useState(false);
  // attachment is the single inline GIF (a short remote URL); images and
  // documents are multi-attach sets. Documents stay client-side until send
  // because their text rides inline in the message body.
  const [attachment, setAttachment] = useState<{ type: 'gif', data: string, name?: string } | null>(null);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [documents, setDocuments] = useState<DocumentAttachment[]>([]);
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showStickerPicker, setShowStickerPicker] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Mic flow now goes through the backend (Groq Whisper + optional Hume
  // prosody) instead of browser SpeechRecognition. State comes from the
  // Bytelight store — transcription_status frames update it.
  const transcription = useBytelight((s) => s.transcription);
  const isRecording = transcription.status === 'recording';
  const isTranscribing = transcription.status === 'processing';
  // Cached at consume-time so a quick edit before send doesn't lose the
  // tone reading. Cleared after a successful send or new recording.
  const [pendingProsody, setPendingProsody] = useState<Record<string, number> | undefined>();
  // Track the text we filled from a transcription. If the user keeps it
  // (or appends to it), prosody travels with the send. If they wipe it
  // and type something unrelated, drop the prosody — would be wrong to
  // attribute someone else's tone to fresh text.
  const lastTranscriptText = useRef<string | null>(null);

  useEffect(() => {
    if (content.trim() === '') {
      setIsVoiceNote(false);
    }
  }, [content]);

  const colors = themeConfig[themeMode];

  // Slash-command palette — open while content is "/name-token" with no
  // whitespace yet. Once the user types a space, they're in args territory
  // and the palette closes (they can still send via the Send button, which
  // dispatches via sendCommand below if the name matches a registered entry).
  const commandRegistry = useCommandRegistry();
  const paletteOpen = !!content.match(/^\/[a-zA-Z0-9_-]*$/) && commandRegistry.length > 0;
  const paletteFilter = paletteOpen ? content.slice(1) : '';
  const filteredCommands = useMemo<CommandRegistryEntry[]>(() => {
    if (!paletteOpen) return [];
    const q = paletteFilter.toLowerCase();
    return commandRegistry.filter(
      (c) => !q || c.name.toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q),
    );
  }, [commandRegistry, paletteOpen, paletteFilter]);
  const [paletteIndex, setPaletteIndex] = useState(0);
  useEffect(() => {
    setPaletteIndex(0);
  }, [paletteFilter, paletteOpen]);

  // ---- Shortcode palette -------------------------------------------------
  // The command palette's sibling, pointed at `:` instead of `/`. It can open
  // mid-message, so the token is matched at the CARET rather than at the start
  // of the box.
  //
  // One colon searches emoji, two searches stickers, and they do NOT share a
  // list. That looked like something to smooth over until the reason surfaced: the
  // syntaxes differ because the two namespaces are separate ON PURPOSE, so a sticker
  // and an emoji can carry the same name. Merging the search would be undoing
  // a deliberate distinction.
  const [stickerTick, setStickerTick] = useState(0);
  useEffect(() => {
    // Warm the shared cache; the picker uses the same one. And SUBSCRIBE, because
    // warming it once is what left this tray showing yesterday's list: the sheet
    // refreshes the shared cache when it opens and nothing here ever heard about
    // it, so a newly uploaded sticker was findable in the sheet and invisible to
    // `::` until the whole app was reloaded.
    const unsubscribe = subscribeStickers(() => setStickerTick((n) => n + 1));
    void loadStickers().then(() => setStickerTick((n) => n + 1));
    return unsubscribe;
  }, []);

  const [caret, setCaret] = useState(0);

  // ---- Model-argument tray ----------------------------------------------
  // The third sibling. The command palette hands over the moment a space is
  // typed; this picks the argument up. Computed BEFORE the shortcode token
  // because it suppresses it: an Ollama id looks like `llama3.1:8b`, so a
  // model id can contain a colon and would otherwise be read as a shortcode
  // being typed.
  const modelArgToken = useMemo(() => matchModelArgToken(content, caret), [content, caret]);
  const modelArgOpen = !!modelArgToken;

  // The `:`-token immediately before the caret, if the caret is inside one.
  // Requires at least one character after the colons, so a bare ":" — which
  // is most of the smileys anyone types — opens nothing.
  const shortcodeToken = useMemo(
    () => (modelArgOpen ? null : matchShortcodeToken(content, caret)),
    [content, caret, modelArgOpen],
  );

  // Opening the `::` tray is a refresh, the same way opening the sticker sheet is.
  // Subscribing alone only helps if something ELSE went and looked; if she uploads
  // a sticker in Packs and comes straight back to the composer, nothing has. Fires
  // on the transition into a sticker token rather than on every keystroke.
  const stickerTrayOpen = shortcodeToken?.colons === '::';
  useEffect(() => {
    if (stickerTrayOpen) void loadStickers(true);
  }, [stickerTrayOpen]);

  const shortcodeMatches = useMemo<ShortcodeMatch[]>(() => {
    if (!shortcodeToken) return [];
    void stickerTick; // recompute once the sticker cache lands
    const q = shortcodeToken.query.toLowerCase();
    const out: ShortcodeMatch[] = [];

    if (shortcodeToken.colons === ':') {
      for (const e of customEmojis || []) {
        if (e.shortcode.toLowerCase().includes(q)) {
          out.push({ code: `:${e.shortcode}:`, label: e.shortcode, kind: 'emoji', url: e.url });
        }
      }
    }
    // Stickers answer `:` as well as `::` — on main a single colon is the
    // sticker syntax the operator already types, the same autocomplete the Svelte
    // composer gives her.
    for (const pack of getStickerPacks()) {
      for (const st of pack.stickers || []) {
        const ref = `${pack.name}_${st.name}`;
        // Match the sticker's own name as well as the qualified ref, so
        // "::bearonesie" finds it without knowing whose pack it is in.
        if (ref.toLowerCase().includes(q) || st.name.toLowerCase().includes(q)) {
          out.push({ code: `:${ref}:`, label: ref, kind: 'sticker', url: st.url });
        }
      }
    }
    // Whole-word hits first, then alphabetical, then capped — a two-letter
    // query can otherwise match most of a pack.
    return out
      .sort((a, b) => {
        const aStarts = a.label.toLowerCase().startsWith(q) ? 0 : 1;
        const bStarts = b.label.toLowerCase().startsWith(q) ? 0 : 1;
        return aStarts - bStarts || a.label.localeCompare(b.label);
      })
      .slice(0, 30);
  }, [shortcodeToken, customEmojis, stickerTick]);

  const shortcodeOpen = shortcodeMatches.length > 0;
  const [shortcodeIndex, setShortcodeIndex] = useState(0);
  useEffect(() => {
    setShortcodeIndex(0);
  }, [shortcodeToken?.query, shortcodeToken?.colons]);

  const handleShortcodeSelect = (m: ShortcodeMatch) => {
    if (!shortcodeToken) return;
    const { content: next, caret: pos } = applyShortcode(content, shortcodeToken, caret, m.code);
    setContent(next);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  // The model list, fetched the first time the tray opens rather than on
  // mount — every composer would otherwise pay for a list almost nobody asks
  // for.
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  useEffect(() => {
    if (!modelArgOpen || models || modelsLoading) return;
    setModelsLoading(true);
    void (async () => {
      try {
        const res = await apiFetch('/api/models');
        const list = await res.json();
        // A backend older than a route answers it with the SPA's index.html
        // and a 200, so the shape is the only honest check.
        setModels(Array.isArray(list) ? (list as ModelOption[]) : []);
      } catch {
        setModels([]);
      } finally {
        setModelsLoading(false);
      }
    })();
  }, [modelArgOpen, models, modelsLoading]);

  const modelMatches = useMemo<ModelOption[]>(() => {
    if (!modelArgToken || !models) return [];
    const q = modelArgToken.query.toLowerCase();
    // Deliberately NOT re-sorted by best match: the API returns them already
    // grouped by provider and the palette groups adjacent runs, so sorting
    // would interleave providers and repeat every heading. She is typing a
    // prefix anyway, which does the narrowing on its own.
    return models
      .filter((m) => !q || m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q))
      .slice(0, 60);
  }, [modelArgToken, models]);

  const [modelIndex, setModelIndex] = useState(0);
  useEffect(() => {
    setModelIndex(0);
  }, [modelArgToken?.query]);

  const handleModelSelect = (m: ModelOption) => {
    if (!modelArgToken) return;
    const { content: next, caret: pos } = applyModelArg(content, modelArgToken, caret, m.id);
    setContent(next);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  const findCommand = (name: string): CommandRegistryEntry | undefined =>
    commandRegistry.find((c) => c.name.toLowerCase() === name.toLowerCase());

  const handleCommandSelect = (cmd: CommandRegistryEntry) => {
    if (cmd.clientOnly) {
      if (cmd.name === 'stop') {
        stopGeneration();
        setContent('');
        return;
      }
      if (cmd.name === 'help') {
        setContent('/');
        textareaRef.current?.focus();
        return;
      }
    }
    if (cmd.args) {
      // Pre-fill the textarea with `/name ` so the user can type arguments.
      setContent(`/${cmd.name} `);
      textareaRef.current?.focus();
      return;
    }
    sendCommand(cmd.name);
    setContent('');
  };

  const handleSend = async () => {
    let finalContent: string | any = (content || '').trim();
    if (canvasRefs.length > 0) {
      const refs = canvasRefSentinels(canvasRefs);
      finalContent = finalContent ? `${refs} ${finalContent}` : refs;
      clearCanvasRefs();
    }
    let type: 'text' | 'gif' | 'voice' = 'text';

    // Slash-command shortcut: if the message is `/name [args...]` and `name`
    // matches a registered command, dispatch via the command frame instead
    // of sending plain text. Falls through if the name isn't recognized so
    // the user can still post a literal "/word" message.
    if (
      finalContent.startsWith('/') &&
      !finalContent.includes('\n') &&
      images.length === 0 &&
      documents.length === 0 &&
      !attachment
    ) {
      const rest = finalContent.slice(1);
      const spaceIdx = rest.indexOf(' ');
      const name = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
      const args = spaceIdx === -1 ? undefined : rest.slice(spaceIdx + 1).trim() || undefined;
      const cmd = findCommand(name);
      if (cmd) {
        if (cmd.clientOnly && cmd.name === 'stop') {
          stopGeneration();
        } else if (cmd.clientOnly && cmd.name === 'help') {
          setContent('/');
          textareaRef.current?.focus();
          return;
        } else {
          sendCommand(cmd.name, args);
        }
        setContent('');
        setIsVoiceNote(false);
        return;
      }
    }

    // Custom-emoji shortcodes (:name:) stay in the text. The recipient
    // MessageBubble substitutes them for the inline image visually, and the
    // backend's emojiRefsToImageBlocks resolves them to image content blocks
    // for AI vision (see services/visual-blocks.ts). No client-side upload
    // needed — inlining the base64 URL would blow the 10KB text limit, and
    // uploading via /api/files turns each one into a separate image bubble.

    // Documents: each picked file's text is appended to the message body as
    // [FILE:name]:<content>. MessageBubble strips these blocks out of the
    // visible bubble (just shows a file card) but the agent sees them in
    // the prompt — same shape as the Constellation worker.
    if (documents.length > 0) {
      const docBlocks = documents.map((d) => `[FILE:${d.name}]:\n${d.data}`).join('\n\n');
      finalContent = finalContent ? `${finalContent}\n\n${docBlocks}` : docBlocks;
    }

    // Images: already uploaded to /api/files — send their references so the
    // backend turns them into content blocks. Up to MAX_IMAGES of them.
    if (images.length > 0) {
      if (disabled) return;
      if (images.some((i) => i.status === 'uploading')) {
        onError?.('Images are still uploading — give it a second.');
        return;
      }
      const ready = images.filter((i) => i.status === 'ready' && i.meta).map((i) => i.meta);
      if (ready.length === 0) {
        onError?.('No images uploaded successfully — try re-adding them.');
        return;
      }
      onSend({ text: finalContent, attachments: ready }, 'text');
      images.forEach((i) => URL.revokeObjectURL(i.previewUrl));
      setImages([]);
      setDocuments([]);
      setContent('');
      setIsVoiceNote(false);
      return;
    }

    if (attachment) {
      // GIF — a short remote URL, safe to send inline
      finalContent = `${finalContent} [GIF]:${attachment.data}`.trim();
      type = 'gif';
    }

    if (finalContent && !disabled) {
      // Prosody from Hume rides along as metadata — the backend's
      // message hook prepends a `[Voice tone — emotion: score, ...]`
      // line to the agent prompt so the companion sees how it was said.
      // No audio file is stored; this is text-with-flavor, not a real
      // voice-note bubble.
      if (pendingProsody) {
        onSend({ text: finalContent, metadata: { prosody: pendingProsody } }, 'text');
        setPendingProsody(undefined);
        lastTranscriptText.current = null;
      } else {
        onSend(finalContent, type);
      }
      setContent('');
      setIsVoiceNote(false);
      setAttachment(null);
      setDocuments([]);
    }
  };

  // React to transcription completion — fill the textarea with the
  // transcript and remember the prosody so the next send carries it.
  useEffect(() => {
    if (voiceConversationActive) return;
    if (transcription.status === 'complete' && transcription.text) {
      const transcript = transcription.text.trim();
      setContent((prev) => {
        const next = prev ? `${prev} ${transcript}` : transcript;
        lastTranscriptText.current = next;
        return next;
      });
      setPendingProsody(transcription.prosody);
      setIsVoiceNote(true);
      clearTranscription();
    } else if (transcription.status === 'error' && transcription.error) {
      onError?.(transcription.error);
      clearTranscription();
    }
  }, [transcription.status, transcription.text, transcription.prosody, transcription.error, onError, voiceConversationActive]);

  // If the user edits the composer to something that no longer contains
  // the transcribed text, drop the prosody — wouldn't be honest to
  // attribute the original tone reading to fresh typing.
  useEffect(() => {
    if (!pendingProsody) return;
    if (lastTranscriptText.current && !content.includes(lastTranscriptText.current)) {
      setPendingProsody(undefined);
      lastTranscriptText.current = null;
    }
  }, [content, pendingProsody]);

  // Cancel any in-flight recording on unmount so the mic actually
  // releases and we don't leave a hot MediaRecorder feeding chunks
  // into a thread the user just navigated away from.
  useEffect(() => {
    return () => {
      cancelVoiceRecording();
    };
  }, []);

  const toggleRecording = async () => {
    if (isRecording) {
      stopVoiceRecording();
      return;
    }
    if (!isRecordingSupported()) {
      onError?.('Voice recording is not supported in this browser.');
      return;
    }
    try {
      await startVoiceRecording();
    } catch (err) {
      // startVoiceRecording already pushed the error to the store; the
      // effect above will surface it via onError. Swallow here so the
      // promise rejection doesn't bubble up to a global handler.
      void err;
    }
  };

  const handleSendGif = (url: string) => {
    setAttachment({ type: 'gif', data: url });
    setShowGifPicker(false);
  };

  // EmojiPicker now sends the literal text to insert — Unicode glyph for
  // the Standard tab, `:shortcode:` for the Custom tab — so we just append
  // it without wrapping.
  const handleSelectEmoji = (text: string) => {
    setContent(prev => prev + text);
    setShowEmojiPicker(false);
    setTimeout(() => {
      textareaRef.current?.focus();
    }, 0);
  };

  const handleCameraClick = () => {
    cameraInputRef.current?.click();
  };

  const handleUploadClick = () => {
    uploadInputRef.current?.click();
  };

  const readDocument = async (file: File): Promise<string> => {
    if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      let text = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map((item: any) => item.str).join(' ');
        text += `--- Page ${i} ---\n${pageText}\n\n`;
      }
      return text;
    }
    return file.text();
  };

  const handleFileTextChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;

    const room = MAX_DOCS - documents.length;
    if (room <= 0) {
      onError?.(`You can attach up to ${MAX_DOCS} documents.`);
      return;
    }
    if (files.length > room) {
      onError?.(`Only ${room} more document${room === 1 ? '' : 's'} can be added.`);
    }

    for (const file of files.slice(0, room)) {
      try {
        const text = await readDocument(file);
        setDocuments((prev) => [...prev, { id: newId(), name: file.name, data: text }]);
      } catch (err) {
        console.error('[Bytelight] Failed to read file:', err);
        onError?.(`Failed to read ${file.name}: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    }
  };

  const removeDocument = (id: string) => {
    setDocuments((prev) => prev.filter((d) => d.id !== id));
  };

  // Upload one already-processed image blob to /api/files.
  const uploadImage = async (id: string, blob: Blob) => {
    try {
      const ext = blob.type === 'image/gif' ? 'gif' : 'jpg';
      const form = new FormData();
      form.append('file', new File([blob], `image.${ext}`, { type: blob.type || 'image/jpeg' }));
      const res = await apiFetch('/api/files', { method: 'POST', body: form });
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);
      const meta = await res.json();
      setImages((prev) => prev.map((it) => (it.id === id ? { ...it, status: 'ready', meta } : it)));
    } catch (err) {
      setImages((prev) => prev.map((it) => (it.id === id ? { ...it, status: 'error' } : it)));
      onError?.(err instanceof Error ? err.message : 'Image upload failed.');
    }
  };

  // Process + upload a batch of File objects. Shared by the file-picker,
  // drag-and-drop, and clipboard-paste entry points.
  const addImageFiles = async (incoming: File[]) => {
    const onlyImages = incoming.filter((f) => f.type.startsWith('image/'));
    if (onlyImages.length === 0) return;

    const room = MAX_IMAGES - images.length;
    if (room <= 0) {
      onError?.(`You can attach up to ${MAX_IMAGES} images.`);
      return;
    }
    if (onlyImages.length > room) {
      onError?.(`Only ${room} more image${room === 1 ? '' : 's'} can be added.`);
    }

    for (const file of onlyImages.slice(0, room)) {
      let blob: Blob;
      try {
        blob = await processImage(file);
      } catch (err) {
        onError?.(err instanceof Error ? err.message : 'Could not process that image.');
        continue;
      }
      const id = newId();
      const previewUrl = URL.createObjectURL(blob);
      setImages((prev) => [...prev, { id, previewUrl, status: 'uploading' }]);
      void uploadImage(id, blob);
    }
  };

  // Picked one or more images — process + upload each immediately.
  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;
    await addImageFiles(files);
  };

  // Drag-and-drop + clipboard paste — both hand a FileList off to the same
  // pipeline as the file picker.
  const [isDragOver, setIsDragOver] = useState(false);
  const handleDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!isDragOver) setIsDragOver(true);
  };
  const handleDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget === e.target) setIsDragOver(false);
  };
  const handleDrop = async (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length === 0) return;
    await addImageFiles(files);
  };
  const handlePaste = async (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length === 0) return;
    e.preventDefault();
    await addImageFiles(files);
  };

  const removeImage = (id: string) => {
    setImages((prev) => {
      const target = prev.find((it) => it.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((it) => it.id !== id);
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Checked before both of the others: while `/model <id>` is being typed
    // the box belongs to this tray, and the shortcode matcher is already
    // suppressed for the same reason.
    if (modelArgOpen && modelMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setModelIndex((i) => (i + 1) % modelMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setModelIndex((i) => (i - 1 + modelMatches.length) % modelMatches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const m = modelMatches[modelIndex];
        if (m) handleModelSelect(m);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        // Same as the shortcode tray: close it without eating what she typed.
        // Clearing the box is right for a bare command and wrong here, where
        // she may have a half-typed id she still wants.
        setCaret(-1);
        return;
      }
    }
    // Same contract as the command palette, and checked first because a
    // shortcode can be typed inside a message that also starts with a slash.
    if (shortcodeOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setShortcodeIndex((i) => (i + 1) % shortcodeMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setShortcodeIndex((i) => (i - 1 + shortcodeMatches.length) % shortcodeMatches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const m = shortcodeMatches[shortcodeIndex];
        if (m) handleShortcodeSelect(m);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        // Close the tray without eating what she typed — Escape on the
        // command palette clears the box, which is right for a command and
        // wrong for a word in the middle of a sentence.
        setCaret(-1);
        return;
      }
    }
    // Palette navigation owns these keys while it's open.
    if (paletteOpen && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setPaletteIndex((i) => (i + 1) % filteredCommands.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setPaletteIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const cmd = filteredCommands[paletteIndex];
        if (cmd) handleCommandSelect(cmd);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setContent('');
        return;
      }
    }
    // Otherwise Enter defaults to a new line.
  };

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      // Floor at 48 to match the send button's h-12; inline style.height
      // otherwise wins over the min-h-[48px] CSS class and lets the pill
      // collapse to ~36-40px for a single-line empty textarea, which
      // leaves the bottom of the pill sitting above the button's bottom.
      textareaRef.current.style.height = `${Math.max(48, Math.min(textareaRef.current.scrollHeight, 120))}px`;
    }
  }, [content]);

  const canSend = (!!content.trim() || !!attachment || images.length > 0 || documents.length > 0 || canvasRefs.length > 0) && !disabled;

  return (
    <div
      className={cn(
        "bytelight-composer-wrap px-4 py-2 sm:px-6 sm:py-3 border-t relative z-10 transition-all duration-500",
        // BL's composer contract: 'expanded' when something is going on —
        // pending text, attachments, or an open picker. Focus expands via
        // CSS :focus-within. The toolbar row reads both (index.css).
        (content.trim().length > 0 || images.length > 0 || documents.length > 0 || !!attachment || canvasRefs.length > 0 || showEmojiPicker || showGifPicker || showStickerPicker) && "expanded",
        // Daylight chrome is clean white (original Gemini-era design) so
        // the footer fuses with the white status bar; the muted accent
        // lives in the page behind the messages, not in the chrome.
        themeMode === 'light' ? 'bg-white' : colors.pageBg,
        colors.panelBorder
      )}
      style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom, 0px), var(--sab, 0px))' }}
      onDragEnter={handleDragOver}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed text-xs font-semibold uppercase tracking-wider"
          style={{
            borderColor: colors.accent,
            color: colors.accent,
            background: 'rgba(0,0,0,0.05)',
          }}
        >
          Drop image to attach
        </div>
      )}
      {/* Float against the whole composer, including the icon toolbar. The
          outer wrap grows upward with drafts, replies, and attachments, so
          these controls always ride its live top edge without covering tools. */}
      {!isAtBottom && onJumpToLatest && (
        <button
          type="button"
          onClick={onJumpToLatest}
          className={cn(
            'absolute bottom-full right-4 mb-2 z-40 flex h-9 w-9 items-center justify-center rounded-full border backdrop-blur-md shadow-md',
            colors.panelBg, colors.panelBorder, colors.textMain,
          )}
          aria-label="Jump to latest message"
        >
          <ChevronDown size={18} />
        </button>
      )}
      {showStopConfirm && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 px-8"
          onClick={() => setShowStopConfirm(false)}
        >
          <div
            className={cn("w-full max-w-xs rounded-2xl border p-5 shadow-2xl", colors.panelBg, colors.panelBorder)}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className={cn("mb-1 text-sm font-bold", colors.textMain)}>Stop this response?</h3>
            <p className={cn("mb-4 text-xs leading-relaxed", colors.textMuted)}>
              I'll stop mid-reply and keep whatever I've written so far. You can't resume it — only regenerate.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowStopConfirm(false)}
                className={cn("rounded-lg border px-3 py-1.5 text-xs font-semibold", colors.panelBorder, colors.textMain)}
              >
                Keep going
              </button>
              <button
                onClick={() => { setShowStopConfirm(false); onStopGeneration?.(); }}
                className="rounded-lg bg-red-500/90 px-3 py-1.5 text-xs font-bold text-white hover:bg-red-500"
              >
                Stop
              </button>
            </div>
          </div>
        </div>
      )}
      <AnimatePresence>
        {showGifPicker && (
          <GifPicker
            onSelect={handleSendGif}
            onClose={() => setShowGifPicker(false)}
            themeConfig={themeConfig}
            themeMode={themeMode}
            apiKey={giphyApiKey}
          />
        )}
        {showEmojiPicker && (
          <EmojiPicker
            onSelect={handleSelectEmoji}
            onClose={() => setShowEmojiPicker(false)}
            themeConfig={themeConfig}
            themeMode={themeMode}
            customEmojis={customEmojis}
            emojiPacks={emojiPacks}
          />
        )}
        {showStickerPicker && (
          <StickerPicker
            onSelect={(insertText) => {
              setContent((prev) => prev + insertText);
              setShowStickerPicker(false);
              textareaRef.current?.focus();
            }}
            onClose={() => setShowStickerPicker(false)}
            themeConfig={themeConfig}
            themeMode={themeMode}
          />
        )}
      </AnimatePresence>

      <input
        type="file"
        id="camera-input"
        name="camera-input"
        accept="image/*"
        capture="environment"
        ref={cameraInputRef}
        onChange={handleImageSelect}
        className="hidden"
      />

      <input
        type="file"
        id="upload-input"
        name="upload-input"
        accept="image/*"
        multiple
        ref={uploadInputRef}
        onChange={handleImageSelect}
        className="hidden"
      />

      <input
        type="file"
        id="file-text-input"
        name="file-text-input"
        accept=".txt,.md,.csv,.json,.log,.pdf"
        multiple
        ref={fileInputRef}
        onChange={handleFileTextChange}
        className="hidden"
      />

      <div className="flex flex-col gap-1 max-w-4xl mx-auto">
        {modelArgOpen && (
          <ModelPalette
            matches={modelMatches}
            query={modelArgToken?.query || ''}
            selectedIndex={modelIndex}
            onSelect={handleModelSelect}
            onHoverIndex={setModelIndex}
            themeConfig={themeConfig}
            themeMode={themeMode}
            loading={modelsLoading}
          />
        )}
        {shortcodeOpen && (
          <ShortcodePalette
            matches={shortcodeMatches}
            query={shortcodeToken?.query || ''}
            prefix={shortcodeToken?.colons || ':'}
            selectedIndex={shortcodeIndex}
            onSelect={handleShortcodeSelect}
            onHoverIndex={setShortcodeIndex}
            themeConfig={themeConfig}
            themeMode={themeMode}
          />
        )}
        {paletteOpen && (
          <CommandPalette
            registry={commandRegistry}
            filter={paletteFilter}
            selectedIndex={paletteIndex}
            onSelect={handleCommandSelect}
            onHoverIndex={setPaletteIndex}
            themeConfig={themeConfig}
            themeMode={themeMode}
          />
        )}
        {replyTo && (
          <div
            className={cn(
              "flex items-center gap-2 mb-1 px-3 py-1.5 rounded-lg border-l-2",
              colors.panelBg,
            )}
            style={{ borderLeftColor: colors.accent }}
          >
            <div className="flex-1 min-w-0">
              <div className={cn("text-[10px] uppercase tracking-wider opacity-70", colors.textMuted)}>
                Replying to {replyTo.direction === 'inbound' ? 'yourself' : 'companion'}
              </div>
              <div className={cn("text-xs truncate opacity-80", colors.textMain)}>
                {(replyTo.content || '').slice(0, 100)}
              </div>
            </div>
            <button
              type="button"
              onClick={onCancelReply}
              className="opacity-60 hover:opacity-100 p-1"
              aria-label="Cancel reply"
            >
              <X size={14} />
            </button>
          </div>
        )}
        {canvasRefs.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 px-1 pb-1">
            {canvasRefs.map((r, i) => (
              <span
                key={r.canvasId}
                className={cn('flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold', colors.panelBorder, colors.textMain)}
              >
                <FileText size={11} />
                <span className="max-w-[10rem] truncate">{r.title}</span>
                <button onClick={() => removeCanvasRef(i)} className="opacity-60 hover:opacity-100">
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="bytelight-toolbar flex items-center gap-1 px-1">
          <button
            onClick={() => {
              setShowEmojiPicker(!showEmojiPicker);
              setShowGifPicker(false);
            }}
            disabled={disabled}
            className={cn("flex-shrink-0 p-2 rounded-full transition-all duration-300 disabled:opacity-50", colors.textMuted, "hover:bg-white/5")}
            style={{ color: showEmojiPicker ? colors.accent : undefined }}
            onMouseEnter={(e) => e.currentTarget.style.color = colors.accent}
            onMouseLeave={(e) => e.currentTarget.style.color = showEmojiPicker ? colors.accent : ''}
            title="Custom Emotes"
          >
            <Smile size={18} strokeWidth={1.5} />
          </button>

          <button
            onClick={() => {
              setShowGifPicker(!showGifPicker);
              setShowEmojiPicker(false);
              setShowStickerPicker(false);
            }}
            disabled={disabled}
            className={cn("flex-shrink-0 p-2 rounded-full transition-all duration-300 disabled:opacity-50", colors.textMuted, "hover:bg-white/5")}
            style={{ color: showGifPicker ? colors.accent : undefined }}
            onMouseEnter={(e) => e.currentTarget.style.color = colors.accent}
            onMouseLeave={(e) => e.currentTarget.style.color = showGifPicker ? colors.accent : ''}
            title="Send a GIF"
          >
            <Film size={18} strokeWidth={1.5} />
          </button>

          <button
            onClick={() => {
              setShowStickerPicker(!showStickerPicker);
              setShowEmojiPicker(false);
              setShowGifPicker(false);
            }}
            disabled={disabled}
            className={cn("flex-shrink-0 p-2 rounded-full transition-all duration-300 disabled:opacity-50", colors.textMuted, "hover:bg-white/5")}
            style={{ color: showStickerPicker ? colors.accent : undefined }}
            onMouseEnter={(e) => e.currentTarget.style.color = colors.accent}
            onMouseLeave={(e) => e.currentTarget.style.color = showStickerPicker ? colors.accent : ''}
            title="Stickers"
          >
            <Sticker size={18} strokeWidth={1.5} />
          </button>

          <button
            onClick={handleUploadClick}
            disabled={disabled}
            className={cn("flex-shrink-0 p-2 rounded-full transition-all duration-300 disabled:opacity-50", colors.textMuted, "hover:bg-white/5")}
            onMouseEnter={(e) => e.currentTarget.style.color = colors.accent}
            onMouseLeave={(e) => e.currentTarget.style.color = ''}
            title="Upload images"
          >
            <ImagePlus size={18} strokeWidth={1.5} />
          </button>

          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            className={cn("flex-shrink-0 p-2 rounded-full transition-all duration-300 disabled:opacity-50", colors.textMuted, "hover:bg-white/5")}
            onMouseEnter={(e) => e.currentTarget.style.color = colors.accent}
            onMouseLeave={(e) => e.currentTarget.style.color = ''}
            title="Upload documents"
          >
            <FileText size={18} strokeWidth={1.5} />
          </button>

          <button
            onClick={handleCameraClick}
            disabled={disabled}
            className={cn("flex-shrink-0 p-2 rounded-full transition-all duration-300 disabled:opacity-50", colors.textMuted, "hover:bg-white/5")}
            onMouseEnter={(e) => e.currentTarget.style.color = colors.accent}
            onMouseLeave={(e) => e.currentTarget.style.color = ''}
            title="Take a photo"
          >
            <Camera size={18} strokeWidth={1.5} />
          </button>

          {onStartVoiceConversation && (
            <button
              onClick={onStartVoiceConversation}
              disabled={disabled || voiceConversationActive || isRecording || isTranscribing || generating}
              className={cn(
                "flex-shrink-0 p-2 rounded-full transition-all duration-300 disabled:opacity-50",
                voiceConversationActive ? "animate-pulse" : cn(colors.textMuted, "hover:bg-white/5"),
              )}
              style={voiceConversationActive ? { color: colors.accent, backgroundColor: `${colors.accent}15` } : {}}
              onMouseEnter={(e) => { if (!voiceConversationActive) e.currentTarget.style.color = colors.accent; }}
              onMouseLeave={(e) => { if (!voiceConversationActive) e.currentTarget.style.color = ''; }}
              title={
                isRecording || isTranscribing
                  ? "Finish voice dictation first"
                  : generating
                    ? "Let the current reply finish first"
                    : "Start voice conversation"
              }
              aria-label="Start voice conversation"
            >
              <PhoneCall size={18} strokeWidth={1.5} />
            </button>
          )}

          <button
            onClick={toggleRecording}
            disabled={disabled || isTranscribing || voiceConversationActive}
            className={cn("flex-shrink-0 p-2 rounded-full transition-all duration-300 disabled:opacity-50",
              isRecording ? "animate-pulse" : cn(colors.textMuted, "hover:bg-white/5")
            )}
            style={(isRecording || isTranscribing) ? { color: colors.accent, backgroundColor: `${colors.accent}15` } : {}}
            onMouseEnter={(e) => { if (!isRecording && !isTranscribing) e.currentTarget.style.color = colors.accent; }}
            onMouseLeave={(e) => { if (!isRecording && !isTranscribing) e.currentTarget.style.color = ''; }}
            title={voiceConversationActive ? "Voice conversation is active" : isTranscribing ? "Transcribing…" : isRecording ? "Stop recording" : "Record voice note"}
          >
            {isTranscribing
              ? <Loader2 size={18} strokeWidth={1.5} className="animate-spin" />
              : isRecording
                ? <Square size={18} strokeWidth={1.5} />
                : <Mic size={18} strokeWidth={1.5} />}
          </button>
        </div>

        {(images.length > 0 || documents.length > 0) && (
          <div className="flex flex-wrap gap-2 px-1 pb-1">
            {images.map((img) => (
              <div key={img.id} className="relative">
                <button
                  onClick={() => setPreviewImage(img.previewUrl)}
                  className="block"
                  aria-label="Preview image"
                >
                  <img
                    src={img.previewUrl}
                    alt="Attachment"
                    className={cn("h-16 w-16 rounded-lg object-cover border cursor-pointer hover:opacity-90 transition-opacity", colors.panelBorder)}
                  />
                </button>
                {img.status === 'uploading' && (
                  <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/50 pointer-events-none">
                    <Loader2 size={16} className="animate-spin text-white" />
                  </div>
                )}
                {img.status === 'error' && (
                  <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/60 text-[9px] font-bold tracking-wide pointer-events-none" style={{ color: '#fca5a5' }}>
                    FAILED
                  </div>
                )}
                <button
                  onClick={() => removeImage(img.id)}
                  className="absolute -top-1.5 -right-1.5 p-0.5 rounded-full transition-colors opacity-90 hover:opacity-100"
                  style={{ backgroundColor: colors.accent, color: 'var(--bytelight-on-accent)' }}
                  aria-label="Remove image"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            {documents.map((doc) => (
              <div key={doc.id} className="relative">
                <div className={cn("flex items-center gap-2 h-16 px-3 rounded-lg border", colors.panelBorder, colors.panelBg)}>
                  <FileText size={16} style={{ color: colors.accent }} />
                  <span className={cn("text-xs font-medium truncate max-w-[160px]", colors.textMain)}>{doc.name}</span>
                </div>
                <button
                  onClick={() => removeDocument(doc.id)}
                  className="absolute -top-1.5 -right-1.5 p-0.5 rounded-full transition-colors opacity-90 hover:opacity-100"
                  style={{ backgroundColor: colors.accent, color: 'var(--bytelight-on-accent)' }}
                  aria-label="Remove document"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="relative">
          {attachment && (
            <div className="relative mb-2 inline-block">
              <img
                src={(() => {
                  try {
                    const url = new URL(attachment.data);
                    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
                  } catch {
                    return '';
                  }
                })()}
                alt="Attachment"
                className="max-h-20 rounded-lg"
              />
              <button
                onClick={() => setAttachment(null)}
                className={cn("absolute -top-2 -right-2 p-1 rounded-full transition-colors opacity-90 hover:opacity-100", colors.userBubbleText)}
                style={{ backgroundColor: colors.accent }}
              >
                <X size={14} />
              </button>
            </div>
          )}
          {/* Textarea + absolutely-positioned send button. The button's
              top/bottom anchors are exactly mirrored, so it stays
              perfectly centred against the pill regardless of how the
              pill auto-grows. Pill gets pr-16 to make space for it. */}
          <div className="relative group">
            <textarea
              ref={textareaRef}
              id="message-input"
              name="message-input"
              value={content}
              onChange={(e) => { setContent(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); }}
              // The tray follows the caret rather than the end of the text, so
              // every way of moving it has to report: typing, arrow keys, and
              // a tap somewhere in the middle of what is already written.
              onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder="Write a message..."
              className={cn(
                "bytelight-composer w-full pl-4 pr-16 py-3 focus:outline-none resize-none min-h-[48px] max-h-[150px] text-[15px] font-medium transition-all duration-300 scrollbar-hide overflow-y-auto rounded-[var(--shape-control)]",
                colors.textMain,
              )}
              style={{ caretColor: colors.accent }}
              rows={1}
              disabled={disabled}
              maxLength={50000}
            />
            {generating && onStopGeneration && (
              <button
                type="button"
                onClick={() => setShowStopConfirm(true)}
                aria-label="Stop generation"
                title="Stop response"
                className={cn(
                  "absolute right-12 bottom-3 flex h-9 w-9 items-center justify-center rounded-lg border opacity-80 transition-all duration-300 hover:opacity-100",
                  colors.panelBorder, colors.textMuted,
                )}
              >
                <Square size={14} fill="currentColor" />
              </button>
            )}
            <button
              onClick={handleSend}
              disabled={!canSend}
              className={cn(
                "bytelight-send-button absolute right-2 bottom-3 flex items-center justify-center w-9 h-9 rounded-full disabled:opacity-50 transition-all duration-300 hover:scale-105 active:scale-95",
                getSendIconColor(themeMode)
              )}
            >
              <SendIcon size={16} strokeWidth={2} />
            </button>
          </div>
        </div>
      </div>

      {/* Image preview modal */}
      {previewImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setPreviewImage(null)}
        >
          <button
            onClick={() => setPreviewImage(null)}
            className="absolute top-4 right-4 p-2 rounded-full bg-black/50 hover:bg-black/70 transition-colors"
            aria-label="Close preview"
          >
            <X size={24} className="text-white" />
          </button>
          <img
            src={previewImage}
            alt="Preview"
            className="max-w-full max-h-full object-contain rounded-lg"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
