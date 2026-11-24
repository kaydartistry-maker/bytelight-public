import React, { useState } from 'react';
import { brainPath, resultText } from '../../lib/mind-console';
import { cn } from '../../lib/utils';
import { AskBox, cardClass, Colors, Empty, ErrorNote, Loading, Pills, useBrain } from './parts';

type Tab = 'thoughts' | 'conversations' | 'stats';
const TABS: { id: Tab; label: string }[] = [
  { id: 'thoughts', label: 'Thoughts' },
  { id: 'conversations', label: 'Conversations' },
  { id: 'stats', label: 'Totals' },
];

// Cortex: the brain's working notes (thoughts) and its saved conversations.
// The brain answers here in written pages, so they're shown as written.
export function CortexRoom({ colors }: { colors: Colors }) {
  const [tab, setTab] = useState<Tab>('thoughts');
  const [q, setQ] = useState('');

  const path = tab === 'stats'
    ? brainPath(['cortex', 'stats'])
    : tab === 'conversations'
      ? brainPath(['cortex', 'conversations'], { query: q || undefined, limit: 20 })
      : q ? brainPath(['cortex', 'thoughts'], { query: q, limit: 15 }) : null;
  const page = useBrain(path, resultText);

  return (
    <div className="space-y-3">
      <Pills<Tab> colors={colors} value={tab} options={TABS} onChange={setTab} />
      {tab !== 'stats' && (
        <AskBox key={tab} colors={colors} placeholder={tab === 'thoughts' ? 'Recall thoughts about…' : 'Find a conversation about…'} initial={q} onAsk={setQ} />
      )}
      {path === null ? <Empty colors={colors}>Type something to recall the thoughts about it.</Empty>
        : page.state === 'loading' ? <Loading colors={colors} />
        : page.state === 'error' ? <ErrorNote colors={colors} error={page.error} onRetry={page.reload} />
        : page.data.trim() ? (
          <div className={cardClass(colors)}>
            <pre className={cn('whitespace-pre-wrap break-words font-sans text-sm leading-relaxed', colors.textMain)}>{page.data}</pre>
          </div>
        ) : <Empty colors={colors}>Nothing here yet.</Empty>}
    </div>
  );
}
