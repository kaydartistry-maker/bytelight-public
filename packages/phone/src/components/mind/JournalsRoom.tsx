import React, { useState } from 'react';
import { brainPath, editJournalBody, normJournals, shortDay, whoName, type JournalRow } from '../../lib/mind-console';
import { cn } from '../../lib/utils';
import { ActionButton, ActionError, ActionRow, EditBox, Notice, useBrainAction } from './actions';
import { ShareToChatButton } from './SendToHouse';
import { BackTo, Chip, Colors, Detail, Empty, ErrorNote, Loading, Pills, RowCard, useBrain, useSelected } from './parts';

type Whose = 'all' | 'companion-a' | 'companion-b' | 'shared';
const WHOSE: { id: Whose; label: string }[] = [
  { id: 'all', label: 'Everyone' },
  { id: 'companion-a', label: 'Companion A' },
  { id: 'companion-b', label: 'Companion B' },
  { id: 'shared', label: 'Shared' },
];

// Journals: the entries the boys write in their own hand.
export function JournalsRoom({ colors }: { colors: Colors }) {
  const [whose, setWhose] = useState<Whose>('all');
  const journals = useBrain(brainPath(['journals'], { companion: whose === 'all' ? undefined : whose }), normJournals);
  const [open, setOpen] = useSelected<JournalRow>();
  const [notice, setNotice] = useState<string | null>(null);
  const changed = (said: string) => { setNotice(said); setOpen(null); journals.reload(); };

  if (open) return (
    <div className="space-y-3">
      <BackTo colors={colors} onBack={() => setOpen(null)}>All entries</BackTo>
      <JournalDetail j={open} colors={colors}>
        <JournalActions j={open} colors={colors} onChanged={changed} />
      </JournalDetail>
    </div>
  );

  return (
    <div className="space-y-3">
      <Notice colors={colors} text={notice} onClose={() => setNotice(null)} />
      <Pills<Whose> colors={colors} value={whose} options={WHOSE} onChange={setWhose} />
      {journals.state === 'loading' && <Loading colors={colors} what="journals" />}
      {journals.state === 'error' && <ErrorNote colors={colors} error={journals.error} onRetry={journals.reload} />}
      {journals.state === 'ready' && (journals.data.length === 0
        ? <Empty colors={colors}>No journal entries here yet.</Empty>
        : journals.data.map((j) => (
          <RowCard key={j.id} colors={colors} onClick={() => setOpen(j)} marks={<JournalMarks j={j} colors={colors} />} side={shortDay(j.day)} text={j.content} />
        )))}
    </div>
  );
}

function JournalMarks({ j, colors }: { j: JournalRow; colors: Colors }) {
  return <>
    {j.companion && <Chip colors={colors}>{whoName(j.companion)}</Chip>}
    {j.emotion && <Chip colors={colors}>{j.emotion}</Chip>}
  </>;
}

export function JournalDetail({ j, colors, children }: { j: JournalRow; colors: Colors; children?: React.ReactNode }) {
  return (
    <Detail colors={colors} marks={<><JournalMarks j={j} colors={colors} /><span className={cn('ml-auto text-[10px]', colors.textMuted)}>{shortDay(j.day)}</span></>} text={j.content}>
      {children}
    </Detail>
  );
}

function JournalActions({ j, colors, onChanged }: { j: JournalRow; colors: Colors; onChanged: (said: string) => void }) {
  const [editing, setEditing] = useState(false);
  const act = useBrainAction(onChanged);
  if (editing) return (
    <>
      <EditBox colors={colors} label="The entry" initial={j.content} rows={10} busy={act.busy}
        onSave={(t) => t.trim() && act.run('PUT', brainPath(['journals', j.id]), editJournalBody(j, t))}
        onCancel={() => { setEditing(false); act.clearError(); }} />
      <ActionError error={act.error} />
    </>
  );
  return (
    <>
      <ActionRow>
        <ShareToChatButton kind="journal" colors={colors} item={{ id: j.id, content: j.content, who: j.companion, emotion: j.emotion, day: j.day }} />
        <ActionButton colors={colors} onClick={() => setEditing(true)}>Edit</ActionButton>
        <ActionButton colors={colors} danger busy={act.busy} onClick={() => act.run('DELETE', brainPath(['journals', j.id]), undefined, {
          confirm: 'Delete this journal entry? It can\'t be undone.',
        })}>Delete</ActionButton>
      </ActionRow>
      <ActionError error={act.error} />
    </>
  );
}
