import React, { useState } from 'react';
import { brainPath, normTensions, settleTensionBody, shortDay, type TensionRow } from '../../lib/mind-console';
import { cn } from '../../lib/utils';
import { ActionButton, ActionError, ActionRow, EditBox, Notice, useBrainAction } from './actions';
import { BackTo, cardClass, Chip, Colors, Empty, ErrorNote, Label, Loading, useBrain, useSelected } from './parts';

// Tensions: two things pulling at once, held open until they settle.
export function TensionsRoom({ colors }: { colors: Colors }) {
  const tensions = useBrain(brainPath(['tensions']), normTensions);
  const [open, setOpen] = useSelected<TensionRow>();
  const [notice, setNotice] = useState<string | null>(null);
  const changed = (said: string) => { setNotice(said); setOpen(null); tensions.reload(); };

  if (open) return (
    <div className="space-y-3">
      <BackTo colors={colors} onBack={() => setOpen(null)}>All tensions</BackTo>
      <TensionCard t={open} colors={colors} full>
        <TensionActions t={open} colors={colors} onChanged={changed} />
      </TensionCard>
    </div>
  );
  if (tensions.state === 'loading') return <Loading colors={colors} what="tensions" />;
  if (tensions.state === 'error') return <ErrorNote colors={colors} error={tensions.error} onRetry={tensions.reload} />;
  const { open: live, resolved } = tensions.data;

  return (
    <div className="space-y-3">
      <Notice colors={colors} text={notice} onClose={() => setNotice(null)} />
      <Label colors={colors}>Open</Label>
      {live.length === 0 ? <Empty colors={colors}>No open tensions.</Empty> : live.map((t) => (
        <button key={t.id} onClick={() => setOpen(t)} className="block w-full text-left"><TensionCard t={t} colors={colors} /></button>
      ))}
      <Label colors={colors}>Settled lately</Label>
      {resolved.length === 0 ? <Empty colors={colors}>None settled yet.</Empty> : resolved.map((t) => (
        <button key={t.id} onClick={() => setOpen(t)} className="block w-full text-left"><TensionCard t={t} colors={colors} /></button>
      ))}
    </div>
  );
}

export function TensionCard({ t, colors, full, children }: { t: TensionRow; colors: Colors; full?: boolean; children?: React.ReactNode }) {
  const clamp = full ? undefined : { display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' as const, overflow: 'hidden' };
  return (
    <div className={cardClass(colors, 'space-y-2')}>
      <div className="flex items-center gap-1.5">
        <Chip colors={colors}>{t.visits === 1 ? 'visited once' : `visited ${t.visits} times`}</Chip>
        <span className={cn('ml-auto text-[10px]', colors.textMuted)}>{shortDay(t.at)}</span>
      </div>
      <p className={cn('whitespace-pre-wrap break-words text-sm leading-relaxed', colors.textMain)} style={clamp}>{t.a}</p>
      <div className={cn('text-center text-[10px] font-bold uppercase tracking-widest', colors.textMuted)}>and also</div>
      <p className={cn('whitespace-pre-wrap break-words text-sm leading-relaxed', colors.textMain)} style={clamp}>{t.b}</p>
      {full && t.context && <p className={cn('whitespace-pre-wrap break-words text-xs', colors.textMuted)}>{t.context}</p>}
      {full && t.resolution && <p className={cn('whitespace-pre-wrap break-words text-xs italic', colors.textMuted)}>How it settled: {t.resolution}</p>}
      {children}
    </div>
  );
}

function TensionActions({ t, colors, onChanged }: { t: TensionRow; colors: Colors; onChanged: (said: string) => void }) {
  const [settling, setSettling] = useState(false);
  const act = useBrainAction(onChanged);
  const isOpen = !t.resolved;
  if (settling) return (
    <>
      <EditBox colors={colors} label="How did it settle? (optional)" initial="" rows={3} saveLabel="Settle it" busy={act.busy}
        onSave={(text) => act.run('POST', brainPath(['tensions', t.id, 'resolve']), settleTensionBody(text))}
        onCancel={() => { setSettling(false); act.clearError(); }} />
      <ActionError error={act.error} />
    </>
  );
  return (
    <>
      <ActionRow>
        {isOpen && <ActionButton colors={colors} busy={act.busy} onClick={() => act.run('POST', brainPath(['tensions', t.id, 'visit']))}>I sat with it</ActionButton>}
        {isOpen && <ActionButton colors={colors} onClick={() => setSettling(true)}>Settle</ActionButton>}
        <ActionButton colors={colors} danger busy={act.busy} onClick={() => act.run('DELETE', brainPath(['tensions', t.id]), undefined, {
          confirm: 'Delete this tension from the brain? It can\'t be undone.',
        })}>Delete</ActionButton>
      </ActionRow>
      <ActionError error={act.error} />
    </>
  );
}
