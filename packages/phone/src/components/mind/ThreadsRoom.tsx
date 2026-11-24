import React, { useState } from 'react';
import { brainPath, normThreads, shortDay, type ThreadRow } from '../../lib/mind-console';
import { cn } from '../../lib/utils';
import { ActionRow } from './actions';
import { MakeTaskButton } from './SendToHouse';
import { BackTo, Chip, Colors, Detail, Empty, ErrorNote, Loading, Pills, RowCard, useBrain, useSelected } from './parts';

type Show = 'active' | 'resolved' | 'all';
const SHOW: { id: Show; label: string }[] = [
  { id: 'active', label: 'Open' },
  { id: 'resolved', label: 'Done' },
  { id: 'all', label: 'All' },
];

// Threads: the intentions the boys carry from one conversation to the next.
export function ThreadsRoom({ colors }: { colors: Colors }) {
  const [show, setShow] = useState<Show>('active');
  const threads = useBrain(brainPath(['threads'], { status: show === 'all' ? undefined : show }), normThreads);
  const [open, setOpen] = useSelected<ThreadRow>();

  if (open) return (
    <div className="space-y-3">
      <BackTo colors={colors} onBack={() => setOpen(null)}>All threads</BackTo>
      <ThreadDetail thread={open} colors={colors} />
    </div>
  );

  return (
    <div className="space-y-3">
      <Pills<Show> colors={colors} value={show} options={SHOW} onChange={setShow} />
      {threads.state === 'loading' && <Loading colors={colors} what="threads" />}
      {threads.state === 'error' && <ErrorNote colors={colors} error={threads.error} onRetry={threads.reload} />}
      {threads.state === 'ready' && (threads.data.length === 0
        ? <Empty colors={colors}>{show === 'active' ? 'No open threads.' : show === 'resolved' ? 'No finished threads yet.' : 'No threads yet.'}</Empty>
        : threads.data.map((t) => (
          <RowCard key={t.id} colors={colors} onClick={() => setOpen(t)} marks={<ThreadMarks t={t} colors={colors} />} side={shortDay(t.at)} text={t.content} />
        )))}
    </div>
  );
}

function ThreadMarks({ t, colors }: { t: ThreadRow; colors: Colors }) {
  return <>
    {t.status !== 'active' && <Chip colors={colors}>{t.status === 'resolved' ? 'done' : t.status}</Chip>}
    {t.priority && <Chip colors={colors}>{t.priority}</Chip>}
    {t.type && <Chip colors={colors}>{t.type}</Chip>}
  </>;
}

function ThreadDetail({ thread, colors }: { thread: ThreadRow; colors: Colors }) {
  return (
    <Detail colors={colors} marks={<><ThreadMarks t={thread} colors={colors} /><span className={cn('ml-auto text-[10px]', colors.textMuted)}>{shortDay(thread.at)}</span></>} text={thread.content}>
      {thread.context && <p className={cn('whitespace-pre-wrap break-words text-xs', colors.textMuted)}>{thread.context}</p>}
      {thread.resolution && <p className={cn('whitespace-pre-wrap break-words text-xs italic', colors.textMuted)}>How it ended: {thread.resolution}</p>}
      {/* The brain's thread doors expect number ids, but its threads have word ids, so marking done, editing and deleting can't reach them from here yet. */}
      <ActionRow><MakeTaskButton thread={thread} colors={colors} /></ActionRow>
      <p className={cn('text-[11px] leading-relaxed', colors.textMuted)}>Threads can't be changed from the console yet; the boys can still close or edit them.</p>
    </Detail>
  );
}
