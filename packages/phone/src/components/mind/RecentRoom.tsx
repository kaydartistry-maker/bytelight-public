import React from 'react';
import { brainPath, normRecent, shortDay } from '../../lib/mind-console';
import { cn } from '../../lib/utils';
import { cardClass, Chip, Colors, Empty, ErrorNote, Folded, Label, Loading, useBrain } from './parts';

// Recent: the newest notes, journal entries and thread changes, in one place.
export function RecentRoom({ colors }: { colors: Colors }) {
  const recent = useBrain(brainPath(['recent']), normRecent);
  if (recent.state === 'loading') return <Loading colors={colors} what="what's new" />;
  if (recent.state === 'error') return <ErrorNote colors={colors} error={recent.error} onRetry={recent.reload} />;
  const { observations, journals, threads } = recent.data;

  return (
    <div className="space-y-3">
      <Label colors={colors}>Notes</Label>
      {observations.length === 0 ? <Empty colors={colors}>No new notes.</Empty> : observations.map((o) => (
        <div key={o.id} className={cardClass(colors)}>
          <div className="flex flex-wrap items-center gap-2">
            {o.entity && <span className={cn('text-xs font-semibold', colors.textMain)}>{o.entity}</span>}
            {o.emotion && <Chip colors={colors}>{o.emotion}</Chip>}
            {o.weight && <Chip colors={colors}>{o.weight}</Chip>}
            <span className={cn('ml-auto text-[10px]', colors.textMuted)}>{shortDay(o.at)}</span>
          </div>
          <Folded className="mt-2" text={o.content} colors={colors} />
        </div>
      ))}

      <Label colors={colors}>Journal entries</Label>
      {journals.length === 0 ? <Empty colors={colors}>No new entries.</Empty> : journals.map((j) => (
        <div key={j.id} className={cardClass(colors)}>
          <div className="flex items-center gap-2">
            {j.emotion && <Chip colors={colors}>{j.emotion}</Chip>}
            <span className={cn('ml-auto text-[10px]', colors.textMuted)}>{shortDay(j.day)}</span>
          </div>
          <Folded className="mt-2" text={j.content} colors={colors} />
        </div>
      ))}

      <Label colors={colors}>Threads that moved</Label>
      {threads.length === 0 ? <Empty colors={colors}>No thread changes.</Empty> : threads.map((t) => (
        <div key={t.id} className={cardClass(colors)}>
          <div className="flex items-center gap-2">
            <Chip colors={colors}>{t.status}</Chip>
            {t.priority && <Chip colors={colors}>{t.priority}</Chip>}
            <span className={cn('ml-auto text-[10px]', colors.textMuted)}>{shortDay(t.at)}</span>
          </div>
          <Folded className="mt-2" text={t.content} colors={colors} />
        </div>
      ))}
    </div>
  );
}
