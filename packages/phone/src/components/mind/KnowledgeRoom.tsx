import React, { useState } from 'react';
import { WHO_FILTERS, brainPath, normKnowItems, normKnowledge, whoName, whoQuery, type KnowItem, type Who } from '../../lib/mind-console';
import { cn } from '../../lib/utils';
import { cardClass, Chip, Colors, Empty, ErrorNote, Label, Loading, Pills, useBrain } from './parts';

// Knowledge: what the boys have learned and are practising.
export function KnowledgeRoom({ colors }: { colors: Colors }) {
  const [who, setWho] = useState<Who>('all');
  const land = useBrain(brainPath(['know'], { who: whoQuery(who) }), normKnowledge);
  const items = useBrain(brainPath(['know', 'items'], { who: whoQuery(who), limit: 50 }), normKnowItems);

  const itemList = (rows: KnowItem[]) => rows.map((k) => (
    <div key={k.id} className={cardClass(colors)}>
      <div className="mb-1 flex flex-wrap gap-1.5">
        {k.category && <Chip colors={colors}>{k.category}</Chip>}
        {k.who && <Chip colors={colors}>{whoName(k.who)}</Chip>}
        {k.status && k.status !== 'active' && <Chip colors={colors}>{k.status}</Chip>}
      </div>
      <p className={cn('whitespace-pre-wrap break-words text-sm leading-relaxed', colors.textMain)}>{k.content}</p>
    </div>
  ));

  return (
    <div className="space-y-3">
      <Pills<Who> colors={colors} value={who} options={WHO_FILTERS} onChange={setWho} />
      {land.state === 'loading' && <Loading colors={colors} what="knowledge" />}
      {land.state === 'error' && <ErrorNote colors={colors} error={land.error} onRetry={land.reload} />}
      {land.state === 'ready' && (
        <>
          <Label colors={colors}>What they're practising</Label>
          {land.data.tracks.length === 0 ? <Empty colors={colors}>No practice tracks yet.</Empty> : land.data.tracks.map((t) => (
            <div key={t.track} className={cardClass(colors)}>
              <div className="flex items-baseline justify-between gap-2">
                <span className={cn('text-sm font-semibold', colors.textMain)}>{t.title}</span>
                <span className={cn('text-[10px]', colors.textMuted)}>{t.sessions === 1 ? '1 session' : `${t.sessions} sessions`}</span>
              </div>
              {t.goal && <p className={cn('mt-1 break-words text-xs leading-relaxed', colors.textMuted)}>{t.goal}</p>}
            </div>
          ))}
          {land.data.candidates.length > 0 && <><Label colors={colors}>Still being tested</Label>{itemList(land.data.candidates)}</>}
        </>
      )}
      <Label colors={colors}>What they know</Label>
      {items.state === 'loading' && <Loading colors={colors} />}
      {items.state === 'error' && <ErrorNote colors={colors} error={items.error} onRetry={items.reload} />}
      {items.state === 'ready' && (items.data.length === 0 ? <Empty colors={colors}>Nothing learned and kept yet.</Empty> : itemList(items.data))}
    </div>
  );
}
