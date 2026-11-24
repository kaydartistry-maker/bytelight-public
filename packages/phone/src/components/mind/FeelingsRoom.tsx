import React, { useState } from 'react';
import { WHO_FILTERS, brainPath, normFeelings, normFeelingsWeek, shortDay, whoName, whoQuery, type FeelingRow, type Who } from '../../lib/mind-console';
import { cn } from '../../lib/utils';
import { ActionRow } from './actions';
import { ShareToChatButton } from './SendToHouse';
import { BackTo, cardClass, Chip, Colors, Detail, Empty, ErrorNote, Label, Loading, Pills, RowCard, useBrain, useSelected } from './parts';

// Feelings: the stream of what the boys felt, newest first, filtered by who
// felt it. On top, the shape of the last seven days.
export function FeelingsRoom({ colors }: { colors: Colors }) {
  const [who, setWho] = useState<Who>('all');
  const week = useBrain(brainPath(['feelings'], { days: 7, who: whoQuery(who) }), normFeelingsWeek);
  const stream = useBrain(brainPath(['feelings', 'recent'], { limit: 40, who: whoQuery(who) }), normFeelings);
  const [open, setOpen] = useSelected<FeelingRow>();

  if (open) return (
    <div className="space-y-3">
      <BackTo colors={colors} onBack={() => setOpen(null)}>All feelings</BackTo>
      <Detail
        colors={colors}
        title={open.emotion || 'A feeling'}
        marks={<>
          <Chip colors={colors}>{whoName(open.who)}</Chip>
          {open.intensity && <Chip colors={colors}>{open.intensity}</Chip>}
          {open.weight && <Chip colors={colors}>{open.weight}</Chip>}
          {open.entity && <Chip colors={colors}>about {open.entity}</Chip>}
          <span className={cn('ml-auto text-[10px]', colors.textMuted)}>{shortDay(open.at)}</span>
        </>}
        text={open.content}
      >
        {open.note && <p className={cn('text-xs italic', colors.textMuted)}>Settled: {open.note}</p>}
        <ActionRow>
          <ShareToChatButton kind="feeling" colors={colors} item={{ id: open.id, content: open.content, who: open.who, emotion: open.emotion, about: open.entity, day: open.at }} />
        </ActionRow>
      </Detail>
    </div>
  );

  return (
    <div className="space-y-3">
      <Pills<Who> colors={colors} value={who} options={WHO_FILTERS} onChange={setWho} />
      {week.state === 'ready' && week.data && (
        <div className={cardClass(colors)}>
          <Label colors={colors}>The last seven days</Label>
          <div className={cn('mt-1 text-sm', colors.textMain)}>{week.data.total} felt · {week.data.open} still open · {week.data.heavyOpen} heavy</div>
          {week.data.emotions.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {week.data.emotions.map((e) => <Chip key={e.emotion} colors={colors}>{e.emotion} {e.count}</Chip>)}
            </div>
          )}
        </div>
      )}
      {stream.state === 'loading' && <Loading colors={colors} what="feelings" />}
      {stream.state === 'error' && <ErrorNote colors={colors} error={stream.error} onRetry={stream.reload} />}
      {stream.state === 'ready' && (stream.data.length === 0
        ? <Empty colors={colors}>{who === 'all' ? 'No feelings logged yet.' : `${whoName(who)} hasn't logged any feelings yet.`}</Empty>
        : stream.data.map((f) => (
          <RowCard key={f.id} colors={colors} onClick={() => setOpen(f)} title={f.emotion} marks={<Chip colors={colors}>{whoName(f.who)}</Chip>} side={shortDay(f.at)} text={f.content} />
        )))}
    </div>
  );
}
