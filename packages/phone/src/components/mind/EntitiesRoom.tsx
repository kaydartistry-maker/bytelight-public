import React, { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import {
  CONTEXTS, brainPath, editEntityBody, editRelationBody, normEntities, normEntityDetail, shortDay,
  type EntityDetail, type EntityRow, type RelationRow,
} from '../../lib/mind-console';
import { cn } from '../../lib/utils';
import { ActionButton, ActionError, ActionRow, EditBox, Notice, useBrainAction } from './actions';
import { NoteActions } from './NoteActions';
import { BackTo, cardClass, Chip, Colors, Empty, ErrorNote, Folded, Label, Loading, useBrain, useSelected } from './parts';

// People & things: everyone and everything the brain keeps notes on. The
// list loads when the room opens; one entity's notes load when it's tapped.
export function EntitiesRoom({ colors }: { colors: Colors }) {
  const [openId, setOpenId] = useSelected<number>();
  const [filter, setFilter] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const entities = useBrain(brainPath(['entities']), normEntities);

  if (openId !== null) return (
    <EntityDetailView
      id={openId}
      colors={colors}
      onBack={() => setOpenId(null)}
      onGone={(said) => { setNotice(said); setOpenId(null); entities.reload(); }}
    />
  );
  if (entities.state === 'loading') return <Loading colors={colors} what="people & things" />;
  if (entities.state === 'error') return <ErrorNote colors={colors} error={entities.error} onRetry={entities.reload} />;

  const shown = entities.data.filter((e) => !filter || e.name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="space-y-2">
      <Notice colors={colors} text={notice} onClose={() => setNotice(null)} />
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Find a name"
        className={cn('w-full rounded-xl border bg-transparent px-3 py-2.5 text-sm outline-none', colors.panelBorder, colors.textMain)}
      />
      {shown.length === 0 ? <Empty colors={colors}>{filter ? 'No one by that name.' : 'The brain has no people or things yet.'}</Empty> : shown.map((e: EntityRow) => (
        <button key={e.id} onClick={() => setOpenId(e.id)} className={cardClass(colors, 'flex w-full items-center justify-between gap-3 text-left')}>
          <div className="min-w-0">
            <div className={cn('truncate text-sm font-semibold', colors.textMain)}>{e.name}</div>
            <div className={cn('text-[11px]', colors.textMuted)}>
              {[e.type, e.count ? `${e.count} notes` : 'no notes'].filter(Boolean).join(' · ')}
            </div>
          </div>
          <ChevronRight size={16} className={colors.textMuted} />
        </button>
      ))}
    </div>
  );
}

function EntityDetailView({ id, colors, onBack, onGone }: { id: number; colors: Colors; onBack: () => void; onGone: (said: string) => void }) {
  const detail = useBrain(brainPath(['entities', id]), normEntityDetail);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const changed = (said: string) => { setNotice(said); setEditing(false); detail.reload(); };
  const del = useBrainAction(onGone);

  if (detail.state === 'loading') return <Loading colors={colors} />;
  if (detail.state === 'error') return <ErrorNote colors={colors} error={detail.error} onRetry={detail.reload} />;
  const d = detail.data;
  if (!d) return <Empty colors={colors}>That one isn't in the brain any more. <button className="underline" onClick={onBack}>Back to the list</button></Empty>;

  return (
    <div className="space-y-3">
      <BackTo colors={colors} onBack={onBack}>All people & things</BackTo>
      <Notice colors={colors} text={notice} onClose={() => setNotice(null)} />
      <div className={cardClass(colors, 'space-y-2')}>
        {editing ? <EntityEditor d={d} colors={colors} onSaved={changed} onCancel={() => setEditing(false)} /> : (
          <>
            <div className={cn('break-words text-lg font-semibold', colors.textMain)}>{d.name}</div>
            <div className={cn('text-[11px]', colors.textMuted)}>{[d.type, d.context, d.salience].filter(Boolean).join(' · ')}</div>
            <ActionRow>
              <ActionButton colors={colors} onClick={() => setEditing(true)}>Edit</ActionButton>
              <ActionButton colors={colors} danger busy={del.busy} onClick={() => del.run('DELETE', brainPath(['entities', d.id]), undefined, {
                confirm: `Delete ${d.name} from the brain? This also deletes all ${d.observations.length} notes about them and every connection. It can't be undone.`,
              })}>Delete</ActionButton>
            </ActionRow>
            <ActionError error={del.error} />
          </>
        )}
      </div>

      <Label colors={colors}>Connections</Label>
      {d.relations.length === 0 ? <Empty colors={colors}>Not connected to anyone or anything yet.</Empty> : (
        <div className="space-y-2">
          {d.relations.map((r) => <RelationCard key={r.id} r={r} colors={colors} onChanged={changed} />)}
        </div>
      )}

      <Label colors={colors}>Notes</Label>
      {d.observations.length === 0 ? <Empty colors={colors}>No notes about {d.name} yet.</Empty> : d.observations.map((o) => (
        <div key={o.id} className={cardClass(colors)}>
          <div className="flex flex-wrap items-center gap-2">
            {o.emotion && <Chip colors={colors}>{o.emotion}</Chip>}
            {o.weight && <Chip colors={colors}>{o.weight}</Chip>}
            {o.charge === 'metabolized' && <Chip colors={colors}>settled</Chip>}
            <span className={cn('ml-auto text-[10px]', colors.textMuted)}>{shortDay(o.at)}</span>
          </div>
          <Folded className="mt-2" text={o.content} colors={colors} />
          <NoteActions note={o} about={d.name} colors={colors} onChanged={changed} />
        </div>
      ))}
    </div>
  );
}

function EntityEditor({ d, colors, onSaved, onCancel }: { d: EntityDetail; colors: Colors; onSaved: (said: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(d.name);
  const [type, setType] = useState(d.type);
  const [context, setContext] = useState(d.context);
  const act = useBrainAction(onSaved);
  const body = editEntityBody(d, { name, type, context });
  const field = cn('w-full rounded-xl border bg-transparent px-3 py-2.5 text-sm outline-none', colors.panelBorder, colors.textMain);

  return (
    <div className="space-y-2">
      <label className="block space-y-1"><span className={cn('text-[11px] font-semibold', colors.textMuted)}>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} className={field} /></label>
      <label className="block space-y-1"><span className={cn('text-[11px] font-semibold', colors.textMuted)}>Kind (person, place, concept…)</span>
        <input value={type} onChange={(e) => setType(e.target.value)} className={field} /></label>
      <label className="block space-y-1"><span className={cn('text-[11px] font-semibold', colors.textMuted)}>Where it lives</span>
        <select value={context} onChange={(e) => setContext(e.target.value)} className={cn(field, colors.panelBg)}>
          {!(CONTEXTS as readonly string[]).includes(d.context) && <option value={d.context}>{d.context || 'not set'}</option>}
          {CONTEXTS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select></label>
      <ActionRow>
        <ActionButton colors={colors} busy={act.busy} disabled={Object.keys(body).length === 0}
          onClick={() => act.run('PUT', brainPath(['entities', d.id]), body)}>Save</ActionButton>
        <ActionButton colors={colors} onClick={onCancel}>Cancel</ActionButton>
      </ActionRow>
      <ActionError error={act.error} />
    </div>
  );
}

function RelationCard({ r, colors, onChanged }: { r: RelationRow; colors: Colors; onChanged: (said: string) => void }) {
  const [editing, setEditing] = useState(false);
  const act = useBrainAction((said) => { setEditing(false); onChanged(said); });
  return (
    <div className={cardClass(colors, 'space-y-1')}>
      <div className={cn('break-words text-xs', colors.textMain)}>
        {r.from} <span className={colors.textMuted}>· {r.type.replace(/_/g, ' ')} ·</span> {r.to}
      </div>
      {editing ? (
        <EditBox colors={colors} label="What kind of link is it?" initial={r.type.replace(/_/g, ' ')} rows={1} busy={act.busy}
          onSave={(t) => t.trim() && act.run('PUT', brainPath(['relations', r.id]), editRelationBody(t))}
          onCancel={() => { setEditing(false); act.clearError(); }} />
      ) : (
        <ActionRow>
          <ActionButton colors={colors} onClick={() => setEditing(true)}>Change</ActionButton>
          <ActionButton colors={colors} danger busy={act.busy} onClick={() => act.run('DELETE', brainPath(['relations', r.id]), undefined, {
            confirm: `Remove the link between ${r.from} and ${r.to}?`,
          })}>Remove</ActionButton>
        </ActionRow>
      )}
      <ActionError error={act.error} />
    </div>
  );
}
