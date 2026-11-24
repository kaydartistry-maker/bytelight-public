import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity, Brain, ChevronLeft, Clock, CloudSun, Feather, Fingerprint, GraduationCap, Heart, HeartPulse,
  Link2, ListTodo, Moon, NotebookPen, RefreshCw, Scale, Search, Sparkles, Users, type LucideIcon,
} from 'lucide-react';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import { useBackHandler } from '../lib/use-back-handler';
import {
  PROPOSAL_CAP, ROOMS, brainGet, brainPath, countLabel, countTensions, normSurface, normWeather,
  roomById, type RoomId, type Weather,
} from '../lib/mind-console';
import { cardClass, Colors, Empty, fetchFn, Label } from './mind/parts';
import { HealthRoom } from './mind/HealthRoom';
import { EntitiesRoom } from './mind/EntitiesRoom';
import { RecentRoom } from './mind/RecentRoom';
import { SurfacingRoom } from './mind/SurfacingRoom';
import { FeelingsRoom } from './mind/FeelingsRoom';
import { ThreadsRoom } from './mind/ThreadsRoom';
import { TensionsRoom } from './mind/TensionsRoom';
import { ProposalsRoom } from './mind/ProposalsRoom';
import { IdentityRoom } from './mind/IdentityRoom';
import { JournalsRoom } from './mind/JournalsRoom';
import { DreamsRoom } from './mind/DreamsRoom';
import { PatternsRoom } from './mind/PatternsRoom';
import { SearchRoom } from './mind/SearchRoom';
import { CortexRoom } from './mind/CortexRoom';
import { KnowledgeRoom } from './mind/KnowledgeRoom';
import { SoulRoom } from './mind/SoulRoom';

// The Mind console: a window onto the brain (Neuralis) through the house's
// hallway at /api/mind/brain/... On top, the brain's inner weather and what
// is pressing; below, a grid of rooms. A room loads only when it is opened.

const ICONS: Record<RoomId, LucideIcon> = {
  surfacing: Sparkles, feelings: Heart, threads: ListTodo, tensions: Scale, identity: Fingerprint,
  entities: Users, journals: NotebookPen, dreams: Moon, proposals: Link2, patterns: Activity,
  search: Search, cortex: Brain, knowledge: GraduationCap, soul: Feather, recent: Clock, health: HeartPulse,
};

interface MindAppProps {
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

interface Front {
  weather: Weather | null;
  weatherError: string | null;
  surfacing: number | null;
  tensions: number | null;
  proposals: number | null;
}

const EMPTY_FRONT: Front = { weather: null, weatherError: null, surfacing: null, tensions: null, proposals: null };

export function MindApp({ themeConfig, themeMode }: MindAppProps) {
  const colors = themeConfig[themeMode];
  const [room, setRoom] = useState<RoomId | null>(null);
  const [front, setFront] = useState<Front>(EMPTY_FRONT);
  const [loadingFront, setLoadingFront] = useState(true);
  // Bumped by a room's refresh button: a new key opens the room afresh.
  const [visit, setVisit] = useState(0);
  const top = useRef<HTMLDivElement>(null);

  // Opening or leaving a room starts at the top, not wherever the grid was.
  useEffect(() => { top.current?.scrollIntoView({ block: 'start' }); }, [room]);

  // The front page: weather and the three pressing counts, side by side.
  // Each tolerates the others failing.
  const loadFront = useCallback(async () => {
    setLoadingFront(true);
    const [w, s, t, p] = await Promise.all([
      brainGet(fetchFn, brainPath(['inner-weather'])),
      brainGet(fetchFn, brainPath(['surface'])),
      brainGet(fetchFn, brainPath(['tensions'])),
      brainGet(fetchFn, brainPath(['proposals'], { status: 'pending' })),
    ]);
    setFront({
      weather: w.ok ? normWeather(w.data) : null,
      weatherError: w.ok ? null : w.error ?? null,
      surfacing: s.ok ? normSurface(s.data).items.length : null,
      tensions: t.ok ? countTensions(t.data) : null,
      proposals: p.ok && Array.isArray(p.data) ? p.data.length : null,
    });
    setLoadingFront(false);
  }, []);

  useEffect(() => { loadFront(); }, [loadFront]);
  useBackHandler(room !== null, () => setRoom(null));

  if (room) {
    const Icon = ICONS[room];
    return (
      <div ref={top} className="space-y-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setRoom(null); loadFront(); }}
            className={cn('inline-flex min-h-[40px] shrink-0 items-center gap-1 rounded-full border px-3 text-xs font-semibold backdrop-blur-md', colors.panelBorder, colors.panelBg, colors.textMain)}
          >
            <ChevronLeft size={14} /> Mind
          </button>
          <Icon size={15} className="shrink-0" style={{ color: colors.accent }} />
          <span className={cn('min-w-0 flex-1 truncate text-sm font-semibold', colors.textMain)}>{roomById(room).label}</span>
          <button onClick={() => setVisit((v) => v + 1)} className={cn('shrink-0 rounded-full p-2.5', colors.textMuted)} aria-label="Refresh this room">
            <RefreshCw size={14} />
          </button>
        </div>
        <RoomView key={`${room}-${visit}`} room={room} colors={colors} />
      </div>
    );
  }

  const w = front.weather;
  const pressing: { room: RoomId; label: string; count: number | null; capped?: boolean }[] = [
    { room: 'surfacing', label: 'Surfacing', count: front.surfacing },
    { room: 'tensions', label: 'Open tensions', count: front.tensions },
    { room: 'proposals', label: 'Waiting', count: front.proposals, capped: front.proposals === PROPOSAL_CAP },
  ];

  return (
    <div ref={top} className="space-y-3">
      <div className={cardClass(colors)}>
        <div className="flex items-center gap-2">
          <CloudSun size={16} style={{ color: colors.accent }} />
          <Label colors={colors}>Inner weather</Label>
          <button onClick={loadFront} className={cn('ml-auto rounded-full p-2', colors.textMuted)} aria-label="Refresh">
            <RefreshCw size={14} className={loadingFront ? 'animate-spin' : undefined} />
          </button>
        </div>
        {w ? (
          <>
            <div className={cn('mt-1 text-base font-semibold capitalize', colors.textMain)}>
              {[w.sky, w.timeOfDay, w.energy].filter(Boolean).join(' · ') || 'Quiet'}
            </div>
            {w.moods.length > 0 && <div className={cn('mt-1 text-xs', colors.textMuted)}>{w.moods.join(', ')}</div>}
            <div className={cn('mt-1 text-[11px]', colors.textMuted)}>
              {w.activeThreads} threads open · {w.highPriority} marked important
            </div>
            {w.pressing.length > 0 && (
              <div className="mt-2 space-y-1">
                {w.pressing.slice(0, 3).map((p, i) => (
                  <p key={i} className={cn('break-words text-xs leading-snug', colors.textMain)} style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    <span className={colors.textMuted}>On their mind · </span>{p.content}
                  </p>
                ))}
              </div>
            )}
          </>
        ) : loadingFront ? (
          <div className={cn('mt-1 text-xs', colors.textMuted)}>Reading the weather…</div>
        ) : (
          <div className="mt-1 text-xs" style={{ color: '#e05252' }}>{front.weatherError ?? "The weather didn't come back."}</div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2">
        {pressing.map((p) => (
          <button key={p.room} onClick={() => setRoom(p.room)} className={cardClass(colors, 'px-2 py-3 text-center')}>
            <div className={cn('text-xl font-bold', colors.textMain)}>{countLabel(p.count, p.capped)}</div>
            <div className={cn('break-words text-[10px] font-semibold uppercase leading-tight tracking-wider', colors.textMuted)}>{p.label}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2">
        {ROOMS.map((r) => {
          const Icon = ICONS[r.id];
          return (
          <button key={r.id} onClick={() => setRoom(r.id)} className={cardClass(colors, 'min-h-[84px] min-w-0 text-left transition-transform active:scale-[0.98]')}>
            <Icon size={16} style={{ color: colors.accent }} />
            <div className={cn('mt-1.5 break-words text-sm font-semibold', colors.textMain)}>{r.label}</div>
            <div className={cn('mt-0.5 text-[11px] leading-snug', colors.textMuted)}>{r.hint}</div>
          </button>
          );
        })}
      </div>
    </div>
  );
}

function RoomView({ room, colors }: { room: RoomId; colors: Colors }) {
  switch (room) {
    case 'health': return <HealthRoom colors={colors} />;
    case 'entities': return <EntitiesRoom colors={colors} />;
    case 'recent': return <RecentRoom colors={colors} />;
    case 'surfacing': return <SurfacingRoom colors={colors} />;
    case 'feelings': return <FeelingsRoom colors={colors} />;
    case 'threads': return <ThreadsRoom colors={colors} />;
    case 'tensions': return <TensionsRoom colors={colors} />;
    case 'proposals': return <ProposalsRoom colors={colors} />;
    case 'identity': return <IdentityRoom colors={colors} />;
    case 'journals': return <JournalsRoom colors={colors} />;
    case 'dreams': return <DreamsRoom colors={colors} />;
    case 'patterns': return <PatternsRoom colors={colors} />;
    case 'search': return <SearchRoom colors={colors} />;
    case 'cortex': return <CortexRoom colors={colors} />;
    case 'knowledge': return <KnowledgeRoom colors={colors} />;
    case 'soul': return <SoulRoom colors={colors} />;
    default: return <Empty colors={colors}>This room isn't furnished yet.</Empty>;
  }
}
