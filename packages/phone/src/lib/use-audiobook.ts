// Audiobook mode (Library slice 5): press play, put the phone down, and the
// companions keep reading, piece after piece and chapter after chapter.
//
// How it keeps going with the screen off: ONE <audio> element lives for as
// long as the reader is open, and each piece is a new `src` on it — never a
// new element — so Android Chrome keeps the page's media session (and its
// notification / lock-screen controls) alive between pieces. The next piece
// is rendered and downloaded as a blob while this one plays, so the hop from
// one to the next is a src swap with no network in between.
//
// Cost guard: only the NEXT piece is ever rendered ahead (one TTS call), and
// the house caches every rendered piece, so listening again costs nothing.
//
// The decisions (what's next, who reads, when the sleep timer stops) are pure
// and tested in lib/library-audiobook.ts.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../bytelight';
import type { Segment } from './library-reader';
import {
  BOTH_VOICES, bookmarkFraction, chapterProgress, fadeVolume, nextPiece, prevPiece, readByLine, resolveSeg,
  seekTarget, sleepMinutes, sleepsAfterThisPiece, tickSleep, validSpeed, voiceFor, type PiecePos, type SleepMode,
} from './library-audiobook';

export const VOICE_KEY = 'bytelight.library.voice';
const SPEED_KEY = 'bytelight.library.speed';
export const SKIP_SECONDS = 15;

export interface AudiobookChapter { index: number; title: string; paragraphs: string[]; segments: Segment[] }
export interface AudiobookBook { id: number; title: string; cover: string | null; chapterCount: number }

export interface AudiobookOptions {
  book: AudiobookBook | null;
  /** Companion slugs in house order; the first two are the Both pair. */
  voices: string[];
  labelOf: (slug: string) => string;
  loadChapter: (n: number) => Promise<AudiobookChapter>;
  saveProgress: (chapter: number, fraction: number) => void;
  onMessage: (msg: string) => void;
}

export interface Audiobook {
  pos: PiecePos | null;
  playing: boolean;
  rendering: boolean;
  /** 0–1 through the chapter now being read. */
  progress: number;
  chapterTitle: string;
  segCount: number;
  pick: string;
  readBy: string;
  speed: number;
  sleep: SleepMode;
  sleepLeftMs: number | null;
  setPick: (pick: string) => void;
  setSpeed: (speed: number) => void;
  setSleep: (mode: SleepMode) => void;
  /** Play/pause. `startAt` is where to begin when nothing is queued yet. */
  toggle: (startAt?: PiecePos) => void;
  playAt: (chapter: number, seg: number) => void;
  pause: () => void;
  /** Stop for good (the player closing, or her turning pages by hand). */
  stop: (opts?: { save?: boolean }) => void;
  nextPieceNow: () => void;
  prevPieceNow: () => void;
  nextChapter: () => void;
  prevChapter: () => void;
  seekBy: (seconds: number) => void;
  /** Hand over a chapter the reader already fetched, so it isn't fetched twice. */
  seed: (ch: AudiobookChapter) => void;
}

function readLocal(key: string): string {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}
function writeLocal(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* a convenience only */ }
}

function absolute(url: string): string {
  try { return new URL(url, window.location.href).href; } catch { return url; }
}

const media = (): MediaSession | null => (typeof navigator !== 'undefined' && 'mediaSession' in navigator ? navigator.mediaSession : null);

export function useAudiobook(opts: AudiobookOptions): Audiobook {
  const o = useRef(opts);
  o.current = opts;

  const [pos, setPos] = useState<PiecePos | null>(null);
  const [playing, setPlaying] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [progress, setProgress] = useState(0);
  const [chapterTitle, setChapterTitle] = useState('');
  const [segCount, setSegCount] = useState(0);
  const [pick, setPickState] = useState(() => readLocal(VOICE_KEY));
  const [speed, setSpeedState] = useState(() => validSpeed(readLocal(SPEED_KEY) || 1));
  const [sleep, setSleepState] = useState<SleepMode>('off');
  const [sleepLeftMs, setSleepLeftMs] = useState<number | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const token = useRef(0);
  const posRef = useRef<PiecePos | null>(null);
  const pickRef = useRef(pick);
  const speedRef = useRef(speed);
  const sleepRef = useRef<SleepMode>('off');
  const sleepLeft = useRef(0);
  const lastTick = useRef(0);
  const switching = useRef(false);
  const loadedKey = useRef<string | null>(null);
  const chapters = useRef(new Map<number, AudiobookChapter>());
  const urls = useRef(new Map<string, string>());
  const blobs = useRef(new Map<string, string>());
  pickRef.current = pick;
  speedRef.current = speed;

  const pair = useMemo(() => opts.voices.slice(0, 2), [opts.voices]);
  const pairRef = useRef(pair);
  pairRef.current = pair;

  // Keep her pick if they still live here (Both needs two), else the first.
  useEffect(() => {
    const v = opts.voices;
    if (!v.length) return;
    const ok = pick === BOTH_VOICES ? v.length >= 2 : v.includes(pick);
    if (!ok) setPickState(v[0]);
  }, [opts.voices, pick]);

  // ── the pieces ──
  const chapterAt = useCallback(async (n: number): Promise<AudiobookChapter> => {
    const have = chapters.current.get(n);
    if (have) return have;
    const ch = await o.current.loadChapter(n);
    chapters.current.set(n, ch);
    return ch;
  }, []);

  const seed = useCallback((ch: AudiobookChapter) => { chapters.current.set(ch.index, ch); }, []);

  const keyOf = (chapter: number, seg: number, voice: string) => `${chapter}-${seg}-${voice}`;

  async function render(chapter: number, seg: number, voice: string): Promise<string> {
    const key = keyOf(chapter, seg, voice);
    const blob = blobs.current.get(key);
    if (blob) return blob;
    const have = urls.current.get(key);
    if (have) return have;
    const bookId = o.current.book?.id;
    const res = await apiFetch(`/api/library/books/${bookId}/chapters/${chapter}/segments/${seg}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error === 'voice_unavailable' ? 'Read-aloud needs a voice set up on the house.' : data.error || 'Read-aloud failed');
    }
    urls.current.set(key, data.url as string);
    return data.url as string;
  }

  /** Render the piece and bring its audio onto the phone, ready to swap in. */
  async function warm(chapter: number, seg: number, voice: string) {
    const key = keyOf(chapter, seg, voice);
    if (blobs.current.has(key)) return;
    const url = await render(chapter, seg, voice);
    try {
      const res = await apiFetch(url);
      if (!res.ok) return;
      const b = await res.blob();
      blobs.current.set(key, URL.createObjectURL(b));
    } catch { /* it will stream from the house instead */ }
  }

  /** Let go of downloaded pieces other than the ones now and next. */
  function prune(keep: string[]) {
    for (const [key, href] of blobs.current) {
      if (keep.includes(key)) continue;
      URL.revokeObjectURL(href);
      blobs.current.delete(key);
    }
  }

  function audio(): HTMLAudioElement {
    if (audioRef.current) return audioRef.current;
    const a = new Audio();
    a.preload = 'auto';
    a.addEventListener('ended', () => h.current.onEnded());
    a.addEventListener('timeupdate', () => h.current.onTime());
    a.addEventListener('play', () => { lastTick.current = Date.now(); setPlaying(true); setMediaState('playing'); });
    a.addEventListener('pause', () => h.current.onPause());
    a.addEventListener('loadedmetadata', () => setPositionState());
    a.addEventListener('ratechange', () => setPositionState());
    a.addEventListener('seeked', () => setPositionState());
    audioRef.current = a;
    return a;
  }

  // ── lock screen ──
  function setMediaState(state: MediaSessionPlaybackState) {
    const ms = media();
    if (ms) ms.playbackState = state;
  }

  function setPositionState() {
    const ms = media();
    const a = audioRef.current;
    if (!ms?.setPositionState || !a) return;
    try {
      if (Number.isFinite(a.duration) && a.duration > 0) {
        ms.setPositionState({ duration: a.duration, playbackRate: a.playbackRate || 1, position: Math.min(a.currentTime, a.duration) });
      }
    } catch { /* an older Chrome without position state */ }
  }

  function setMetadata(chTitle: string) {
    const ms = media();
    const book = o.current.book;
    if (!ms || !book || typeof MediaMetadata === 'undefined') return;
    try {
      ms.metadata = new MediaMetadata({
        title: book.title,
        artist: readByLine(pickRef.current, pairRef.current, o.current.labelOf),
        album: chTitle,
        artwork: book.cover ? [{ src: absolute(book.cover) }] : [],
      });
    } catch { /* metadata is a nicety */ }
  }

  // ── playing ──
  function savePlace() {
    const p = posRef.current;
    const ch = p ? chapters.current.get(p.chapter) : null;
    if (!p || !ch) return;
    const a = audioRef.current;
    const within = a && Number.isFinite(a.duration) && a.duration > 0 ? a.currentTime / a.duration : 0;
    o.current.saveProgress(p.chapter, bookmarkFraction(ch.segments, p.seg, ch.paragraphs.length, within));
  }

  function place(p: PiecePos | null, ch?: AudiobookChapter) {
    posRef.current = p;
    setPos(p);
    if (ch) {
      setChapterTitle(ch.title);
      setSegCount(ch.segments.length);
      if (p) setProgress(chapterProgress(p.seg, ch.segments.length, 0, 0));
    }
  }

  function halt() {
    token.current++;
    switching.current = false;
    audioRef.current?.pause();
    setPlaying(false);
    setRendering(false);
    setMediaState('paused');
  }

  function theEnd(last: PiecePos) {
    halt();
    o.current.saveProgress(last.chapter, 1);
    loadedKey.current = null;
    o.current.onMessage('The end.');
  }

  async function playAt(chapter: number, seg: number, direction: 1 | -1 = 1) {
    const book = o.current.book;
    if (!book) return;
    const t = ++token.current;
    setPlaying(true);
    setRendering(true);
    try {
      let n = chapter;
      let s = seg;
      let ch = await chapterAt(n);
      // A chapter with nothing to read is passed over in the direction of travel.
      while (ch.segments.length === 0) {
        n += direction;
        if (n < 0 || n >= book.chapterCount) { if (t === token.current) theEnd({ chapter: n - direction, seg: 0 }); return; }
        ch = await chapterAt(n);
        s = direction > 0 ? 0 : -1;
      }
      if (t !== token.current) return;
      s = resolveSeg(s, ch.segments.length);
      place({ chapter: n, seg: s }, ch);
      const voice = voiceFor(pickRef.current, s, pairRef.current);
      if (!voice) throw new Error('Pick who reads first.');
      const url = await render(n, s, voice);
      if (t !== token.current) return;
      const a = audio();
      const key = keyOf(n, s, voice);
      switching.current = true;
      a.src = url;
      loadedKey.current = key;
      a.defaultPlaybackRate = speedRef.current;
      a.playbackRate = speedRef.current;
      a.preservesPitch = true;
      // A fresh piece starts at full voice, unless the minute timer is mid-fade.
      a.volume = sleepMinutes(sleepRef.current) === null ? 1 : fadeVolume(sleepLeft.current / 1000);
      setMetadata(ch.title);
      await a.play();
      switching.current = false;
      if (t !== token.current) return;
      setRendering(false);
      setMediaState('playing');
      o.current.saveProgress(n, bookmarkFraction(ch.segments, s, ch.paragraphs.length));
      void prefetchAfter({ chapter: n, seg: s }, ch.segments.length, key, t);
    } catch (err) {
      switching.current = false;
      if (t !== token.current) return;
      halt();
      o.current.onMessage(err instanceof Error ? err.message : 'Read-aloud failed');
    }
  }

  /** The next piece only — never more (each render spends voice credit). */
  async function prefetchAfter(p: PiecePos, count: number, nowKey: string, t: number) {
    const book = o.current.book;
    if (!book) return;
    const step = nextPiece(p, count, book.chapterCount);
    if (step.kind === 'end') { prune([nowKey]); return; }
    try {
      const ch = await chapterAt(step.chapter);
      if (t !== token.current || !ch.segments.length) return;
      const voice = voiceFor(pickRef.current, step.seg, pairRef.current);
      if (!voice) return;
      const nextKey = keyOf(step.chapter, step.seg, voice);
      prune([nowKey, nextKey]);
      await warm(step.chapter, step.seg, voice);
    } catch { /* it renders when its turn comes */ }
  }

  function onEnded() {
    const p = posRef.current;
    const book = o.current.book;
    if (!p || !book) return;
    lastTick.current = 0;
    const count = chapters.current.get(p.chapter)?.segments.length ?? 0;
    const step = nextPiece(p, count, book.chapterCount);
    if (sleepsAfterThisPiece(sleepRef.current, p.seg, count)) {
      halt();
      if (audioRef.current) audioRef.current.volume = 1;
      setSleep('off');
      loadedKey.current = null;
      if (step.kind === 'piece') {
        // Wake up to the next chapter's first words.
        o.current.saveProgress(step.chapter, 0);
        posRef.current = { chapter: step.chapter, seg: 0 };
        setPos(posRef.current);
      } else {
        o.current.saveProgress(p.chapter, 1);
      }
      o.current.onMessage('Sleep timer: stopped at the end of the chapter.');
      return;
    }
    if (step.kind === 'end') { theEnd(p); return; }
    void playAt(step.chapter, step.seg, 1);
  }

  function onPause() {
    const a = audioRef.current;
    // A piece ending, or the src swapping to the next one, isn't her pausing.
    if (!a || a.ended || switching.current) return;
    lastTick.current = 0;
    setPlaying(false);
    setMediaState('paused');
    savePlace();
  }

  function onTime() {
    const a = audioRef.current;
    const p = posRef.current;
    if (!a || !p || a.paused) { lastTick.current = 0; return; }
    const count = chapters.current.get(p.chapter)?.segments.length ?? 0;
    // Coarse steps, so the page under the player isn't redrawn four times a second.
    setProgress(Math.round(chapterProgress(p.seg, count, a.currentTime, a.duration) * 200) / 200);
    const now = Date.now();
    const elapsed = lastTick.current ? now - lastTick.current : 0;
    lastTick.current = now;
    const mode = sleepRef.current;
    if (sleepMinutes(mode) !== null) {
      sleepLeft.current = tickSleep(sleepLeft.current, elapsed);
      setSleepLeftMs(Math.ceil(sleepLeft.current / 60_000) * 60_000);
      a.volume = fadeVolume(sleepLeft.current / 1000);
      if (sleepLeft.current <= 0) {
        a.pause();
        a.volume = 1;
        setSleep('off');
        o.current.onMessage('Sleep timer: paused. Your place is saved.');
      }
    } else if (mode === 'chapter' && p.seg >= count - 1 && Number.isFinite(a.duration)) {
      a.volume = fadeVolume((a.duration - a.currentTime) / (a.playbackRate || 1));
    }
  }

  const h = useRef({ onEnded, onPause, onTime });
  h.current = { onEnded, onPause, onTime };

  // ── her controls ──
  function pause() {
    if (rendering) { halt(); return; }
    audioRef.current?.pause();
  }

  function toggle(startAt?: PiecePos) {
    const a = audioRef.current;
    if (playing) { pause(); return; }
    const p = posRef.current;
    const voice = p ? voiceFor(pickRef.current, p.seg, pairRef.current) : '';
    if (a && p && !a.ended && loadedKey.current === keyOf(p.chapter, p.seg, voice)) {
      void a.play().catch(() => setPlaying(false));
      return;
    }
    const from = p ?? startAt ?? { chapter: 0, seg: 0 };
    void playAt(from.chapter, from.seg);
  }

  function stop(opts?: { save?: boolean }) {
    if (opts?.save && posRef.current) savePlace();
    halt();
    loadedKey.current = null;
    audioRef.current?.removeAttribute('src');
    place(null);
    setSleep('off');
    setMediaState('none');
  }

  function nextPieceNow() {
    const p = posRef.current;
    const book = o.current.book;
    if (!p || !book) return;
    const count = chapters.current.get(p.chapter)?.segments.length ?? 0;
    const step = nextPiece(p, count, book.chapterCount);
    if (step.kind === 'end') { theEnd(p); return; }
    void playAt(step.chapter, step.seg, 1);
  }

  function prevPieceNow() {
    const p = posRef.current;
    if (!p) return;
    const back = prevPiece(p);
    void playAt(back.chapter, back.seg, -1);
  }

  function nextChapter() {
    const p = posRef.current;
    const book = o.current.book;
    if (!p || !book || p.chapter >= book.chapterCount - 1) return;
    void playAt(p.chapter + 1, 0, 1);
  }

  function prevChapter() {
    const p = posRef.current;
    if (!p) return;
    // Past the chapter's first piece, back goes to the chapter's start.
    void playAt(p.seg > 0 ? p.chapter : Math.max(0, p.chapter - 1), 0, -1);
  }

  function seekBy(seconds: number) {
    const a = audioRef.current;
    if (!a || !loadedKey.current) return;
    a.currentTime = seekTarget(a.currentTime, a.duration, seconds);
  }

  function setPick(next: string) {
    setPickState(next);
    pickRef.current = next;
    writeLocal(VOICE_KEY, next);
    // Swap readers mid-page: the new voice picks up the same piece.
    const p = posRef.current;
    if (playing && p) void playAt(p.chapter, p.seg);
    else loadedKey.current = null;
    if (p) setMetadata(chapterTitle);
  }

  function setSpeed(next: number) {
    const s = validSpeed(next);
    setSpeedState(s);
    speedRef.current = s;
    writeLocal(SPEED_KEY, String(s));
    const a = audioRef.current;
    if (a) { a.defaultPlaybackRate = s; a.playbackRate = s; }
  }

  function setSleep(mode: SleepMode) {
    sleepRef.current = mode;
    setSleepState(mode);
    const mins = sleepMinutes(mode);
    sleepLeft.current = mins === null ? 0 : mins * 60_000;
    setSleepLeftMs(mins === null ? null : sleepLeft.current);
    if (mode === 'off' && audioRef.current) audioRef.current.volume = 1;
  }

  // The notification and lock screen drive the same controls.
  const actions = useRef({ toggle, pause, nextPieceNow, prevPieceNow, seekBy });
  actions.current = { toggle, pause, nextPieceNow, prevPieceNow, seekBy };
  useEffect(() => {
    const ms = media();
    if (!ms) return;
    const set = (action: MediaSessionAction, fn: MediaSessionActionHandler | null) => {
      try { ms.setActionHandler(action, fn); } catch { /* not every action exists everywhere */ }
    };
    set('play', () => { if (posRef.current && audioRef.current?.paused) actions.current.toggle(); });
    set('pause', () => actions.current.pause());
    set('previoustrack', () => actions.current.prevPieceNow());
    set('nexttrack', () => actions.current.nextPieceNow());
    set('seekbackward', (d) => actions.current.seekBy(-(d.seekOffset ?? SKIP_SECONDS)));
    set('seekforward', (d) => actions.current.seekBy(d.seekOffset ?? SKIP_SECONDS));
    set('stop', () => actions.current.pause());
    return () => {
      for (const a of ['play', 'pause', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward', 'stop'] as MediaSessionAction[]) set(a, null);
      try { ms.metadata = null; ms.playbackState = 'none'; } catch { /* fine */ }
    };
  }, []);

  // Leaving the reader puts the book down.
  useEffect(() => () => {
    token.current++;
    const a = audioRef.current;
    if (a) { a.pause(); a.removeAttribute('src'); }
    for (const href of blobs.current.values()) URL.revokeObjectURL(href);
    blobs.current.clear();
  }, []);

  return {
    pos, playing, rendering, progress, chapterTitle, segCount, pick, speed, sleep, sleepLeftMs,
    readBy: readByLine(pick, pair, opts.labelOf),
    setPick, setSpeed, setSleep, toggle,
    playAt: (c, s) => void playAt(c, s),
    pause, stop, nextPieceNow, prevPieceNow, nextChapter, prevChapter, seekBy, seed,
  };
}
