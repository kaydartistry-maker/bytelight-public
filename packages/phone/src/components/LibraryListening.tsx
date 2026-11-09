// Audiobook mode's listening view (Library slice 5): the book's cover, who's
// reading, and the controls to put the phone down by — ⟲15 / play / ⟳15,
// chapter skips, speed, and a sleep timer. Opened from the reader's
// headphones; the reader's text keeps following along underneath.
import React from 'react';
import { ChevronDown, X, Play, Pause, Loader2, RotateCcw, RotateCw, SkipBack, SkipForward, Moon } from 'lucide-react';
import type { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import type { HouseCompanion } from '../lib/house';
import type { Audiobook } from '../lib/use-audiobook';
import { SKIP_SECONDS } from '../lib/use-audiobook';
import { BOTH_VOICES, nextSleep, nextSpeed, sleepLabel, speedLabel } from '../lib/library-audiobook';

const READER_FONT = "'Fraunces', Georgia, 'Times New Roman', serif";

export function LibraryListening({ ab, bookTitle, chapterCount, cover, companions, onToggle, onCollapse, onClose, themeConfig, themeMode }: {
  ab: Audiobook;
  /** Play/pause; the reader knows where to begin when nothing is queued. */
  onToggle: () => void;
  bookTitle: string;
  chapterCount: number;
  cover: React.ReactNode;
  companions: HouseCompanion[];
  onCollapse: () => void;
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}) {
  const colors = themeConfig[themeMode];
  const chip = (active: boolean) => cn(
    'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
    active ? 'border-transparent' : cn(colors.panelBorder, colors.textMain),
  );
  const activeStyle = { background: colors.accent, color: 'var(--bytelight-on-accent)' };
  const voices = [
    ...companions.map((c) => ({ id: c.slug, label: c.display_name || c.slug })),
    ...(companions.length >= 2 ? [{ id: BOTH_VOICES, label: 'Both' }] : []),
  ];
  const chapter = ab.pos?.chapter ?? null;
  const ready = ab.pos !== null;

  return (
    <div className={cn('absolute inset-0 z-40 flex flex-col overflow-y-auto backdrop-blur-xl', colors.panelBg)}>
      <div className="flex items-center justify-between px-3 pt-3">
        <button onClick={onCollapse} className={cn('rounded-full p-2', colors.textMuted)} aria-label="Back to the page" title="Back to the page">
          <ChevronDown size={20} />
        </button>
        <span className={cn('text-[11px] font-semibold uppercase tracking-[0.18em]', colors.textMuted)}>Listening</span>
        <button onClick={onClose} className={cn('rounded-full p-2', colors.textMuted)} aria-label="Stop and close" title="Stop and close">
          <X size={18} />
        </button>
      </div>

      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col items-center px-6 pb-8 pt-4">
        <div className="aspect-[2/3] w-44 overflow-hidden rounded-xl shadow-2xl">{cover}</div>

        <h2 className={cn('mt-5 text-center text-lg font-semibold leading-snug', colors.textMain)} style={{ fontFamily: READER_FONT }}>{bookTitle}</h2>
        <p className={cn('mt-1 text-center text-xs', colors.textMuted)}>
          {ab.chapterTitle || (chapter !== null ? `Chapter ${chapter + 1}` : 'Press play to begin')}
        </p>
        {ab.readBy && <p className={cn('mt-0.5 text-center text-xs italic', colors.textMuted)}>{ab.readBy}</p>}

        <div className="mt-4 flex flex-wrap justify-center gap-2" role="radiogroup" aria-label="Who reads">
          {voices.map((v) => (
            <button
              key={v.id}
              role="radio"
              aria-checked={ab.pick === v.id}
              onClick={() => ab.setPick(v.id)}
              className={chip(ab.pick === v.id)}
              style={ab.pick === v.id ? activeStyle : undefined}
            >
              {v.label}
            </button>
          ))}
        </div>

        <div className="mt-6 w-full">
          <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: `color-mix(in srgb, ${colors.accent} 18%, transparent)` }}>
            <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${Math.round(ab.progress * 1000) / 10}%`, background: colors.accent }} />
          </div>
          <div className={cn('mt-1.5 flex justify-between text-[10px] tabular-nums', colors.textMuted)}>
            <span>{chapter !== null ? `Chapter ${chapter + 1} of ${chapterCount}` : `${chapterCount} chapters`}</span>
            <span>{ready && ab.segCount ? `${(ab.pos?.seg ?? 0) + 1} / ${ab.segCount}` : ''}</span>
          </div>
        </div>

        <div className="mt-5 flex w-full items-center justify-between">
          <button
            onClick={ab.prevChapter}
            disabled={!ready || (chapter === 0 && ab.pos?.seg === 0)}
            className={cn('rounded-full p-2 disabled:opacity-30', colors.textMain)}
            aria-label="Previous chapter"
          >
            <SkipBack size={20} />
          </button>
          <button onClick={() => ab.seekBy(-SKIP_SECONDS)} disabled={!ready} className={cn('relative rounded-full p-2 disabled:opacity-30', colors.textMain)} aria-label={`Back ${SKIP_SECONDS} seconds`}>
            <RotateCcw size={26} />
            <span className="absolute inset-0 flex items-center justify-center text-[8px] font-bold">{SKIP_SECONDS}</span>
          </button>
          <button
            onClick={onToggle}
            disabled={!ab.pick}
            className="rounded-full p-4 shadow-lg disabled:opacity-40"
            style={activeStyle}
            aria-label={ab.playing ? 'Pause' : 'Read to me'}
          >
            {ab.rendering ? <Loader2 size={26} className="animate-spin" /> : ab.playing ? <Pause size={26} /> : <Play size={26} className="translate-x-0.5" />}
          </button>
          <button onClick={() => ab.seekBy(SKIP_SECONDS)} disabled={!ready} className={cn('relative rounded-full p-2 disabled:opacity-30', colors.textMain)} aria-label={`On ${SKIP_SECONDS} seconds`}>
            <RotateCw size={26} />
            <span className="absolute inset-0 flex items-center justify-center text-[8px] font-bold">{SKIP_SECONDS}</span>
          </button>
          <button
            onClick={ab.nextChapter}
            disabled={!ready || chapter === null || chapter >= chapterCount - 1}
            className={cn('rounded-full p-2 disabled:opacity-30', colors.textMain)}
            aria-label="Next chapter"
          >
            <SkipForward size={20} />
          </button>
        </div>

        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button onClick={() => ab.setSpeed(nextSpeed(ab.speed))} className={chip(false)} aria-label={`Speed ${speedLabel(ab.speed)}`}>
            {speedLabel(ab.speed)}
          </button>
          <button
            onClick={() => ab.setSleep(nextSleep(ab.sleep))}
            className={cn(chip(ab.sleep !== 'off'), 'flex items-center gap-1.5')}
            style={ab.sleep !== 'off' ? activeStyle : undefined}
            aria-label="Sleep timer"
          >
            <Moon size={13} /> {sleepLabel(ab.sleep, ab.sleepLeftMs)}
          </button>
        </div>
      </div>
    </div>
  );
}
