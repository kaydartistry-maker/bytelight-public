// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The lock screen's clock, in whichever face the owner picked, modeled on a
// phone's own Personalize page. The lock screen draws it over the wallpaper
// and Settings draws the very same thing small, so the preview picked from
// is never a different drawing from what the lock screen shows.
import React, { useEffect, useRef, useState } from 'react';
import { Cloud, CloudMoon, CloudSun, Moon, Sun, CloudRain, Snowflake, X } from 'lucide-react';
import { clampClockAt, clockParts, type ClockAt, type LockFace, type LockPiece, type LockPosition, type LockSize } from '../lib/lock-clock';
import { haptic } from '../lib/utils';

export interface LockWeather {
  temp: number;
  code: number;
  /** Open-Meteo's own day-or-night flag for the phone's spot; absent on a reading kept from before it was asked for. */
  isDay?: boolean;
  /** Today's high and low, when the reading carried them. */
  high?: number;
  low?: number;
}

/** Day or night where the phone is: the reading's own flag, or the clock if an old reading has none. */
export function isDaytime(weather: Pick<LockWeather, 'isDay'>, now = new Date()): boolean {
  if (typeof weather.isDay === 'boolean') return weather.isDay;
  const hour = now.getHours();
  return hour >= 6 && hour < 19;
}

// A clear night draws a moon, not a sun, and a partly cloudy
// sky draws the cloud with the sun or the moon behind it.
export function weatherIcon(code: number, day = true, className = 'h-4 w-4') {
  if (code <= 1) return day ? <Sun className={`${className} text-yellow-300`} /> : <Moon className={`${className} text-slate-200`} />;
  if (code === 2) return day ? <CloudSun className={`${className} text-yellow-200`} /> : <CloudMoon className={`${className} text-slate-200`} />;
  if (code <= 48) return <Cloud className={`${className} text-white/80`} />;
  if (code <= 67 || code >= 80) return <CloudRain className={`${className} text-blue-300`} />;
  return <Snowflake className={`${className} text-white`} />;
}

interface LockClockProps {
  face: LockFace;
  position: LockPosition;
  size: LockSize;
  now: Date;
  weather: LockWeather | null;
  /** Where the owner dragged this face's clock, or null for its own place. */
  at?: ClockAt | null;
  /** Given on the lock screen and nowhere else: holding the clock picks it
   *  up, and letting go leaves it where the finger is. */
  onMove?: (at: ClockAt) => void;
  /** The weather pill's spot and saving, the same way. */
  weatherAt?: ClockAt | null;
  onMoveWeather?: (at: ClockAt) => void;
  /** Whether each piece is showing; either can be tucked away. */
  showClock?: boolean;
  showWeather?: boolean;
  /** Given on the lock screen: a piece let go of in the strip at the top is
   *  tucked away instead of moved. */
  onHide?: (piece: LockPiece) => void;
}

// How long the clock has to be held before it lifts, and how far a finger
// can wander first; past that it was a swipe, not a hold.
const HOLD_MS = 450;
const HOLD_SLOP = 10;

/** The clock's own block: in the face's place, or wherever it was dragged,
 *  and on the lock screen, the thing a finger holds and moves. */
function Placed({
  piece,
  at,
  onMove,
  onHide,
  layout,
  homeClass,
  homeStyle,
  children,
}: {
  /** Which piece this is, on data-lock-piece: 'clock' or 'weather'. */
  piece: string;
  at: ClockAt | null;
  onMove?: (at: ClockAt) => void;
  /** Let go of in the strip at the top, the piece is tucked away instead. */
  onHide?: () => void;
  /** How the clock's own pieces sit together, wherever it is. */
  layout: string;
  /** Where the face puts it, until it is dragged somewhere else. */
  homeClass: string;
  homeStyle: React.CSSProperties;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<ClockAt | null>(null);
  const liveRef = useRef<ClockAt | null>(null);
  const [overStrip, setOverStrip] = useState(false);
  // armed: the strip only counts once the finger has been outside it, so a
  // piece that lives near the top can be lifted and set down without vanishing.
  const hold = useRef({ timer: 0, x: 0, y: 0, lastX: 0, lastY: 0, grabX: 0, grabY: 0, dragging: false, pointer: -1, armed: false, over: false });

  /** Whether a finger at this height is in the strip at the top. */
  const inStrip = (clientY: number) => {
    const r = strip.current?.getBoundingClientRect();
    const frame = ref.current?.parentElement?.getBoundingClientRect();
    const bottom = r ? r.bottom + 24 : (frame ? frame.top + 96 : 96);
    return clientY <= bottom;
  };
  const trackStrip = (clientY: number) => {
    const h = hold.current;
    if (!onHide) return;
    const inside = inStrip(clientY);
    if (!inside) h.armed = true;
    const over = h.armed && inside;
    if (over !== h.over) { h.over = over; setOverStrip(over); if (over) haptic(20); }
  };

  const show = (next: ClockAt | null) => { liveRef.current = next; setLive(next); };
  const stopTimer = () => { if (hold.current.timer) { window.clearTimeout(hold.current.timer); hold.current.timer = 0; } };
  useEffect(() => stopTimer, []);

  const placeFrom = (clientX: number, clientY: number) => {
    const el = ref.current;
    const frame = el?.parentElement?.getBoundingClientRect();
    if (!el || !frame) return;
    const box = el.getBoundingClientRect();
    show(clampClockAt(clientX - hold.current.grabX - frame.left, clientY - hold.current.grabY - frame.top, box.width, box.height, frame.width, frame.height));
  };

  const handlers = onMove ? {
    onPointerDown: (e: React.PointerEvent) => {
      const h = hold.current;
      stopTimer();
      h.x = h.lastX = e.clientX; h.y = h.lastY = e.clientY; h.pointer = e.pointerId; h.dragging = false;
      h.timer = window.setTimeout(() => {
        h.timer = 0;
        const el = ref.current;
        if (!el) return;
        const box = el.getBoundingClientRect();
        // Held from wherever the finger is on the clock, so it doesn't jump.
        h.grabX = h.lastX - (box.left + box.width / 2);
        h.grabY = h.lastY - (box.top + box.height / 2);
        h.dragging = true;
        h.armed = false; h.over = false; setOverStrip(false);
        haptic(55);
        try { el.setPointerCapture(h.pointer); } catch { /* the finger already left */ }
        placeFrom(h.lastX, h.lastY);
      }, HOLD_MS);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const h = hold.current;
      h.lastX = e.clientX; h.lastY = e.clientY;
      if (!h.dragging) {
        if (Math.hypot(e.clientX - h.x, e.clientY - h.y) > HOLD_SLOP) stopTimer();
        return;
      }
      placeFrom(e.clientX, e.clientY);
      trackStrip(e.clientY);
    },
    onPointerUp: () => {
      stopTimer();
      const h = hold.current;
      if (!h.dragging) return;
      h.dragging = false;
      const spot = liveRef.current;
      const tuck = h.over && !!onHide;
      h.over = false; setOverStrip(false);
      show(null);
      if (tuck) { haptic(55); onHide!(); return; }
      if (spot) onMove(spot);
    },
    onPointerCancel: () => {
      stopTimer();
      hold.current.dragging = false;
      hold.current.over = false; setOverStrip(false);
      show(null);
    },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  } : {};

  const where = live ?? at;
  const placed: React.CSSProperties = where
    ? { left: `${where.x * 100}%`, top: `${where.y * 100}%`, transform: 'translate(-50%, -50%)' }
    : homeStyle;
  const lifted: React.CSSProperties = live
    ? { outline: '2px dashed rgba(255,255,255,0.7)', outlineOffset: 12, borderRadius: 16 }
    : {};
  return (
    <>
      <div
        ref={ref}
        data-lock-piece={piece}
        className={`absolute ${layout} ${where ? 'whitespace-nowrap' : homeClass} ${onMove ? 'pointer-events-auto select-none' : ''}`}
        style={{ ...placed, ...lifted, touchAction: onMove ? 'none' : undefined }}
        {...handlers}
      >
        {children}
      </div>
      {live && (
        <div
          ref={strip}
          className="absolute inset-x-0 flex justify-center"
          style={{ top: 'calc(var(--sat, 0px) + 14px)' }}
        >
          {onHide ? (
            <span
              className="flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors"
              style={overStrip
                ? { background: 'rgba(190, 40, 40, 0.85)', borderColor: 'rgba(255,255,255,0.5)' }
                : { background: 'rgba(0,0,0,0.55)', borderColor: 'rgba(255,255,255,0.2)' }}
            >
              <X className="h-3.5 w-3.5" />
              {overStrip ? 'Let go to hide it' : 'Drag up here to hide'}
            </span>
          ) : (
            <span className="rounded-full border border-white/20 bg-black/55 px-3 py-1 text-xs font-medium">Let go to leave it here</span>
          )}
        </div>
      )}
    </>
  );
}

// Medium is today's clock on every face, so nothing changes until another
// size is picked; every face takes one, not only the classic.
// Top is where the classic clock has always sat.
const CLASSIC_SIZE: Record<LockSize, string> = { s: 'text-4xl', m: 'text-5xl', l: 'text-7xl' };
const STACKED_PX: Record<LockSize, number> = { s: 104, m: 136, l: 168 };
const DATELINE_PX: Record<LockSize, number> = { s: 36, m: 46, l: 60 };
const CLASSIC_TOP: Record<LockPosition, string> = {
  top: 'calc(var(--sat, 0px) + 24px)',
  middle: '34%',
  low: '54%',
};

function WeatherPill({ weather, at, onMove, onHide }: { weather: LockWeather; at: ClockAt | null; onMove?: (at: ClockAt) => void; onHide?: () => void }) {
  return (
    <Placed
      piece="weather"
      at={at}
      onMove={onMove}
      onHide={onHide}
      layout="flex items-center gap-1.5 rounded-[var(--shape-control)] bg-black/30 px-3 py-1.5 border border-white/10"
      homeClass="top-12 right-4"
      homeStyle={{ marginTop: 'var(--sat)' }}
    >
      {weatherIcon(weather.code, isDaytime(weather))}
      <span className="text-xs font-medium">{weather.temp}°F</span>
    </Placed>
  );
}

/** Fills its parent. Nothing in it takes a touch except, on the lock screen,
 *  the clock itself, which lifts when held; the swipe along the bottom
 *  still unlocks. */
export function LockClock({ face, position, size, now, weather, at = null, onMove, weatherAt = null, onMoveWeather, showClock = true, showWeather = true, onHide }: LockClockProps) {
  const t = clockParts(now);
  // The weather pill is its own piece on every face now, the dateline's too,
  // and either piece can be tucked away.
  const pill = weather && showWeather
    ? <WeatherPill weather={weather} at={weatherAt} onMove={onMoveWeather} onHide={onHide ? () => onHide('weather') : undefined} />
    : null;
  const hideClock = onHide ? () => onHide('clock') : undefined;

  if (face === 'stacked') {
    return (
      <div className="pointer-events-none absolute inset-0 z-10 text-white">
        {pill}
        {showClock && (
          <Placed
            piece="clock"
            at={at}
            onMove={onMove}
            onHide={hideClock}
            layout="flex flex-col items-center"
            homeClass="inset-x-0"
            homeStyle={{ top: 'calc(var(--sat, 0px) + 56px)' }}
          >
            <span className="font-normal tabular-nums drop-shadow-lg" style={{ fontSize: STACKED_PX[size], lineHeight: 0.9 }}>
              {t.hour}
            </span>
            <span className="font-normal tabular-nums drop-shadow-lg" style={{ fontSize: STACKED_PX[size], lineHeight: 0.9 }}>
              {t.minute}
            </span>
            <span className="mt-5 text-base font-medium text-white/85 drop-shadow-md">{t.dateShort}</span>
          </Placed>
        )}
      </div>
    );
  }

  if (face === 'dateline') {
    // The top of the screen is left to the picture; the time rides along the
    // bottom, just above the unlock hint, until it is moved. The weather is
    // the pill now, like every face, so it can be moved or tucked away.
    return (
      <div className="pointer-events-none absolute inset-0 z-10 text-white">
        {pill}
        {showClock && (
          <Placed
            piece="clock"
            at={at}
            onMove={onMove}
            onHide={hideClock}
            layout="flex items-baseline justify-center gap-3"
            homeClass="inset-x-0 px-6"
            homeStyle={{ bottom: 'calc(var(--sab, 0px) + 124px)' }}
          >
            <span className="tabular-nums drop-shadow-lg" style={{ fontSize: DATELINE_PX[size], lineHeight: 1 }}>
              {t.short}
            </span>
            <span className="text-sm font-medium text-white/85 drop-shadow-md">{t.dateShort}</span>
          </Placed>
        )}
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-10 text-white">
      {pill}
      {showClock && (
        <Placed
          piece="clock"
          at={at}
          onMove={onMove}
          onHide={hideClock}
          layout="flex flex-col items-center"
          homeClass="inset-x-0"
          homeStyle={{ top: CLASSIC_TOP[position] }}
        >
          <h1 className={`${CLASSIC_SIZE[size]} font-light tracking-tight drop-shadow-lg`}>{t.classic}</h1>
          <p className="mt-1 text-sm font-medium text-white/80 drop-shadow-md">{t.dateLong}</p>
        </Placed>
      )}
    </div>
  );
}

// The phone the preview is drawn at, then shrunk to fit: the faces are laid
// out in real pixels, so they are drawn full size and scaled as one picture.
const PREVIEW_W = 390;
const PREVIEW_H = 844;

/** A small, live copy of the lock screen for Settings. */
export function LockPreview({
  face,
  position,
  size,
  wallpaper,
  width,
  at = null,
  showClock = true,
}: {
  face: LockFace;
  position: LockPosition;
  size: LockSize;
  wallpaper?: string;
  width: number;
  /** Where this face's clock was dragged on the lock screen, if it was. */
  at?: ClockAt | null;
  /** False when the clock is tucked away, so the live preview matches. */
  showClock?: boolean;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const scale = width / PREVIEW_W;
  return (
    <div
      className="relative overflow-hidden bg-black"
      style={{ width, height: PREVIEW_H * scale, borderRadius: 14 * (width / 96) }}
      aria-hidden="true"
    >
      <div
        className="absolute left-0 top-0"
        style={{ width: PREVIEW_W, height: PREVIEW_H, transform: `scale(${scale})`, transformOrigin: 'top left' }}
      >
        {wallpaper ? (
          <div className="absolute inset-0 bg-cover bg-center opacity-60" style={{ backgroundImage: `url(${wallpaper})` }} />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-b from-slate-900 to-black opacity-80" />
        )}
        <LockClock face={face} position={position} size={size} now={now} weather={null} at={at} showClock={showClock} />
      </div>
    </div>
  );
}
