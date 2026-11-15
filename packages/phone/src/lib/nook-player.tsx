// The Reading Nook's audiobook player, lifted to the whole phone (the operator, Nov 9
// 2026: "leaving the Nook stops the audio"). Mounted once in App.tsx, above
// every screen, it owns the one <audio> element, the Media Session, the
// prefetch and the sleep timer (lib/use-audiobook.ts), so the voice keeps
// reading while she moves around the app.
//
// Clients:
// - the Reader starts a book, drives the controls and follows along when it
//   is open on the book being read (components/LibraryApp.tsx);
// - the now-playing bar (components/NookNowPlaying.tsx) shows on the other
//   screens while a book is loaded, and a tap on it asks for the Nook to open
//   straight into that book's reader with the listening view (`openRequest`).

import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../bytelight';
import { useHouseRoster } from './house';
import { chapterParagraphs, chapterSegments, type ChapterText } from './library-reader';
import { useAudiobook, type Audiobook, type AudiobookChapter } from './use-audiobook';

/** A note from the player ("The end.", "Sleep timer: …", a failed render). */
export interface NookNotice { text: string; bookId: number; at: number }

/** The bar asked the Nook to open this book's reader with the listening view. */
export interface NookOpenRequest { bookId: number; at: number }

export interface NookPlayer extends Audiobook {
  notice: NookNotice | null;
  openRequest: NookOpenRequest | null;
  /** Open the Nook on the book in the player (the bar's tap). */
  openNook: () => void;
  /** The Nook took the request; forget it. */
  clearOpenRequest: () => void;
}

const NookPlayerContext = createContext<NookPlayer | null>(null);

interface ChapterResponse extends ChapterText { index: number; title: string }

export function NookPlayerProvider({ onOpenNook, children }: {
  /** Bring the Reading Nook up (App.tsx switches to the library screen). */
  onOpenNook: () => void;
  children: React.ReactNode;
}) {
  const { companions, labelOf } = useHouseRoster();
  const voices = useMemo(() => companions.map((c) => c.slug), [companions]);
  const [notice, setNotice] = useState<NookNotice | null>(null);
  const [openRequest, setOpenRequest] = useState<NookOpenRequest | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadChapter = useCallback(async (bookId: number, n: number): Promise<AudiobookChapter> => {
    const res = await apiFetch(`/api/library/books/${bookId}/chapters/${n}`);
    if (!res.ok) throw new Error('That chapter could not be opened.');
    const ch = (await res.json()) as ChapterResponse;
    return { index: ch.index, title: ch.title, paragraphs: chapterParagraphs(ch), segments: chapterSegments(ch) };
  }, []);

  const saveProgress = useCallback((bookId: number, chapter: number, fraction: number) => {
    void apiFetch(`/api/library/books/${bookId}/progress`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapter, fraction }),
    }).catch(() => { /* the next piece saves again */ });
  }, []);

  const onMessage = useCallback((text: string, bookId: number) => {
    setNotice({ text, bookId, at: Date.now() });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3500);
  }, []);

  const ab = useAudiobook({ voices, labelOf, loadChapter, saveProgress, onMessage });

  const openNookRef = useRef(onOpenNook);
  openNookRef.current = onOpenNook;
  const bookId = ab.book?.id ?? null;
  const openNook = useCallback(() => {
    if (bookId === null) return;
    setOpenRequest({ bookId, at: Date.now() });
    openNookRef.current();
  }, [bookId]);
  const clearOpenRequest = useCallback(() => setOpenRequest(null), []);

  const value: NookPlayer = { ...ab, notice, openRequest, openNook, clearOpenRequest };
  return <NookPlayerContext.Provider value={value}>{children}</NookPlayerContext.Provider>;
}

/** The app-wide player. Throws outside the provider (a wiring mistake). */
export function useNookPlayer(): NookPlayer {
  const p = useContext(NookPlayerContext);
  if (!p) throw new Error('useNookPlayer needs <NookPlayerProvider> above it (App.tsx)');
  return p;
}

/** The player if there is one — for chrome that may render outside the app (tests, previews). */
export function useNookPlayerMaybe(): NookPlayer | null {
  return useContext(NookPlayerContext);
}
