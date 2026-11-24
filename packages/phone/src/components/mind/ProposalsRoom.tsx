import React, { useState } from 'react';
import { acceptSuggestionBody, brainPath, normProposals, shortDay, type ProposalRow } from '../../lib/mind-console';
import { cn } from '../../lib/utils';
import { ActionButton, ActionError, ActionRow, Notice, useBrainAction } from './actions';
import { BackTo, cardClass, Chip, Colors, Empty, ErrorNote, Label, Loading, RowCard, useBrain, useSelected } from './parts';

// Suggestions: links the brain thinks it found between two notes because
// they kept coming up together. Waiting for a yes or a no.
export function ProposalsRoom({ colors }: { colors: Colors }) {
  const proposals = useBrain(brainPath(['proposals'], { status: 'pending' }), normProposals);
  const [open, setOpen] = useSelected<ProposalRow>();
  const [notice, setNotice] = useState<string | null>(null);
  const changed = (said: string) => { setNotice(said); setOpen(null); proposals.reload(); };

  if (open) return (
    <div className="space-y-3">
      <BackTo colors={colors} onBack={() => setOpen(null)}>All suggestions</BackTo>
      <ProposalCard p={open} colors={colors}>
        <ProposalActions p={open} colors={colors} onChanged={changed} />
      </ProposalCard>
    </div>
  );
  if (proposals.state === 'loading') return <Loading colors={colors} what="suggestions" />;
  if (proposals.state === 'error') return <ErrorNote colors={colors} error={proposals.error} onRetry={proposals.reload} />;
  if (proposals.data.length === 0) return <div className="space-y-3"><Notice colors={colors} text={notice} onClose={() => setNotice(null)} /><Empty colors={colors}>No suggestions waiting.</Empty></div>;

  return (
    <div className="space-y-3">
      <Notice colors={colors} text={notice} onClose={() => setNotice(null)} />
      <Label colors={colors}>{proposals.data.length} waiting</Label>
      {proposals.data.map((p) => (
        <RowCard key={p.id} colors={colors} onClick={() => setOpen(p)} title={`${p.fromEntity} ↔ ${p.toEntity}`} marks={<Chip colors={colors}>{Math.round(p.confidence * 100)}% sure</Chip>} side={shortDay(p.at)} text={p.reason} />
      ))}
    </div>
  );
}

export function ProposalCard({ p, colors, children }: { p: ProposalRow; colors: Colors; children?: React.ReactNode }) {
  return (
    <div className={cardClass(colors, 'space-y-3')}>
      <div className={cn('break-words text-base font-semibold', colors.textMain)}>{p.fromEntity} ↔ {p.toEntity}</div>
      <div className="flex flex-wrap gap-1.5"><Chip colors={colors}>{Math.round(p.confidence * 100)}% sure</Chip><Chip colors={colors}>{p.reason.split(':')[0]}</Chip></div>
      <div>
        <Label colors={colors}>About {p.fromEntity}</Label>
        <p className={cn('mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed', colors.textMain)}>{p.fromContent}</p>
      </div>
      <div>
        <Label colors={colors}>About {p.toEntity}</Label>
        <p className={cn('mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed', colors.textMain)}>{p.toContent}</p>
      </div>
      {children}
    </div>
  );
}

function ProposalActions({ p, colors, onChanged }: { p: ProposalRow; colors: Colors; onChanged: (said: string) => void }) {
  const act = useBrainAction(onChanged);
  return (
    <>
      <ActionRow>
        <ActionButton colors={colors} busy={act.busy} onClick={() => act.run('POST', brainPath(['proposals', p.id, 'accept']), acceptSuggestionBody())}>Yes, link them</ActionButton>
        <ActionButton colors={colors} busy={act.busy} onClick={() => act.run('POST', brainPath(['proposals', p.id, 'reject']))}>No</ActionButton>
      </ActionRow>
      <ActionError error={act.error} />
    </>
  );
}
