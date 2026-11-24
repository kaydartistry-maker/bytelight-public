import React, { useState } from 'react';
import { brainPath, healthText, normArchive, normDormant, normHealthScores, normIsolated, normStats, shortDay } from '../../lib/mind-console';
import { cn } from '../../lib/utils';
import { ActionButton, ActionError, ActionRow, Notice, useBrainAction } from './actions';
import { cardClass, Chip, Colors, Empty, ErrorNote, Folded, Label, Loading, Pills, useBrain } from './parts';

type Tab = 'overview' | 'quiet' | 'alone' | 'archive';
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'quiet', label: 'Gone quiet' },
  { id: 'alone', label: 'Standing alone' },
  { id: 'archive', label: 'Archived' },
];

// Health: how the brain is doing, plus its back rooms: notes that have gone
// quiet, people and things connected to nothing, and what was archived.
export function HealthRoom({ colors }: { colors: Colors }) {
  const [tab, setTab] = useState<Tab>('overview');
  return (
    <div className="space-y-3">
      <Pills<Tab> colors={colors} value={tab} options={TABS} onChange={setTab} />
      {tab === 'overview' && <Overview colors={colors} />}
      {tab === 'quiet' && <Dormant colors={colors} />}
      {tab === 'alone' && <Isolated colors={colors} />}
      {tab === 'archive' && <Archive colors={colors} />}
    </div>
  );
}

function Overview({ colors }: { colors: Colors }) {
  const stats = useBrain(brainPath(['stats']), normStats);
  const scores = useBrain(brainPath(['health-scores']), normHealthScores);
  const report = useBrain(brainPath(['health']), healthText);

  return (
    <div className="space-y-3">
      {scores.state === 'loading' && <Loading colors={colors} what="the scores" />}
      {scores.state === 'error' && <ErrorNote colors={colors} error={scores.error} onRetry={scores.reload} />}
      {scores.state === 'ready' && scores.data && (
        <div className={cardClass(colors)}>
          <div className="flex items-baseline justify-between">
            <Label colors={colors}>Overall</Label>
            <span className={cn('text-2xl font-bold', colors.textMain)}>{scores.data.overall}%</span>
          </div>
          <div className="mt-3 space-y-2">
            {scores.data.parts.map((p) => (
              <div key={p.label}>
                <div className={cn('flex justify-between text-[11px]', colors.textMuted)}><span>{p.label}</span><span>{p.score}%</span></div>
                <div className={cn('mt-1 h-1.5 overflow-hidden rounded-full', colors.textMuted)} style={{ background: 'color-mix(in srgb, currentColor 14%, transparent)' }}>
                  <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, p.score))}%`, background: colors.accent }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {stats.state === 'ready' && stats.data.counts.length > 0 && (
        <div className={cardClass(colors)}>
          <Label colors={colors}>What it holds{stats.data.version ? ` · version ${stats.data.version}` : ''}</Label>
          <div className="mt-2 space-y-1">
            {stats.data.counts.map((c) => (
              <div key={c.label} className={cn('flex justify-between text-sm', colors.textMain)}><span>{c.label}</span><span className={colors.textMuted}>{c.count}</span></div>
            ))}
          </div>
        </div>
      )}

      <div className={cardClass(colors)}>
        <Label colors={colors}>The brain's own report</Label>
        {report.state === 'loading' && <Loading colors={colors} what="the report" />}
        {report.state === 'error' && <ErrorNote colors={colors} error={report.error} onRetry={report.reload} />}
        {report.state === 'ready' && (report.data
          ? <pre className={cn('mt-2 max-h-[28rem] overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed', colors.textMain)}>{report.data}</pre>
          : <Empty colors={colors}>No report came back.</Empty>)}
      </div>
    </div>
  );
}

function Dormant({ colors }: { colors: Colors }) {
  const rows = useBrain(brainPath(['dormant']), normDormant);
  const [notice, setNotice] = useState<string | null>(null);
  const changed = (said: string) => { setNotice(said); rows.reload(); };
  if (rows.state === 'loading') return <Loading colors={colors} what="quiet notes" />;
  if (rows.state === 'error') return <ErrorNote colors={colors} error={rows.error} onRetry={rows.reload} />;
  return (
    <div className="space-y-3">
      <Notice colors={colors} text={notice} onClose={() => setNotice(null)} />
      {rows.data.length === 0 ? <Empty colors={colors}>No notes have gone quiet.</Empty> : (
        <p className={cn('text-xs leading-relaxed', colors.textMuted)}>Notes that haven't come up in a long time. Bring one back, or archive it.</p>
      )}
      {rows.data.map((d) => (
        <div key={d.observationId} className={cardClass(colors)}>
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            {d.entity && <span className={cn('text-xs font-semibold', colors.textMain)}>{d.entity}</span>}
            {d.weight && <Chip colors={colors}>{d.weight}</Chip>}
            <span className={cn('ml-auto text-[10px]', colors.textMuted)}>{d.days} days old</span>
          </div>
          <Folded text={d.content} colors={colors} />
          <RowButtons colors={colors} onChanged={changed} buttons={[
            { label: 'Bring it back', method: 'POST', path: brainPath(['dormant', d.observationId, 'surface']) },
            { label: 'Archive', method: 'POST', path: brainPath(['dormant', d.observationId, 'archive']) },
          ]} />
        </div>
      ))}
    </div>
  );
}

/** A row of buttons that each send one write and share one answer line. */
function RowButtons({ colors, onChanged, buttons }: {
  colors: Colors; onChanged: (said: string) => void;
  buttons: { label: string; method: 'POST' | 'DELETE'; path: string }[];
}) {
  const act = useBrainAction(onChanged);
  return (
    <>
      <ActionRow>
        {buttons.map((b) => <ActionButton key={b.label} colors={colors} busy={act.busy} onClick={() => act.run(b.method, b.path)}>{b.label}</ActionButton>)}
      </ActionRow>
      <ActionError error={act.error} />
    </>
  );
}

function Isolated({ colors }: { colors: Colors }) {
  const rows = useBrain(brainPath(['isolated']), normIsolated);
  const [notice, setNotice] = useState<string | null>(null);
  const changed = (said: string) => { setNotice(said); rows.reload(); };
  if (rows.state === 'loading') return <Loading colors={colors} />;
  if (rows.state === 'error') return <ErrorNote colors={colors} error={rows.error} onRetry={rows.reload} />;
  if (rows.data.length === 0) return <Empty colors={colors}>Everyone and everything is connected to something.</Empty>;
  return (
    <div className="space-y-2">
      <Notice colors={colors} text={notice} onClose={() => setNotice(null)} />
      <p className={cn('text-xs leading-relaxed', colors.textMuted)}>People and things the brain hasn't linked to anything else.</p>
      {rows.data.map((e) => <IsolatedRow key={e.id} name={e.name} count={e.count} colors={colors} onChanged={changed} />)}
    </div>
  );
}

/** One thing standing alone: link it to a name, or tell the brain it's alone on purpose. */
function IsolatedRow({ name, count, colors, onChanged }: { name: string; count: number; colors: Colors; onChanged: (said: string) => void }) {
  const [linking, setLinking] = useState(false);
  const [to, setTo] = useState('');
  const act = useBrainAction(onChanged);
  const field = cn('w-full rounded-xl border bg-transparent px-3 py-2.5 text-sm outline-none', colors.panelBorder, colors.textMain);
  return (
    <div className={cardClass(colors, 'space-y-1')}>
      <div className="flex items-center justify-between gap-2">
        <span className={cn('break-words text-sm font-semibold', colors.textMain)}>{name}</span>
        <span className={cn('shrink-0 text-[11px]', colors.textMuted)}>{count === 1 ? '1 note' : `${count} notes`}</span>
      </div>
      {linking && (
        <label className="block space-y-1"><span className={cn('text-[11px] font-semibold', colors.textMuted)}>Link it to (a name the brain knows)</span>
          <input value={to} onChange={(ev) => setTo(ev.target.value)} className={field} /></label>
      )}
      <ActionRow>
        {linking ? (
          <>
            <ActionButton colors={colors} busy={act.busy} disabled={!to.trim()} onClick={() => act.run('POST', brainPath(['isolated', 'connect']), { entity: name, to_entity: to.trim() })}>Link them</ActionButton>
            <ActionButton colors={colors} onClick={() => { setLinking(false); setTo(''); act.clearError(); }}>Cancel</ActionButton>
          </>
        ) : (
          <>
            <ActionButton colors={colors} onClick={() => setLinking(true)}>Connect…</ActionButton>
            <ActionButton colors={colors} busy={act.busy} onClick={() => act.run('POST', brainPath(['isolated', 'ignore']), { entity: name })}>Alone on purpose</ActionButton>
          </>
        )}
      </ActionRow>
      <ActionError error={act.error} />
    </div>
  );
}

function Archive({ colors }: { colors: Colors }) {
  const rows = useBrain(brainPath(['archive'], { limit: 50 }), normArchive);
  const [notice, setNotice] = useState<string | null>(null);
  const changed = (said: string) => { setNotice(said); rows.reload(); };
  if (rows.state === 'loading') return <Loading colors={colors} what="the archive" />;
  if (rows.state === 'error') return <ErrorNote colors={colors} error={rows.error} onRetry={rows.reload} />;
  return (
    <div className="space-y-3">
      <Notice colors={colors} text={notice} onClose={() => setNotice(null)} />
      {rows.data.items.length === 0 ? <Empty colors={colors}>Nothing has been archived.</Empty> : (
        <p className={cn('text-xs leading-relaxed', colors.textMuted)}>
          {rows.data.total > rows.data.items.length ? `The newest ${rows.data.items.length} of ${rows.data.total} archived notes.` : `${rows.data.total} archived notes.`}
        </p>
      )}
      {rows.data.items.map((o) => (
        <div key={o.id} className={cardClass(colors)}>
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            {o.entity && <span className={cn('text-xs font-semibold', colors.textMain)}>{o.entity}</span>}
            <span className={cn('ml-auto text-[10px]', colors.textMuted)}>{shortDay(o.at)}</span>
          </div>
          <Folded text={o.content} colors={colors} />
          <RowButtons colors={colors} onChanged={changed} buttons={[
            { label: 'Bring it back', method: 'POST', path: brainPath(['archive', o.id, 'rescue']) },
          ]} />
        </div>
      ))}
    </div>
  );
}
