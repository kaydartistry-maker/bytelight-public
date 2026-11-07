// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import React, { useState, useEffect } from 'react';
import { motion, useAnimation, PanInfo } from 'motion/react';
import { LockClock } from './LockClock';
import { useWeather } from './useWeather';
import { ageLabel, type ClockAt, type LockFace, type LockPiece, type LockPosition, type LockShow, type LockSize, type UnreadSummary } from '../lib/lock-clock';
import type { AppDef } from '../lib/apps';
import { apiFetch } from '../bytelight';
import { NOTES_SEEN_KEY, unseenCompanionNote } from '../lib/home-widgets';
import { LockSpotifyCard } from './LockSpotifyCard';
import { moodColor, withAlpha } from '../lib/statuses';
import { useStatuses } from './useStatuses';
import { LOCK_CARD_LOOKS, useLockCardLook, type LockCardChoice } from '../lib/lock-cards';

interface LockFaceDot {
  url: string | null;
  color: string | null;
  name: string;
}

interface LockWriter {
  slug: string;
  name: string;
  color: string | null;
  url: string | null;
}

interface NoteRow { id: string | number; text: string; color: string; timestamp: string; sender: string | null }

/** When Notes was last opened. The first time the lock screen looks, it
 *  starts the clock at now, so only notes left after that count as new. */
function notesSeenAt(): number | null {
  try {
    const raw = localStorage.getItem(NOTES_SEEN_KEY);
    if (raw === null) {
      const now = Date.now();
      localStorage.setItem(NOTES_SEEN_KEY, String(now));
      return now;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

interface LockScreenProps {
  onUnlock: () => void;
  wallpaper?: string;
  face: LockFace;
  position: LockPosition;
  size: LockSize;
  /** Left and right corner shortcuts; a null corner is empty. */
  shortcuts: (AppDef | null)[];
  /** Opens an app straight from the lock screen, the way a phone's corners do. */
  onOpenApp: (app: AppDef) => void;
  show: LockShow;
  unread: UnreadSummary;
  faces: LockFaceDot[];
  /** The Messages app, for the card's tap. */
  messagesApp?: AppDef;
  /** Who can leave a note on the fridge, and the Notes app the note card opens. */
  writers?: LockWriter[];
  notesApp?: AppDef;
  /** The Spotify card's switch (Settings > Lock screen, on unless the owner
   *  turned it off), and the Spotify app a tap on the card opens. */
  spotify?: boolean;
  spotifyApp?: AppDef;
  /** How the cards look: dark, light, or auto, read off the wallpaper behind
   *  them (Settings > Lock screen; lib/lock-cards.ts). Unset is dark. */
  cards?: LockCardChoice;
  /** Where this face's clock was dragged, and how a new spot is kept: hold
   *  the clock, drag it, and let go. */
  clockAt?: ClockAt | null;
  onMoveClock?: (at: ClockAt) => void;
  /** The weather pill moves the same way. */
  weatherAt?: ClockAt | null;
  onMoveWeather?: (at: ClockAt) => void;
  /** Which pieces are showing, and how one is tucked away: dragged up into
   *  the strip at the top. Settings brings it back. */
  showClock?: boolean;
  showWeather?: boolean;
  onHide?: (piece: LockPiece) => void;
}

export function LockScreen({ onUnlock, wallpaper, face, position, size, shortcuts, onOpenApp, show, unread, faces, messagesApp, writers = [], notesApp, spotify = true, spotifyApp, cards = 'dark', clockAt = null, onMoveClock, weatherAt = null, onMoveWeather, showClock = true, showWeather = true, onHide }: LockScreenProps) {
  const [time, setTime] = useState(new Date());
  const weather = useWeather();
  const controls = useAnimation();

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // A note a companion left since Notes was last opened.
  const [notes, setNotes] = useState<NoteRow[]>([]);
  useEffect(() => {
    let gone = false;
    const load = () => apiFetch('/api/notes').then((r) => (r.ok ? r.json() : [])).then((rows) => { if (!gone && Array.isArray(rows)) setNotes(rows); }).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => { gone = true; clearInterval(t); };
  }, []);
  const [seenAt] = useState(notesSeenAt);
  const note = show === 'nothing' ? null : unseenCompanionNote(notes, writers.map((w) => w.slug), seenAt);
  const noteWriter = note ? writers.find((w) => w.slug.toLowerCase() === (note.sender || '').toLowerCase()) : undefined;
  // One look for every card on the lock screen, theirs or read off the wallpaper.
  const look = useLockCardLook(cards, wallpaper);
  const ink = LOCK_CARD_LOOKS[look];
  const messagesCardUp = show !== 'nothing' && unread.count > 0;
  const cardBase = face === 'dateline' ? 184 : 124;
  // How far up each card sits: the messages card on the base, the note and
  // status rows above it, and the Spotify card on top of all of them.
  const messagesStep = messagesCardUp ? (show === 'first-line' && unread.firstLine ? 76 : 60) : 0;
  const noteStep = note ? (show === 'first-line' && note.text.trim() ? 76 : 60) : 0;

  // What Companion A and Companion B are up to, above the note: their moods always, their
  // lines only when the first line is chosen. Nothing when nothing is chosen.
  const statuses = useStatuses();
  const statusRows = show === 'nothing' ? [] : statuses.companions
    .map((s) => ({ s, w: writers.find((w) => w.slug.toLowerCase() === s.companion.toLowerCase()) }))
    .filter((r) => r.w)
    .slice(0, 2);
  const statusStep = statusRows.length > 0
    ? 24 + 2 + statusRows.length * 22 + (statusRows.length - 1) * 6 + 8
    : 0;

  const handleDragEnd = (event: any, info: PanInfo) => {
    if (info.offset.y < -100) {
      onUnlock();
    } else {
      controls.start({ y: 0, transition: { type: 'spring', stiffness: 300, damping: 20 } });
    }
  };

  return (
    <motion.div 
      data-lock-frame=""
      className="absolute inset-0 z-50 flex flex-col items-center justify-end overflow-hidden bg-black text-white"
      initial={{ opacity: 1 }}
      animate={{ opacity: 1 }}
      exit={{ y: '-100%', opacity: 0, transition: { duration: 0.4, ease: 'easeInOut' } }}
    >
      {/* Wallpaper Background */}
      {wallpaper && (
        <div 
          className="absolute inset-0 z-0 bg-cover bg-center opacity-60"
          style={{ backgroundImage: `url(${wallpaper})` }}
        />
      )}
      {!wallpaper && (
        <div className="absolute inset-0 z-0 bg-gradient-to-b from-slate-900 to-black opacity-80" />
      )}

      {/* The clock, in the chosen face (components/LockClock.tsx). Holding it, or
          the weather pill, lifts it, and letting go leaves it there. */}
      <LockClock face={face} position={position} size={size} now={time} weather={weather} at={clockAt} onMove={onMoveClock} weatherAt={weatherAt} onMoveWeather={onMoveWeather} showClock={showClock} showWeather={showWeather} onHide={onHide} />

      {/* Who's written: names only unless the first line is chosen, and
          nothing at all if nothing is chosen. Sits above the dateline row when
          that face is up. */}
      {show !== 'nothing' && unread.count > 0 && (
        <button
          type="button"
          onClick={() => messagesApp && onOpenApp(messagesApp)}
          className={`absolute inset-x-5 z-20 flex items-center gap-3 rounded-2xl border px-4 py-3 text-left ${ink.card}`}
          style={{ bottom: face === 'dateline' ? 'calc(var(--sab, 0px) + 184px)' : 'calc(var(--sab, 0px) + 124px)' }}
        >
          <span className="flex shrink-0 -space-x-2">
            {faces.slice(0, 3).map((f, i) => (
              <span
                key={f.name + i}
                className={`h-[26px] w-[26px] overflow-hidden rounded-full border-2 ${ink.face}`}
                style={{ borderColor: f.color || ink.ring, zIndex: 3 - i }}
              >
                {f.url && <img src={f.url} alt="" className="h-full w-full object-cover" />}
              </span>
            ))}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">
              {unread.count === 1 ? '1 new message' : `${unread.count} new messages`}
              {unread.newestAt !== null && (
                <span className={`font-normal ${ink.muted}`}> · {ageLabel(unread.newestAt, time.getTime())}</span>
              )}
            </span>
            {show === 'first-line' && unread.firstLine && (
              <span className={`block truncate text-xs ${ink.line}`}>{unread.firstLine}</span>
            )}
          </span>
        </button>
      )}

      {/* A note on the fridge: who left it and when, and its first line if
          the first line is chosen. Sits above the messages card when that
          one is up. Opening Notes is what puts it away. */}
      {note && (
        <button
          type="button"
          onClick={() => notesApp && onOpenApp(notesApp)}
          className={`absolute inset-x-5 z-20 flex items-center gap-3 rounded-2xl border px-4 py-3 text-left ${ink.card}`}
          style={{ bottom: `calc(var(--sab, 0px) + ${cardBase + messagesStep}px)` }}
        >
          <span
            className={`h-[26px] w-[26px] shrink-0 overflow-hidden rounded-full border-2 ${ink.face}`}
            style={{ borderColor: noteWriter?.color || ink.ring }}
          >
            {noteWriter?.url && <img src={noteWriter.url} alt="" className="h-full w-full object-cover" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">
              A note from {noteWriter?.name || note.sender}
              {Number.isFinite(Date.parse(note.timestamp)) && (
                <span className={`font-normal ${ink.muted}`}> · {ageLabel(Date.parse(note.timestamp), time.getTime())}</span>
              )}
            </span>
            {show === 'first-line' && note.text.trim() && (
              <span className={`block truncate text-xs ${ink.line}`}>{note.text.trim().split('\n')[0]}</span>
            )}
          </span>
        </button>
      )}

      {/* Their status: who, in their mood's color, and what they're up to.
          Opens Messages. */}
      {statusRows.length > 0 && (
        <button
          type="button"
          onClick={() => messagesApp && onOpenApp(messagesApp)}
          className={`absolute inset-x-5 z-20 flex flex-col gap-1.5 rounded-2xl border px-4 py-3 text-left ${ink.card}`}
          style={{ bottom: `calc(var(--sab, 0px) + ${cardBase + messagesStep + noteStep}px)` }}
        >
          {statusRows.map(({ s, w }) => {
            const tint = moodColor(s.mood);
            return (
              <span key={s.companion} className="flex items-center gap-3">
                <span
                  className={`h-[22px] w-[22px] shrink-0 overflow-hidden rounded-full border-2 ${ink.face}`}
                  style={{ borderColor: tint || w!.color || ink.ring, boxShadow: tint ? `0 0 10px ${withAlpha(tint, 0.5)}` : undefined }}
                >
                  {w!.url && <img src={w!.url} alt="" className="h-full w-full object-cover" />}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">
                  <span className="font-semibold">{w!.name}</span>
                  {s.mood && <span style={{ color: tint || undefined }}> · {s.mood}</span>}
                  {show === 'first-line' && s.line && <span className={ink.muted}> — {s.line}</span>}
                </span>
              </span>
            );
          })}
        </button>
      )}

      {/* What is playing on the owner Spotify, on top of the other cards, while a
          song is playing or paused (Oct 20 2026). Settings turns it off. */}
      {spotify && (
        <LockSpotifyCard
          fetcher={apiFetch}
          base={cardBase + messagesStep + noteStep + statusStep}
          look={look}
          onOpen={spotifyApp ? () => onOpenApp(spotifyApp) : undefined}
        />
      )}

      {/* The two corner shortcuts. Each opens its app straight away. */}
      {shortcuts.map((app, i) => app && (
        <button
          key={(i === 0 ? 'left-' : 'right-') + app.id}
          type="button"
          onClick={() => onOpenApp(app)}
          aria-label={app.name}
          className="absolute z-20 flex h-[52px] w-[52px] items-center justify-center rounded-full border border-white/15 bg-black/40"
          style={{ bottom: 'calc(var(--sab, 0px) + 36px)', [i === 0 ? 'left' : 'right']: 28 }}
        >
          <app.icon size={22} strokeWidth={1.6} className="text-white" />
        </button>
      ))}

      {/* Bottom Section: Swipe to Unlock */}
      <motion.div 
        className="z-10 mb-12 flex flex-col items-center"
        drag="y"
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={0.2}
        onDragEnd={handleDragEnd}
        animate={controls}
      >
        <motion.div 
          className="mb-4 h-1 w-12 rounded-full bg-white/30"
          animate={{ y: [0, -10, 0] }}
          transition={{ repeat: Infinity, duration: 2, ease: "easeInOut" }}
        />
        <p className="text-sm font-medium tracking-widest text-white/50 uppercase">
          Swipe up to unlock
        </p>
      </motion.div>
    </motion.div>
  );
}
