import React, { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { brainPath, canEditSection, editIdentityBody, normIdentity, sectionName, type IdentitySection } from '../../lib/mind-console';
import { cn } from '../../lib/utils';
import { ActionButton, ActionError, ActionRow, EditBox, Notice, useBrainAction } from './actions';
import { BackTo, cardClass, Colors, Empty, ErrorNote, Label, Loading, useBrain, useSelected } from './parts';

// Identity: who the boys are, in the brain's own sections.
export function IdentityRoom({ colors }: { colors: Colors }) {
  const identity = useBrain(brainPath(['identity']), normIdentity);
  const [open, setOpen] = useSelected<string>();
  const [notice, setNotice] = useState<string | null>(null);
  const changed = (said: string) => { setNotice(said); identity.reload(); };

  if (identity.state === 'loading') return <Loading colors={colors} what="identity" />;
  if (identity.state === 'error') return <ErrorNote colors={colors} error={identity.error} onRetry={identity.reload} />;
  const section = open ? identity.data.find((s) => s.section === open) : null;
  if (section) return (
    <div className="space-y-3">
      <BackTo colors={colors} onBack={() => setOpen(null)}>All sections</BackTo>
      <Notice colors={colors} text={notice} onClose={() => setNotice(null)} />
      <SectionView section={section} colors={colors}>
        <SectionActions section={section} colors={colors} onChanged={changed} />
      </SectionView>
    </div>
  );
  if (identity.data.length === 0) return <Empty colors={colors}>The brain has no identity written yet.</Empty>;

  return (
    <div className="space-y-2">
      {identity.data.map((s) => (
        <button key={s.section} onClick={() => setOpen(s.section)} className={cardClass(colors, 'flex w-full items-center justify-between gap-3 text-left')}>
          <div className="min-w-0">
            <div className={cn('text-sm font-semibold', colors.textMain)}>{sectionName(s.section)}</div>
            <div className={cn('text-[11px]', colors.textMuted)}>{s.entries.length === 1 ? '1 entry' : `${s.entries.length} entries`}</div>
          </div>
          <ChevronRight size={16} className={colors.textMuted} />
        </button>
      ))}
    </div>
  );
}

export function SectionView({ section, colors, children }: { section: IdentitySection; colors: Colors; children?: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <Label colors={colors}>{sectionName(section.section)}</Label>
      {section.entries.map((e) => (
        <div key={e.id} className={cardClass(colors)}>
          <p className={cn('whitespace-pre-wrap break-words text-sm leading-relaxed', colors.textMain)}>{e.content}</p>
        </div>
      ))}
      {children}
    </div>
  );
}

// Identity can be edited from here but never deleted. The brain rewrites a
// whole section at once, so only a section holding one entry gets an Edit.
function SectionActions({ section, colors, onChanged }: { section: IdentitySection; colors: Colors; onChanged: (said: string) => void }) {
  const [editing, setEditing] = useState(false);
  const act = useBrainAction((said) => { setEditing(false); onChanged(said); });
  if (!canEditSection(section)) return (
    <p className={cn('text-[11px] leading-relaxed', colors.textMuted)}>
      This section holds {section.entries.length} entries, and the brain can only rewrite a section all at once, so editing is off here to keep them from being overwritten.
    </p>
  );
  const entry = section.entries[0];
  if (editing) return (
    <div className={cardClass(colors)}>
      <EditBox colors={colors} label={`${sectionName(section.section)}, in their words`} initial={entry.content} rows={8} busy={act.busy}
        onSave={(t) => t.trim() && act.run('PUT', brainPath(['identity', section.section]), editIdentityBody(entry, t))}
        onCancel={() => { setEditing(false); act.clearError(); }} />
      <ActionError error={act.error} />
    </div>
  );
  return <ActionRow><ActionButton colors={colors} onClick={() => setEditing(true)}>Edit</ActionButton></ActionRow>;
}
