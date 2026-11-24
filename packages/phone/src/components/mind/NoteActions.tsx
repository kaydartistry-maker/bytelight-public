import React, { useState } from 'react';
import { brainPath, editNoteBody, settleNoteBody, type ObservationRow } from '../../lib/mind-console';
import { ActionButton, ActionError, ActionRow, EditBox, useBrainAction } from './actions';
import { Colors } from './parts';
import { ShareToChatButton } from './SendToHouse';

// The buttons under one note: change its words, or mark it settled. Edit
// needs the note's weight and feeling word in hand, because the brain
// overwrites both on every edit; without them only Settle is offered.
//
// (The brain's "sit with it" and delete doors for notes both write to a
// table its database doesn't have yet, so they're left off until it does.)
export function NoteActions({ note, colors, onChanged, canEdit = true, about }: {
  note: Pick<ObservationRow, 'id' | 'content' | 'weight' | 'emotion' | 'charge'> & { at?: string };
  colors: Colors;
  onChanged: (said: string) => void;
  canEdit?: boolean;
  /** Who the note is about, for its card if it's shared to the chat. */
  about?: string;
}) {
  const [mode, setMode] = useState<'none' | 'edit' | 'settle'>('none');
  const act = useBrainAction((said) => { setMode('none'); onChanged(said); });
  const settled = note.charge === 'metabolized';

  if (mode === 'edit') return (
    <div className="pt-2">
      <EditBox colors={colors} label="The note's words" initial={note.content} busy={act.busy}
        onSave={(t) => t.trim() && act.run('PUT', brainPath(['observations', note.id]), editNoteBody(note, t))}
        onCancel={() => { setMode('none'); act.clearError(); }} />
      <ActionError error={act.error} />
    </div>
  );
  if (mode === 'settle') return (
    <div className="pt-2">
      <EditBox colors={colors} label="How it settled (optional)" initial="" rows={3} saveLabel="Settle it" busy={act.busy}
        onSave={(t) => act.run('POST', brainPath(['observations', note.id, 'resolve']), settleNoteBody(t))}
        onCancel={() => { setMode('none'); act.clearError(); }} />
      <ActionError error={act.error} />
    </div>
  );
  return (
    <ActionRow>
      {canEdit && <ActionButton colors={colors} onClick={() => setMode('edit')}>Edit</ActionButton>}
      {!settled && <ActionButton colors={colors} onClick={() => setMode('settle')}>Settle</ActionButton>}
      {about !== undefined && <ShareToChatButton kind="note" colors={colors} item={{ id: note.id, content: note.content, emotion: note.emotion, about, day: note.at }} />}
    </ActionRow>
  );
}
