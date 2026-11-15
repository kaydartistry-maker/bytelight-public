// The Reading Nook's now-playing bar: the audiobook player carried out of the
// Nook (the operator, Nov 9 2026). A slim pill in the Soundtrack bar's look — cover,
// the book and who's reading it, play/pause, and × to stop — shown on every
// screen that has a slot for it while a book is loaded (playing, or paused
// mid-book). A tap opens the Nook straight into that book's reader with the
// listening view.
//
// Where it sits (each a slot in the page's own flow, so it never covers
// anything — least of all the chat's composer):
// - Messages: under the thread header (App.tsx);
// - Home: just above the dock (HomeScreen.tsx);
// - every app built on AppShell: under the app's header (AppShell.tsx).
// Not on the lock screen (the phone's own media notification is there), and
// not over the Reader, which carries its own player.

import React, { useState } from 'react';
import { BookOpen, Loader2, Pause, Play, X } from 'lucide-react';
import { useNookPlayerMaybe } from '../lib/nook-player';
import { showsNowPlaying } from '../lib/library-audiobook';
import { thumbSrc } from '../lib/thumb';
import { cn } from '../lib/utils';

export function NookNowPlaying({ hidden = false, className }: { hidden?: boolean; className?: string }) {
  const nook = useNookPlayerMaybe();
  const [coverGone, setCoverGone] = useState<string | null>(null);
  const book = nook?.book ?? null;
  if (!nook || !book || !showsNowPlaying(book.id, hidden)) return null;

  const notice = nook.notice && nook.notice.bookId === book.id ? nook.notice.text : null;
  const cover = book.cover && coverGone !== book.cover ? book.cover : null;
  const where = nook.pos ? nook.chapterTitle || `Chapter ${nook.pos.chapter + 1}` : '';

  return (
    <div className={cn('w-full', className)}>
      <div
        className="flex h-11 w-full items-center gap-2 rounded-full pl-1.5 pr-1"
        style={{
          background: 'var(--bytelight-surface)',
          border: '1px solid var(--bytelight-hairline)',
          color: 'var(--bytelight-text)',
        }}
      >
        <button
          type="button"
          onClick={nook.openNook}
          aria-label={`Open ${book.title} in the Reading Nook`}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          {cover ? (
            <img
              src={thumbSrc(cover, 256)}
              alt=""
              onError={() => setCoverGone(cover)}
              className="h-8 w-6 shrink-0 rounded-[4px] object-cover"
            />
          ) : (
            <span className="flex h-8 w-6 shrink-0 items-center justify-center rounded-[4px] bg-gradient-to-br from-stone-700 to-stone-900 text-stone-100">
              <BookOpen size={12} />
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold leading-tight">{book.title}</span>
            <span className="block truncate text-[10px] leading-tight" style={{ color: 'var(--bytelight-text-muted)' }}>
              {notice ?? [nook.readBy, where].filter(Boolean).join(' · ')}
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={() => nook.toggle()}
          disabled={!nook.pick}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full disabled:opacity-40"
          style={{ background: 'var(--bytelight-accent)', color: 'var(--bytelight-on-accent)' }}
          aria-label={nook.playing ? 'Pause' : 'Read to me'}
        >
          {nook.rendering ? <Loader2 size={15} className="animate-spin" /> : nook.playing ? <Pause size={15} /> : <Play size={15} className="translate-x-px" />}
        </button>
        <button
          type="button"
          onClick={() => nook.stop({ save: true })}
          className="flex h-9 w-8 shrink-0 items-center justify-center rounded-full"
          style={{ color: 'var(--bytelight-text-muted)' }}
          aria-label="Stop and close the book"
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
