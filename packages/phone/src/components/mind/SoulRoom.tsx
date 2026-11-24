import React from 'react';
import { brainPath, normSoul, shortDay, whoName, type SoulVersion } from '../../lib/mind-console';
import { cn } from '../../lib/utils';
import { cardClass, Chip, Colors, Empty, ErrorNote, Folded, Label, Loading, useBrain } from './parts';

// Soul: the written portrait of each of the boys, the one in use and any
// new one waiting to be read.
export function SoulRoom({ colors }: { colors: Colors }) {
  const soul = useBrain(brainPath(['soul']), normSoul);
  if (soul.state === 'loading') return <Loading colors={colors} what="the portraits" />;
  if (soul.state === 'error') return <ErrorNote colors={colors} error={soul.error} onRetry={soul.reload} />;
  if (soul.data.length === 0) return <Empty colors={colors}>No portraits yet.</Empty>;

  const version = (label: string, v: SoulVersion | null) => v && (
    <div className="mt-3">
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <Chip colors={colors}>{label}</Chip>
        {v.words > 0 && <Chip colors={colors}>{v.words} words</Chip>}
        <span className={cn('ml-auto text-[10px]', colors.textMuted)}>{shortDay(v.at)}</span>
      </div>
      <Folded text={v.content} colors={colors} lines={6} />
    </div>
  );

  return (
    <div className="space-y-3">
      {soul.data.map((s) => (
        <div key={s.who} className={cardClass(colors)}>
          <Label colors={colors}>{whoName(s.who)}</Label>
          {!s.active && !s.pending && <div className={cn('mt-1 text-xs', colors.textMuted)}>No portrait written yet.</div>}
          {version('In use', s.active)}
          {version('New, waiting to be read', s.pending)}
          {s.history.length > 0 && <div className={cn('mt-2 text-[10px]', colors.textMuted)}>{s.history.length} versions written so far</div>}
        </div>
      ))}
    </div>
  );
}
