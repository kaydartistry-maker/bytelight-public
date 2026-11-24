// Earlier versions of a memory block, and blocks that were deleted.
//
// The backend keeps the text a block held before every write that would have
// lost some of it (services/memory-blocks.ts, migrations/052). This is the
// window onto that: read any earlier version, and put the block back the way
// it was. A restore is itself kept, so it can be undone the same way.
import React, { useCallback, useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { cn } from '../lib/utils';
import { apiFetch } from '../bytelight';

export interface BlockVersionSummary {
  id: number;
  scope: string;
  label: string;
  description: string | null;
  op: 'set' | 'rethink' | 'replace' | 'insert' | 'delete' | 'restore';
  actor: string;
  created_at: string;
  chars: number;
  preview: string;
}

interface ThemeColors {
  accent: string;
  panelBg: string;
  panelBorder: string;
  textMuted: string;
}

/** What was about to happen to the block when this version was kept. */
export function versionReason(op: BlockVersionSummary['op']): string {
  switch (op) {
    case 'set': return 'before it was overwritten';
    case 'rethink': return 'before it was rewritten';
    case 'replace': return 'before a line was changed';
    case 'insert': return 'before a line was put in';
    case 'delete': return 'before it was deleted';
    case 'restore': return 'before an earlier version was put back';
    default: return 'before a change';
  }
}

/** Who made the change, in plain words. */
export function versionActor(actor: string): string {
  if (actor === 'api') return 'you, on this screen';
  if (actor === 'house') return 'the house';
  if (actor === 'extraction') return 'the Archivist';
  if (actor === 'diet-loop') return 'the memory diet';
  return actor;
}

async function restoreVersion(id: number): Promise<string | null> {
  const res = await apiFetch(`/api/memory/history/${id}/restore`, { method: 'POST' });
  if (res.ok) return null;
  const data = await res.json().catch(() => ({}));
  return data.error || 'Could not restore';
}

function VersionRow({
  version, colors, onRestored, restoreLabel,
}: {
  version: BlockVersionSummary;
  colors: ThemeColors;
  onRestored: () => void;
  restoreLabel: string;
}) {
  const [text, setText] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || text !== null) return;
    try {
      const res = await apiFetch(`/api/memory/history/${version.id}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.version) setText(String(data.version.content ?? ''));
      else setError(data.error || 'Could not open this version');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const restore = async () => {
    if (!confirm(`${restoreLabel}? What the block holds now is kept, so you can undo this.`)) return;
    setBusy(true);
    setError(null);
    try {
      const failed = await restoreVersion(version.id);
      if (failed) setError(failed);
      else onRestored();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn('rounded-lg border p-2.5', colors.panelBorder)}>
      <button onClick={toggle} className="w-full text-left">
        <div className="text-xs font-medium">
          {new Date(version.created_at).toLocaleString()}
        </div>
        <div className={cn('text-[10px]', colors.textMuted)}>
          {versionReason(version.op)} · by {versionActor(version.actor)} · {version.chars} chars
        </div>
        {!open && <div className="text-xs opacity-60 mt-1 line-clamp-2">{version.preview || '(empty)'}</div>}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <pre className="text-xs whitespace-pre-wrap font-mono opacity-90 max-h-72 overflow-y-auto">
            {text === null ? 'Opening…' : text || '(empty)'}
          </pre>
          <button
            onClick={restore}
            disabled={busy}
            className="px-3 py-1.5 rounded text-xs font-medium bytelight-on-accent disabled:opacity-50 flex items-center gap-1"
            style={{ background: colors.accent }}
          >
            <RotateCcw size={12} /> {busy ? 'Restoring…' : restoreLabel}
          </button>
        </div>
      )}
      {error && <div className="text-xs mt-1" style={{ color: colors.accent }}>{error}</div>}
    </div>
  );
}

/** Earlier versions of one block, under its detail view. */
export function MemoryBlockHistory({
  scope, label, refreshKey, colors, onRestored,
}: {
  scope: string;
  label: string;
  /** Changes whenever the block does, so the list is read again. */
  refreshKey: string;
  colors: ThemeColors;
  onRestored: () => void;
}) {
  const [versions, setVersions] = useState<BlockVersionSummary[] | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(
        `/api/memory/blocks/${encodeURIComponent(scope)}/${encodeURIComponent(label)}/history`,
      );
      const data = await res.json().catch(() => ({}));
      setVersions(res.ok && Array.isArray(data.versions) ? data.versions : []);
    } catch {
      setVersions([]);
    }
  }, [scope, label]);

  useEffect(() => { load(); }, [load, refreshKey]);

  return (
    <div className="mt-3 pt-3 border-t border-white/10 space-y-2">
      <div className="text-xs font-medium">Earlier versions</div>
      <p className={cn('text-[10px]', colors.textMuted)}>
        Kept every time this block was rewritten, changed or deleted. Lines that were only added to the end are not listed; nothing was lost by them.
      </p>
      {versions === null ? (
        <div className="text-xs opacity-50">Loading…</div>
      ) : versions.length === 0 ? (
        <div className="text-xs opacity-50">No earlier versions yet. The next change to this block will be kept here.</div>
      ) : (
        versions.map((v) => (
          <VersionRow
            key={v.id}
            version={v}
            colors={colors}
            restoreLabel="Put this version back"
            onRestored={() => { load(); onRestored(); }}
          />
        ))
      )}
    </div>
  );
}

/** Blocks that were deleted and not made again, under the block list. */
export function DeletedMemoryBlocks({
  refreshKey, colors, onRestored,
}: {
  refreshKey: string;
  colors: ThemeColors;
  onRestored: () => void;
}) {
  const [versions, setVersions] = useState<BlockVersionSummary[]>([]);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/memory/history/deleted');
      const data = await res.json().catch(() => ({}));
      setVersions(res.ok && Array.isArray(data.versions) ? data.versions : []);
    } catch {
      setVersions([]);
    }
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  if (versions.length === 0) return null;

  return (
    <div className={cn('rounded-lg border p-3 space-y-2', colors.panelBorder, colors.panelBg)}>
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center justify-between text-xs">
        <span className="font-medium">Deleted blocks ({versions.length})</span>
        <span className="opacity-60">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && versions.map((v) => (
        <div key={v.id} className="space-y-1">
          <div className="text-xs">
            <span className="font-medium">{v.label}</span>{' '}
            <span className="text-[10px] uppercase tracking-wide opacity-70">{v.scope}</span>
          </div>
          <VersionRow
            version={v}
            colors={colors}
            restoreLabel="Bring this block back"
            onRestored={() => { load(); onRestored(); }}
          />
        </div>
      ))}
    </div>
  );
}
