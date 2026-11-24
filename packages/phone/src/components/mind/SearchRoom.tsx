import React, { useState } from 'react';
import { brainPath, normSearch, shortDay, type SearchHit } from '../../lib/mind-console';
import { AskBox, BackTo, Chip, Colors, Detail, Empty, ErrorNote, Loading, RowCard, useBrain, useSelected } from './parts';

// Search: look for anything the brain keeps, by meaning rather than exact
// words. Nothing loads until something is asked.
export function SearchRoom({ colors }: { colors: Colors }) {
  const [q, setQ] = useState('');
  const hits = useBrain(q ? brainPath(['search'], { q }) : null, normSearch);
  const [open, setOpen] = useSelected<SearchHit>();

  if (open) return (
    <div className="space-y-3">
      <BackTo colors={colors} onBack={() => setOpen(null)}>Results</BackTo>
      <Detail colors={colors} title={open.kind} marks={<>{open.about && <Chip colors={colors}>{open.about}</Chip>}<Chip colors={colors}>{Math.round(open.score * 100)}% match</Chip></>} text={open.content || "The brain didn't keep a preview of this one."} />
    </div>
  );

  return (
    <div className="space-y-3">
      <AskBox colors={colors} placeholder="What are you looking for?" initial={q} onAsk={setQ} />
      {!q && <Empty colors={colors}>Ask about a person, a day, a feeling, anything.</Empty>}
      {q && hits.state === 'loading' && <Loading colors={colors} what="the search" />}
      {q && hits.state === 'error' && <ErrorNote colors={colors} error={hits.error} onRetry={hits.reload} />}
      {q && hits.state === 'ready' && (hits.data.length === 0
        ? <Empty colors={colors}>Nothing came up for "{q}".</Empty>
        : hits.data.map((h) => (
          <RowCard key={h.id} colors={colors} onClick={() => setOpen(h)} title={h.kind} marks={h.about ? <Chip colors={colors}>{h.about}</Chip> : undefined} side={shortDay(h.at)} text={h.content || 'No preview'} />
        )))}
    </div>
  );
}
