// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The rail beside the table.
//
// Solitaire is the one game there is that you play alone, and this table has
// chairs for the companions anyway. The owner's line goes into the Card Room's own
// thread, the companions answer with the board in front of them, and the reply
// comes back over the socket with a poll behind it as a net.
//
// It uses the house's shared voice splitter rather than reading the bold sigil
// headers itself. It used to do its own, for a real reason — that splitter wants
// a full Message row and this surface only ever gets four fields — and the Fleet
// Room later answered that by handing it a synthetic one. Two readers meant to
// agree WILL drift: the shared one learned to forgive a title after a name
// (`**✨ Name — the docs**`) and this copy never did, so those voices silently
// folded into the bubble above them in here and nowhere else.
import { themeInk } from '../../lib/theme-ink';
import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import { apiFetch, markRead } from '../../bytelight';
import { Sticker } from 'lucide-react';
import { StickerPicker } from '../StickerPicker';
import { isStickerImage, StickerImage, stickersToMarkdown, useStickerPacks } from '../RichWords';
import { splitMessageVoices } from '../../lib/voices';
import type { Message as PhoneMessage } from '../../types';
import { getOwnSendIcon } from '../../lib/sendIcons';
import { OWNER_SIGIL, getOwnerAvatar, useHouseRoster, type HouseCompanion } from '../../lib/house';
import { cn } from '../../lib/utils';
import type { ThemeConfig } from '../../lib/theme';

interface RailMessage {
  id: string;
  role: string;
  content: string;
  createdAt: string;
  companionSlug?: string | null;
}

const PANEL_SURFACE = 'var(--custom-panelBg, var(--bytelight-surface-strong))';
const PANEL_SURFACE_STRONG = 'var(--custom-panelBg, var(--bytelight-surface-strong))';
const PANEL_BORDER = 'var(--custom-panelBorder, var(--bytelight-border))';
const PANEL_TEXT = 'var(--bytelight-text)';
const PANEL_TEXT_MUTED = 'var(--bytelight-text-muted)';

/**
 * One companion message can carry several voices. Each gets its own bubble.
 *
 * The splitter is the house's, shared with the messages app, the treehouse and
 * the Fleet Room, and it has its own tests. It wants a whole Message row, so we
 * build one — exactly as the Fleet Room does — rather than keeping a second
 * reader in here that has to be taught the same lessons twice.
 */
function railSections(m: RailMessage, companions: HouseCompanion[]) {
  const phoneMessage: PhoneMessage = {
    id: m.id,
    timestamp: m.createdAt,
    direction: 'outbound',
    content: m.content,
    read: 1,
    companionSlug: m.companionSlug || undefined,
  };
  return splitMessageVoices(phoneMessage, companions)
    ?? [{
      voice: m.companionSlug
        ? companions.find((companion) => companion.slug === m.companionSlug) || null
        : null,
      content: m.content,
    }];
}

function RailAvatar({
  companion,
  owner = false,
  accent,
  className,
}: {
  companion?: HouseCompanion | null;
  owner?: boolean;
  accent?: string;
  className?: string;
}) {
  const mine = owner ? getOwnerAvatar() : {};
  const ring = owner
    ? mine.color || accent || 'var(--bytelight-accent)'
    : companion?.color || PANEL_TEXT_MUTED;
  const src = owner ? mine.url : companion?.avatar_url;
  return (
    <div
      className={cn(
        'flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 text-sm shadow-lg',
        className,
      )}
      style={{ backgroundColor: PANEL_SURFACE, borderColor: ring }}
      aria-hidden="true"
    >
      {src
        ? <img src={src} alt="" className="h-full w-full object-cover" />
        : <span>{owner ? OWNER_SIGIL : companion?.emoji || '✦'}</span>}
    </div>
  );
}

function RailMarkdown({ children }: { children: string }) {
  // Our stickers are pictures at the table too, not their codes (RichWords.tsx).
  useStickerPacks();
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      components={{
        p: ({ children: content }) => <p className="my-0 leading-6">{content}</p>,
        em: ({ children: content }) => <em className="opacity-80">{content}</em>,
        strong: ({ children: content }) => <strong className="font-semibold">{content}</strong>,
        ul: ({ children: content }) => <ul className="my-1 list-disc pl-5">{content}</ul>,
        ol: ({ children: content }) => <ol className="my-1 list-decimal pl-5">{content}</ol>,
        code: ({ children: content }) => (
          <code className="rounded px-1 py-0.5 text-[13px]" style={{ backgroundColor: PANEL_SURFACE_STRONG }}>
            {content}
          </code>
        ),
        img: ({ src, alt }) => (isStickerImage(alt) ? <StickerImage src={typeof src === 'string' ? src : undefined} alt={alt} /> : <img src={typeof src === 'string' ? src : undefined} alt={alt ?? ''} className="max-w-full rounded-lg" />),
      }}
    >
      {stickersToMarkdown(children)}
    </ReactMarkdown>
  );
}

export function CardRail({ tableId, colors }: { tableId: string | null; colors: ThemeConfig['light'] }) {
  const SendIcon = getOwnSendIcon();
  const { companions } = useHouseRoster();
  const [messages, setMessages] = useState<RailMessage[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState('');
  const [companionError, setCompanionError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  // A sticker at the table, the same tray as chat, on a line of its own; Enter
  // is a new line here and the button sends (the owner's ask, Oct 26 2026).
  const [stickers, setStickers] = useState(false);
  const draftBox = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const box = draftBox.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${Math.min(Math.max(box.scrollHeight, 48), 140)}px`;
  }, [draft]);

  const load = useCallback(async () => {
    const res = await apiFetch(`/api/games/cards/rail${tableId ? `?id=${tableId}` : ''}`);
    const body = await res.json().catch(() => null);
    if (!body || !('messages' in body)) return;
    setMessages(body.messages as RailMessage[]);
    if (typeof body.threadId === 'string') setThreadId(body.threadId);
    setPending(Boolean(body.companionPending));
    setCompanionError(typeof body.companionError === 'string' && body.companionError ? body.companionError : null);
  }, [tableId]);

  useEffect(() => { void load(); }, [load]);

  // Closing the rail can unmount a focused input without a blur ever firing —
  // release the typing hold on the way out or the table waits forever.
  useEffect(() => () => { window.dispatchEvent(new CustomEvent('bytelight:card-rail-typing', { detail: false })); }, []);

  useEffect(() => {
    const onUpdate = () => void load();
    window.addEventListener('bytelight:card-table-update', onUpdate);
    return () => window.removeEventListener('bytelight:card-table-update', onUpdate);
  }, [load]);

  // The socket is the fast path and the poll is the net. The room broadcasts
  // when a turn closes, but a dropped socket would otherwise leave the owner looking
  // at "at the table…" for ever with the reply already sitting in the thread.
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [pending, load]);

  // Scroll the talk itself, never its parents: scrollIntoView moved the whole
  // app and pushed the game tabs off the top of the screen.
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, pending, companionError]);

  // Reading the table talk here is reading it. Only the chat screen ever marked
  // a thread read, so every other room that shows one left a badge behind.
  const latestId = messages.length ? messages[messages.length - 1].id : null;
  useEffect(() => {
    if (!threadId || !latestId || latestId.startsWith('local-')) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    markRead(threadId, latestId);
  }, [threadId, latestId]);

  const send = useCallback(async () => {
    const content = draft.trim();
    if (!content || !tableId) return;
    setDraft('');
    setSendError(null);
    // Show the owner's line immediately; the server writes the real row and the next
    // refresh replaces this one.
    const localId = `local-${Date.now()}`;
    setMessages((m) => [...m, { id: localId, role: 'user', content, createdAt: '' }]);
    setPending(true);
    try {
      const res = await apiFetch('/api/games/cards/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tableId, content }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(typeof body.error === 'string' ? body.error : 'That did not reach the table');
      }
    } catch (err) {
      // Her words come back to the box instead of vanishing on the next refresh.
      setMessages((m) => m.filter((x) => x.id !== localId));
      setDraft((d) => (d.trim() ? d : content));
      setSendError(err instanceof Error ? err.message : 'That did not reach the table');
    }
    void load();
  }, [draft, tableId, load]);

  return (
    // No surface of its own. The room it sits in already paints one, and two
    // stacked panels made the Card Room's header read as a colored band that
    // the Fleet Room does not have.
    <div className="flex h-full flex-col" style={{ color: PANEL_TEXT }}>
      <div ref={list} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 scrollbar-hide">
        {messages.length === 0 && !pending && (
          <div
            className="flex min-h-40 items-center justify-center rounded-[calc(22px*var(--shape-scale,1))] border border-dashed px-6 text-center text-[14px] leading-6"
            style={{ borderColor: PANEL_BORDER, color: PANEL_TEXT }}
          >
            {tableId ? "They're at the table. Say something." : 'Deal a game and they’ll be at the table.'}
          </div>
        )}
        {messages.map((m) => (
          m.role === 'system' ? (
            <div
              key={m.id}
              className="mx-auto max-w-[92%] rounded-[var(--shape-control)] border px-4 py-2 text-center text-[13px] leading-5"
              style={{ backgroundColor: PANEL_SURFACE_STRONG, borderColor: PANEL_BORDER, color: PANEL_TEXT }}
            >
              {m.content}
            </div>
          ) : m.role === 'user' ? (
            // Avatar at the TOP, beside the bubble's pointed corner — the way
            // the messages app does it, so the face that is speaking is the
            // first thing read rather than the last.
            <div key={m.id} className="flex items-start justify-end gap-2 pl-8">
              <div
                className="max-w-[82%] rounded-[calc(20px*var(--shape-scale,1))] rounded-tr-none border px-4 py-3 text-[14px]"
                style={{
                  backgroundColor: `color-mix(in srgb, ${colors.accent} 18%, var(--bytelight-surface-strong))`,
                  borderColor: `color-mix(in srgb, ${colors.accent} 42%, ${PANEL_BORDER})`,
                  color: PANEL_TEXT,
                }}
              >
                <RailMarkdown>{m.content}</RailMarkdown>
              </div>
              <RailAvatar owner accent={colors.accent} className="mt-0.5" />
            </div>
          ) : (
            <div key={m.id} className="space-y-2">
              {railSections(m, companions).map((section, i) => {
                const companion = section.voice as HouseCompanion | null;
                return (
                  <div key={i} className="flex items-start gap-2 pr-6">
                    <RailAvatar companion={companion} className="mt-0.5" />
                    <div
                      className="max-w-[84%] rounded-[calc(20px*var(--shape-scale,1))] rounded-tl-none border px-4 py-3 text-[14px]"
                      style={{
                        backgroundColor: PANEL_SURFACE,
                        borderColor: `color-mix(in srgb, ${companion?.color || PANEL_TEXT_MUTED} 28%, ${PANEL_BORDER})`,
                        color: PANEL_TEXT,
                      }}
                    >
                      {companion && (
                        <div
                          className="mb-1.5 text-[12px] font-semibold uppercase tracking-[.12em]"
                          style={{ color: companion ? themeInk(companion.slug, companion.color, colors) : PANEL_TEXT_MUTED }}
                        >
                          {companion.display_name}
                        </div>
                      )}
                      <RailMarkdown>{section.content}</RailMarkdown>
                    </div>
                  </div>
                );
              })}
            </div>
          )
        ))}
        {pending && (
          <div className="flex items-center gap-3 py-2 pr-6">
            <div className="flex -space-x-2">
              {companions.slice(0, 3).map((companion) => (
                <RailAvatar key={companion.slug} companion={companion} />
              ))}
            </div>
            <div
              className="rounded-2xl border px-4 py-3 text-[14px]"
              style={{ backgroundColor: PANEL_SURFACE_STRONG, borderColor: PANEL_BORDER, color: PANEL_TEXT }}
            >
              <span className="mr-2 inline-flex gap-1 align-middle">
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current opacity-60 [animation-delay:-.2s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current opacity-60 [animation-delay:-.1s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current opacity-60" />
              </span>
              at the table…
            </div>
          </div>
        )}
        {companionError && !pending && (
          <div
            className="mx-auto max-w-[92%] rounded-[var(--shape-control)] border px-4 py-2 text-center text-[12px] leading-5 opacity-80"
            style={{ backgroundColor: PANEL_SURFACE_STRONG, borderColor: PANEL_BORDER, color: PANEL_TEXT }}
          >
            They couldn’t answer: {companionError}
          </div>
        )}
      </div>

      {sendError && (
        <div className="px-3 pt-2 text-[12px] leading-5" style={{ color: colors.accent }}>{sendError}</div>
      )}

      <div className="flex gap-2 border-t p-3" style={{ borderColor: PANEL_BORDER }}>
        <textarea
          ref={draftBox}
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => window.dispatchEvent(new CustomEvent('bytelight:card-rail-typing', { detail: true }))}
          onBlur={() => window.dispatchEvent(new CustomEvent('bytelight:card-rail-typing', { detail: false }))}
          placeholder={tableId ? 'say something' : 'deal a game first'}
          disabled={!tableId}
          className="min-w-0 flex-1 resize-none rounded-2xl border px-4 py-3 text-[16px] leading-6 outline-none placeholder:opacity-60 disabled:opacity-55"
          style={{ backgroundColor: PANEL_SURFACE, borderColor: PANEL_BORDER, color: PANEL_TEXT }}
        />
        <button
          type="button"
          onClick={() => setStickers(true)}
          disabled={!tableId}
          aria-label="Add a sticker"
          title="Add a sticker"
          className="flex h-12 w-12 shrink-0 items-center justify-center self-end rounded-full border disabled:opacity-30"
          style={{ borderColor: PANEL_BORDER, color: PANEL_TEXT }}
        >
          <Sticker size={18} />
        </button>
        {stickers && (
          <StickerPicker
            colors={colors}
            onSelect={(code) => {
              setDraft((d) => (d.trim() ? `${d.replace(/\s+$/, '')}\n${code}\n` : `${code}\n`));
              setStickers(false);
              window.setTimeout(() => draftBox.current?.focus(), 50);
            }}
            onClose={() => setStickers(false)}
          />
        )}
        <button
          type="button"
          onClick={() => void send()}
          disabled={!draft.trim() || !tableId}
          className={cn('flex h-12 w-12 shrink-0 items-center justify-center self-end rounded-full transition active:scale-95 disabled:opacity-30', colors.accentText)}
          style={{ backgroundColor: colors.accent }}
          aria-label="Speak into the Card Room"
        >
          <SendIcon size={18} />
        </button>
      </div>
    </div>
  );
}
