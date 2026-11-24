import React, { useState } from 'react';
import { brainPath, normFeelings, normSurface, shortDay, whoName, type FeelingRow, type SurfaceItem } from '../../lib/mind-console';
import { ActionRow, Notice } from './actions';
import { ShareToChatButton } from './SendToHouse';
import { NoteActions } from './NoteActions';
import { BackTo, Chip, Colors, Detail, Empty, ErrorNote, Label, Loading, RowCard, useBrain, useSelected } from './parts';

// What's surfacing: the notes the brain is holding up right now, and the
// feelings most worth sitting with.
export function SurfacingRoom({ colors }: { colors: Colors }) {
  const surface = useBrain(brainPath(['surface'], { limit: 10 }), normSurface);
  const feelings = useBrain(brainPath(['feelings', 'surface'], { limit: 10 }), normFeelings);
  const [note, setNote] = useSelected<SurfaceItem>();
  const [feeling, setFeeling] = useSelected<FeelingRow>();
  const [notice, setNotice] = useState<string | null>(null);
  const changed = (said: string) => { setNotice(said); setNote(null); surface.reload(); };

  if (note) return (
    <div className="space-y-3">
      <BackTo colors={colors} onBack={() => setNote(null)}>What's surfacing</BackTo>
      <Detail colors={colors} title={note.entity || `Note #${note.id}`} marks={<>{note.entityType && <Chip colors={colors}>{note.entityType}</Chip>}{note.marks && <Chip colors={colors}>{note.marks}</Chip>}</>} text={note.content}>
        {/* Surfacing doesn't carry the note's weight and feeling word, so it can be settled here but edited only from its person's page. */}
        <NoteActions note={{ id: note.id, content: note.content, weight: '', emotion: '', charge: '' }} canEdit={false} colors={colors} onChanged={changed} />
        <ActionRow><ShareToChatButton kind="note" colors={colors} item={{ id: note.id, content: note.content, about: note.entity }} /></ActionRow>
      </Detail>
    </div>
  );
  if (feeling) return (
    <div className="space-y-3">
      <BackTo colors={colors} onBack={() => setFeeling(null)}>What's surfacing</BackTo>
      <Detail colors={colors} title={feeling.emotion || 'A feeling'} marks={<><Chip colors={colors}>{whoName(feeling.who)}</Chip>{feeling.intensity && <Chip colors={colors}>{feeling.intensity}</Chip>}{feeling.entity && <Chip colors={colors}>about {feeling.entity}</Chip>}</>} text={feeling.content}>
        <ActionRow>
          <ShareToChatButton kind="feeling" colors={colors} item={{ id: feeling.id, content: feeling.content, who: feeling.who, emotion: feeling.emotion, about: feeling.entity, day: feeling.at }} />
        </ActionRow>
      </Detail>
    </div>
  );

  return (
    <div className="space-y-3">
      <Notice colors={colors} text={notice} onClose={() => setNotice(null)} />
      <Label colors={colors}>Notes coming up{surface.state === 'ready' && surface.data.mood ? ` · mood: ${surface.data.mood}` : ''}</Label>
      {surface.state === 'loading' && <Loading colors={colors} what="what's surfacing" />}
      {surface.state === 'error' && <ErrorNote colors={colors} error={surface.error} onRetry={surface.reload} />}
      {surface.state === 'ready' && (surface.data.items.length === 0
        ? <Empty colors={colors}>Nothing is surfacing right now.</Empty>
        : surface.data.items.map((s) => (
          <RowCard key={s.id} colors={colors} onClick={() => setNote(s)} title={s.entity} marks={s.entityType ? <Chip colors={colors}>{s.entityType}</Chip> : undefined} text={s.content} />
        )))}

      <Label colors={colors}>Feelings worth sitting with</Label>
      {feelings.state === 'loading' && <Loading colors={colors} what="feelings" />}
      {feelings.state === 'error' && <ErrorNote colors={colors} error={feelings.error} onRetry={feelings.reload} />}
      {feelings.state === 'ready' && (feelings.data.length === 0
        ? <Empty colors={colors}>No feelings are asking for attention.</Empty>
        : feelings.data.map((f) => (
          <RowCard key={f.id} colors={colors} onClick={() => setFeeling(f)} title={f.emotion} marks={<Chip colors={colors}>{whoName(f.who)}</Chip>} side={shortDay(f.at)} text={f.content} />
        )))}
    </div>
  );
}
