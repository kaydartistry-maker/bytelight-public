import React, { useState } from 'react';
import { brainPath, editDreamBody, normDreams, shortDay, whoName, type DreamRow } from '../../lib/mind-console';
import { cn } from '../../lib/utils';
import { ActionButton, ActionError, ActionRow, EditBox, Notice, useBrainAction } from './actions';
import { BackTo, Chip, Colors, Detail, Empty, ErrorNote, Loading, RowCard, useBrain, useSelected } from './parts';

// Dreams: what the brain made overnight. Dreams fade unless they are
// recalled or anchored, so each one shows how vivid it is now.
export function DreamsRoom({ colors }: { colors: Colors }) {
  const dreams = useBrain(brainPath(['dreams']), normDreams);
  const [open, setOpen] = useSelected<DreamRow>();
  const [notice, setNotice] = useState<string | null>(null);
  const changed = (said: string) => { setNotice(said); setOpen(null); dreams.reload(); };

  if (open) return (
    <div className="space-y-3">
      <BackTo colors={colors} onBack={() => setOpen(null)}>All dreams</BackTo>
      <DreamDetail d={open} colors={colors}>
        <DreamActions d={open} colors={colors} onChanged={changed} />
      </DreamDetail>
    </div>
  );
  if (dreams.state === 'loading') return <Loading colors={colors} what="dreams" />;
  if (dreams.state === 'error') return <ErrorNote colors={colors} error={dreams.error} onRetry={dreams.reload} />;
  if (dreams.data.length === 0) return <Empty colors={colors}>No dreams yet.</Empty>;

  return (
    <div className="space-y-3">
      <Notice colors={colors} text={notice} onClose={() => setNotice(null)} />
      {dreams.data.map((d) => (
        <RowCard key={d.id} colors={colors} onClick={() => setOpen(d)} marks={<DreamMarks d={d} colors={colors} />} side={shortDay(d.day)} text={d.content} />
      ))}
    </div>
  );
}

export function vividLabel(d: DreamRow): string {
  if (d.anchored) return 'kept';
  if (d.vividness === null) return '';
  return `${d.vividness}% vivid`;
}

function DreamMarks({ d, colors }: { d: DreamRow; colors: Colors }) {
  return <>
    {vividLabel(d) && <Chip colors={colors}>{vividLabel(d)}</Chip>}
    {d.companion && <Chip colors={colors}>{whoName(d.companion)}</Chip>}
  </>;
}

export function DreamDetail({ d, colors, children }: { d: DreamRow; colors: Colors; children?: React.ReactNode }) {
  return (
    <Detail colors={colors} marks={<><DreamMarks d={d} colors={colors} /><span className={cn('ml-auto text-[10px]', colors.textMuted)}>{shortDay(d.day)}</span></>} text={d.content}>
      {d.question && <p className={cn('whitespace-pre-wrap break-words text-xs italic', colors.textMuted)}>The question it left: {d.question}</p>}
      {children}
    </Detail>
  );
}

function DreamActions({ d, colors, onChanged }: { d: DreamRow; colors: Colors; onChanged: (said: string) => void }) {
  const [editing, setEditing] = useState(false);
  const act = useBrainAction(onChanged);
  if (editing) return (
    <>
      <EditBox colors={colors} label="The dream's words" initial={d.content} busy={act.busy}
        onSave={(t) => t.trim() && act.run('PUT', brainPath(['dreams', d.id]), editDreamBody(t))}
        onCancel={() => { setEditing(false); act.clearError(); }} />
      <ActionError error={act.error} />
    </>
  );
  return (
    <>
      <ActionRow>
        {!d.anchored && <ActionButton colors={colors} busy={act.busy} onClick={() => act.run('POST', brainPath(['dreams', d.id, 'recall']))}>Recall</ActionButton>}
        {!d.anchored && <ActionButton colors={colors} busy={act.busy} onClick={() => act.run('POST', brainPath(['dreams', d.id, 'anchor']))}>Keep it</ActionButton>}
        <ActionButton colors={colors} onClick={() => setEditing(true)}>Edit</ActionButton>
        <ActionButton colors={colors} danger busy={act.busy} onClick={() => act.run('DELETE', brainPath(['dreams', d.id]), undefined, {
          confirm: 'Delete this dream? It can\'t be undone.',
        })}>Delete</ActionButton>
      </ActionRow>
      {!d.anchored && <p className={cn('text-[11px] leading-relaxed', colors.textMuted)}>Recall brings it back brighter; Keep it stops it fading for good.</p>}
      <ActionError error={act.error} />
    </>
  );
}
