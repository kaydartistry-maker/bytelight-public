// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import { themeInk } from '../lib/theme-ink';
import React, { useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronLeft, ChevronDown, TreePine, Users } from 'lucide-react';
import { ThemeConfig } from '../lib/theme';
import { cn, parseInlineMarkdown } from '../lib/utils';
import { splitWhispers } from '../lib/whisper-lines';
import { splitMessageVoices } from '../lib/voices';
import { apiFetch, markRead } from '../bytelight';
import { normalizeCompanionRows } from '../lib/companion-row';

interface TreehouseAppProps {
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  onClose: () => void;
  userAvatar?: string;
  userAvatarColor?: string;
  ownerName?: string;
}

interface TreehouseMessage {
  id: string;
  role: string;
  companion_slug: string;
  content: string;
  created_at: string;
}

interface TreehouseInfo {
  id: string;
  name: string;
  messageCount: number;
}

interface Companion {
  id: string;
  slug: string;
  display_name: string;
  color: string | null;
  emoji: string | null;
  avatar_url: string | null;
}

// Fallback colors for companions without a set color
const FALLBACK_COLORS = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981'];

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Ported from Aerie. Changes for byte-light: companion rows come through
// normalizeCompanionRows (main's /api/companions speaks id/avatar, not
// slug/avatar_url); the header shows who is seated in the treehouse (its
// roster: Companion A and Companion B) rather than every companion in the house; and the
// shell classes are byte-light's. There is no composer: the owner reads this
// room and the backend refuses a post into it.
export function TreehouseApp({ themeConfig, themeMode, onClose, userAvatar, userAvatarColor, ownerName = 'You' }: TreehouseAppProps) {
  const colors = themeConfig[themeMode];
  const [info, setInfo] = useState<TreehouseInfo | null>(null);
  const [messages, setMessages] = useState<TreehouseMessage[]>([]);
  const [companions, setCompanions] = useState<Companion[]>([]);
  // Who lives here (the treehouse thread's roster); empty until it loads.
  const [residents, setResidents] = useState<Companion[]>([]);
  const faces = residents.length > 0 ? residents : companions;
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const pendingScrollRestore = useRef<{ prevScrollTop: number; prevHeight: number } | null>(null);

  // Build lookup maps from fetched companions
  const companionColors: Record<string, string> = {};
  const companionEmojis: Record<string, string> = {};
  const companionNames: Record<string, string> = {};
  const companionAvatars: Record<string, string | null> = {};
  companions.forEach((c, i) => {
    companionColors[c.slug] = c.color || FALLBACK_COLORS[i % FALLBACK_COLORS.length];
    companionEmojis[c.slug] = c.emoji || '💬';
    companionNames[c.slug] = c.display_name;
    companionAvatars[c.slug] = c.avatar_url;
  });

  // One speaker, one card. Multi-voice replies render several of these.
  const renderCard = (card: {
    key: string;
    name: string;
    color: string;
    avatar: string | null;
    emoji: string;
    createdAt: string;
    content: string;
  }) => (
    <div key={card.key} className={cn('flex gap-3 mb-3 rounded-2xl border p-3 backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center text-sm shrink-0 overflow-hidden border-2"
        style={{ backgroundColor: card.color + '22', borderColor: card.color }}
      >
        {card.avatar ? (
          <img src={card.avatar} className="w-full h-full object-cover" alt={card.name} />
        ) : (
          card.emoji
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 mb-0.5">
          <span className="text-sm font-medium" style={{ color: themeInk(card.name, card.color, colors, themeMode) }}>
            {card.name}
          </span>
          <span className={cn('text-[10px]', colors.textMuted)}>
            {formatTime(card.createdAt)}
          </span>
        </div>
        <p className={cn('text-sm', colors.textMain)}>
          {splitWhispers(card.content).map((run, i) => (
            // A "-# " line is a whisper, drawn the way chat draws one.
            <span
              key={i}
              className={run.whisper ? 'block whitespace-pre-wrap text-[11px] leading-snug opacity-60 italic' : 'block whitespace-pre-wrap'}
            >
              {parseInlineMarkdown(run.text)}
            </span>
          ))}
        </p>
      </div>
    </div>
  );

  const initialLoadDone = useRef(false);

  useEffect(() => {
    loadTreehouse();
  }, []);

  // Reading the treehouse HERE has to count as reading it. The chat screen
  // marks its thread read, but it gates on being the messages screen, so every
  // other surface that shows a thread leaves the badge sitting on the Messages
  // app until the user opens the same conversation a second time. The treehouse is
  // a thread like any other; info.id is its id.
  const latestMessageId = messages.length > 0 ? messages[messages.length - 1].id : null;
  useEffect(() => {
    if (!info?.id || !latestMessageId) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    markRead(info.id, latestMessageId);
  }, [info?.id, latestMessageId]);

  // And again when the user looks back at a tab that was in the background, the way
  // the chat screen does — anything that arrived while it was hidden is on
  // screen the moment the user returns, so it is read.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (!info?.id || !latestMessageId) return;
      markRead(info.id, latestMessageId);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [info?.id, latestMessageId]);

  useEffect(() => {
    // Only scroll to bottom on initial load, not when loading older messages
    if (scrollRef.current && !initialLoadDone.current && messages.length > 0 && !loading) {
      initialLoadDone.current = true;
      // Use multiple timeouts to ensure DOM is fully rendered
      setTimeout(() => scrollToBottom(), 50);
      setTimeout(() => scrollToBottom(), 200);
    }
  }, [messages, loading]);

  // Handle scroll position restoration after loading older messages
  useEffect(() => {
    if (pendingScrollRestore.current && scrollRef.current) {
      const { prevScrollTop, prevHeight } = pendingScrollRestore.current;
      const newHeight = scrollRef.current.scrollHeight;
      const addedHeight = newHeight - prevHeight;
      scrollRef.current.scrollTop = prevScrollTop + addedHeight;
      pendingScrollRestore.current = null;
    }
  }, [messages]);

  function scrollToBottom() {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      setIsAtBottom(true);
    }
  }

  function checkIsAtBottom() {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setIsAtBottom(scrollHeight - scrollTop - clientHeight < 100);
  }

  async function loadTreehouse() {
    setLoading(true);
    try {
      const [infoRes, msgsRes, companionsRes] = await Promise.all([
        apiFetch('/api/treehouse'),
        apiFetch('/api/treehouse/messages?limit=50'),
        apiFetch('/api/companions'),
      ]);
      if (infoRes.ok) {
        const loaded: TreehouseInfo = await infoRes.json();
        setInfo(loaded);
        apiFetch(`/api/threads/${loaded.id}/roster`)
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => { if (data && Array.isArray(data.roster)) setResidents(normalizeCompanionRows(data.roster) as Companion[]); })
          .catch(() => { /* the faces fall back to every companion */ });
      }
      if (msgsRes.ok) {
        const msgs = await msgsRes.json();
        setMessages(msgs);
        setHasMore(msgs.length >= 50);
      }
      if (companionsRes.ok) {
        const data = await companionsRes.json();
        setCompanions(normalizeCompanionRows(data.companions) as Companion[]);
      }
    } catch (err) {
      console.error('Failed to load treehouse:', err);
    } finally {
      setLoading(false);
    }
  }

  async function loadOlderMessages() {
    console.log('[Treehouse] loadOlderMessages called', { loadingMore, hasMore, msgCount: messages.length });
    if (loadingMore || !hasMore || messages.length === 0) {
      console.log('[Treehouse] early return', { loadingMore, hasMore, msgLen: messages.length });
      return;
    }
    setLoadingMore(true);
    const scrollEl = scrollRef.current;
    const prevScrollTop = scrollEl?.scrollTop || 0;
    const prevHeight = scrollEl?.scrollHeight || 0;
    try {
      const oldest = messages[0];
      console.log('[Treehouse] fetching before:', oldest.id);
      const res = await apiFetch(`/api/treehouse/messages?limit=50&before=${oldest.id}`);
      console.log('[Treehouse] response status:', res.status);
      if (res.ok) {
        const older = await res.json();
        console.log('[Treehouse] got older messages:', older.length);
        if (older.length < 50) setHasMore(false);
        if (older.length > 0) {
          pendingScrollRestore.current = { prevScrollTop, prevHeight };
          setMessages(prev => {
            const existingIds = new Set(prev.map(m => m.id));
            const uniqueOlder = older.filter((m: TreehouseMessage) => !existingIds.has(m.id));
            console.log('[Treehouse] adding unique older:', uniqueOlder.length);
            return [...uniqueOlder, ...prev];
          });
        }
      }
    } catch (err) {
      console.error('Failed to load older messages:', err);
    } finally {
      setLoadingMore(false);
    }
  }

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    checkIsAtBottom();
    if (el.scrollTop < 200 && hasMore && !loadingMore) {
      loadOlderMessages();
    }
  }

  // Group messages by date
  const groupedMessages: { date: string; messages: TreehouseMessage[] }[] = [];
  let currentDate = '';
  for (const msg of messages) {
    const msgDate = formatDate(msg.created_at);
    if (msgDate !== currentDate) {
      currentDate = msgDate;
      groupedMessages.push({ date: msgDate, messages: [] });
    }
    groupedMessages[groupedMessages.length - 1].messages.push(msg);
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      className={cn('fixed inset-0 z-30 flex flex-col', colors.textMain)}
    >
      {/* Header */}
      <div className={cn('bytelight-shell-header flex items-center gap-3 px-4 pb-3', colors.pageBg)} style={{ paddingTop: 'calc(var(--sat) + 0.75rem)' }}>
        <button onClick={onClose} className={cn('p-1 rounded-full', colors.textMuted)}>
          <ChevronLeft size={22} />
        </button>
        <div className="flex -space-x-2">
          {faces.map((c, i) => (
            <div
              key={c.slug}
              className="w-8 h-8 rounded-full flex items-center justify-center text-xs border-2 overflow-hidden"
              style={{
                backgroundColor: (c.color || FALLBACK_COLORS[i % FALLBACK_COLORS.length]) + '22',
                borderColor: c.color || FALLBACK_COLORS[i % FALLBACK_COLORS.length],
                zIndex: 10 - i,
              }}
            >
              {c.avatar_url ? (
                <img src={c.avatar_url} className="w-full h-full object-cover" alt={c.display_name} />
              ) : (
                c.emoji || '💬'
              )}
            </div>
          ))}
        </div>
        <div className="flex-1">
          <h1 className={cn('text-base font-semibold', colors.textMain)}>The Treehouse</h1>
          <p className={cn('text-xs', colors.textMuted)}>
            {info ? `${info.messageCount} messages` : 'Loading...'}
          </p>
        </div>
        <TreePine size={20} style={{ color: colors.accent }} />
      </div>

      {/* Messages */}
      <div ref={scrollRef} onScroll={handleScroll} className="bytelight-app-body flex-1 overflow-y-auto scrollbar-hide px-4 py-3 space-y-4">
        {loadingMore && (
          <div className={cn('text-center py-2 text-xs', colors.textMuted)}>Loading older...</div>
        )}
        {loading ? (
          <div className={cn('rounded-2xl border p-3 backdrop-blur-md text-center py-8 text-sm', colors.panelBg, colors.panelBorder, colors.textMuted)}>
            Loading treehouse...
          </div>
        ) : messages.length === 0 ? (
          <div className={cn('rounded-2xl border p-3 backdrop-blur-md text-center py-8', colors.panelBg, colors.panelBorder, colors.textMuted)}>
            <TreePine size={40} className="mx-auto mb-3 opacity-50" />
            <p className="text-sm">The treehouse is quiet...</p>
            <p className="text-xs mt-1">No conversations yet</p>
          </div>
        ) : (
          groupedMessages.map((group) => (
            <div key={group.date}>
              {/* Date divider */}
              <div className="flex items-center gap-3 my-4">
                <div className={cn('flex-1 h-px', colors.panelBorder)} />
                <span className={cn('text-[10px] font-medium uppercase tracking-wider', colors.textMuted)}>
                  {group.date}
                </span>
                <div className={cn('flex-1 h-px', colors.panelBorder)} />
              </div>
              
              {/* Messages */}
              {group.messages.map((msg) => {
                // The owner wanders in here more than the footer admits. Give
                // them a name and their own face, not an anonymous bubble.
                if (msg.role === 'user') {
                  return renderCard({
                    key: msg.id,
                    name: ownerName,
                    color: userAvatarColor || colors.accent,
                    avatar: userAvatar || null,
                    emoji: '🧡',
                    createdAt: msg.created_at,
                    content: msg.content,
                  });
                }

                // Replies that address the room carry per-voice headers.
                // Run the same splitter the Messages view uses so each voice
                // gets its own card and face rather than all three piling
                // into one block with the headers left as inline bold text.
                const sections = splitMessageVoices(
                  {
                    direction: 'outbound',
                    companionSlug: msg.companion_slug || undefined,
                    content: msg.content,
                  } as any,
                  companions,
                );

                if (!sections || sections.length === 0) {
                  const slug = msg.companion_slug;
                  return renderCard({
                    key: msg.id,
                    name: companionNames[slug] ||
                      (slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : 'The Treehouse'),
                    color: companionColors[slug] || colors.accent,
                    avatar: companionAvatars[slug] ?? null,
                    emoji: companionEmojis[slug] || '💬',
                    createdAt: msg.created_at,
                    content: msg.content,
                  });
                }

                return sections.map((section, i) => {
                  const v = section.voice;
                  return renderCard({
                    key: `${msg.id}-${i}`,
                    name: v?.display_name || 'The Treehouse',
                    color: v?.color || colors.accent,
                    avatar: v?.avatar_url ?? null,
                    emoji: v?.emoji || '💬',
                    createdAt: msg.created_at,
                    content: section.content,
                  });
                });
              })}
            </div>
          ))
        )}
      </div>

      {/* Scroll to bottom button */}
      {!isAtBottom && (
        <button
          onClick={scrollToBottom}
          className={cn(
            'absolute bottom-16 right-4 z-40 flex h-9 w-9 items-center justify-center rounded-full border backdrop-blur-md shadow-md',
            colors.panelBg,
            colors.panelBorder,
            colors.textMain,
          )}
          aria-label="Jump to latest"
        >
          <ChevronDown size={18} />
        </button>
      )}

      {/* Footer - read-only notice */}
      <div className={cn('px-4 py-3 border-t text-center backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
        <p className={cn('text-xs', colors.textMuted)}>
          <Users size={12} className="inline mr-1" />
          Companions only — you're just peeking in
        </p>
      </div>
    </motion.div>
  );
}
