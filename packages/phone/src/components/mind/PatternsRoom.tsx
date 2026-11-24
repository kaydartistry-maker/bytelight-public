import React from 'react';
import { brainPath, normPatterns, normPersonality, whoName } from '../../lib/mind-console';
import { cn } from '../../lib/utils';
import { cardClass, Chip, Colors, Empty, ErrorNote, Label, Loading, useBrain } from './parts';

// Patterns: who and what has been alive this week, how the notes are
// settling, and the personality each of the boys keeps showing.
export function PatternsRoom({ colors }: { colors: Colors }) {
  const patterns = useBrain(brainPath(['patterns']), normPatterns);
  const personality = useBrain(brainPath(['personality']), normPersonality);

  const tallies = (title: string, rows: { label: string; count: number }[]) => (
    <div className={cardClass(colors)}>
      <Label colors={colors}>{title}</Label>
      {rows.length === 0 ? <div className={cn('mt-1 text-xs', colors.textMuted)}>Nothing yet.</div> : (
        <div className="mt-2 flex flex-wrap gap-1.5">{rows.map((r) => <Chip key={r.label} colors={colors}>{r.label} {r.count}</Chip>)}</div>
      )}
    </div>
  );

  return (
    <div className="space-y-3">
      {patterns.state === 'loading' && <Loading colors={colors} what="patterns" />}
      {patterns.state === 'error' && <ErrorNote colors={colors} error={patterns.error} onRetry={patterns.reload} />}
      {patterns.state === 'ready' && (
        <>
          <div className={cardClass(colors)}>
            <Label colors={colors}>Alive in the last {patterns.data.days} days</Label>
            {patterns.data.alive.length === 0
              ? <div className={cn('mt-1 text-xs', colors.textMuted)}>No new notes about anyone this week.</div>
              : <div className="mt-2 space-y-1">{patterns.data.alive.map((a) => (
                <div key={a.name} className={cn('flex justify-between gap-2 text-sm', colors.textMain)}><span className="break-words">{a.name}</span><span className={colors.textMuted}>{a.count}</span></div>
              ))}</div>}
          </div>
          {tallies('How heavy this week was', patterns.data.weights)}
          {tallies('How the notes are settling', patterns.data.charges)}
          {tallies('How much they matter', patterns.data.salience)}
          {patterns.data.foundational.length > 0 && (
            <div className={cardClass(colors)}>
              <Label colors={colors}>Foundations</Label>
              <div className="mt-2 flex flex-wrap gap-1.5">{patterns.data.foundational.map((f) => <Chip key={f} colors={colors}>{f}</Chip>)}</div>
            </div>
          )}
        </>
      )}

      <Label colors={colors}>Personality</Label>
      {personality.state === 'loading' && <Loading colors={colors} what="personality" />}
      {personality.state === 'error' && <ErrorNote colors={colors} error={personality.error} onRetry={personality.reload} />}
      {personality.state === 'ready' && (personality.data.ledgers.length === 0 ? <Empty colors={colors}>No personality read yet.</Empty> : (
        <div className="grid grid-cols-3 gap-2">
          {personality.data.ledgers.map((l) => (
            <div key={l.who} className={cardClass(colors, 'px-2 text-center')}>
              <div className={cn('text-[10px] font-semibold uppercase tracking-wider', colors.textMuted)}>{whoName(l.who)}</div>
              <div className={cn('mt-1 text-lg font-bold', colors.textMain)}>{l.type || '–'}</div>
              <div className={cn('text-[10px]', colors.textMuted)}>{l.signals} signs</div>
            </div>
          ))}
        </div>
      ))}
      {personality.state === 'ready' && personality.data.words.length > 0 && tallies('Feeling words used most', personality.data.words)}
    </div>
  );
}
