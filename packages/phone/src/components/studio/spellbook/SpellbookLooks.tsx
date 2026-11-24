// Looks: style boards (slice 3). Name a look, drop up to six pictures, let
// Codex read the board into a recipe, edit it, make it the default, star it as
// a favorite. The pictures write the recipe and also ride every render as
// style references (the house labels them apart from the cast's likeness).
// Looks are the one home for styles: Studio Create picks from this list too.

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, ImagePlus, Loader2, Plus, Star, Trash2, Wand2, X } from 'lucide-react';
import { apiFetch } from '../../../bytelight';
import { cn } from '../../../lib/utils';
import type { ThemeColors } from '../../../lib/theme';
import { jsonOrError, type Look } from './shared';

const MAX_IMAGES = 6;

interface Props {
  colors: ThemeColors;
  accentStyle: React.CSSProperties;
  looks: Look[];
  onBack: () => void;
  onChanged: (looks: Look[]) => void;
  onNote: (n: string) => void;
  /** Open straight into the editor for this look id, or 'new'. */
  startWith?: string | null;
}

export function SpellbookLooks({ colors, accentStyle, looks, onBack, onChanged, onNote, startWith }: Props) {
  const [editing, setEditing] = useState<Look | 'new' | null>(() => (startWith === 'new' ? 'new' : looks.find((l) => l.id === startWith) ?? null));

  const reload = async () => {
    const d = await jsonOrError(await apiFetch('/api/studio/spellbook/looks'));
    onChanged(d.looks ?? []);
  };

  const card = cn('rounded-2xl border p-4 backdrop-blur-md', colors.panelBg, colors.panelBorder);
  const [starring, setStarring] = useState('');

  const toggleFavorite = async (l: Look) => {
    if (starring) return;
    setStarring(l.id);
    try {
      await jsonOrError(await apiFetch(`/api/studio/spellbook/looks/${encodeURIComponent(l.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ favorite: !l.favorite }),
      }));
      await reload();
    } catch (e) { onNote(e instanceof Error ? e.message : 'Could not star it.'); }
    finally { setStarring(''); }
  };

  if (editing) {
    return (
      <LookEditor colors={colors} accentStyle={accentStyle} look={editing === 'new' ? null : editing}
        onBack={() => setEditing(null)} onNote={onNote}
        onSaved={async () => { await reload(); setEditing(null); }} />
    );
  }

  return (
    <div className="bytelight-app-body min-h-0 flex-1 overflow-y-auto p-4 pb-10">
      <div className="mb-4 flex items-center gap-3">
        <button type="button" onClick={onBack} aria-label="Back to the Spellbook" className={cn('rounded-xl border p-2', colors.panelBorder, colors.textMain)}><ArrowLeft className="h-4 w-4" /></button>
        <h3 className={cn('flex-1 text-lg font-semibold', colors.textMain)}>Looks</h3>
        <button type="button" onClick={() => setEditing('new')} className="flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-semibold" style={accentStyle}><Plus className="h-4 w-4" /> New look</button>
      </div>
      <p className={cn('mb-4 text-sm', colors.textMuted)}>A look is a recipe laid over any spell — grain, color, light, lens. Grungy film is one look, not a life sentence.</p>
      <div className="grid gap-3">
        {looks.map((l) => (
          <div key={l.id} className="relative">
          <button type="button" onClick={() => setEditing(l)} className={cn(card, 'w-full pr-12 text-left')}>
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className={cn('flex-1 font-semibold', colors.textMain)}>{l.name}</span>
              {l.starter && <span className={cn('rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide', colors.panelBorder, colors.textMuted)}>starter</span>}
              {l.isDefault && <span className="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold" style={accentStyle}><Check className="h-3 w-3" /> Default</span>}
            </div>
            {l.imageUrls.length > 0 && (
              <div className="mb-2 flex gap-1.5">
                {l.imageUrls.slice(0, 6).map((u) => <img key={u} src={u} alt="" className="h-12 w-12 rounded-lg object-cover" />)}
              </div>
            )}
            <p className={cn('line-clamp-2 text-sm', colors.textMuted)}>
              {l.keepPicture ? 'Uses the dropped picture\'s own style.' : (l.recipe || 'No recipe yet — tap to write one.')}
            </p>
          </button>
          <button type="button" onClick={() => toggleFavorite(l)} disabled={!!starring}
            aria-label={l.favorite ? `Unstar ${l.name}` : `Star ${l.name} as a favorite`} aria-pressed={l.favorite}
            className={cn('absolute right-2 top-2 rounded-full p-2 disabled:opacity-60', l.favorite ? '' : colors.textMuted)}
            style={l.favorite ? { color: colors.accent } : undefined}>
            {starring === l.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Star className="h-4 w-4" fill={l.favorite ? 'currentColor' : 'none'} />}
          </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function LookEditor({ colors, accentStyle, look, onBack, onSaved, onNote }: {
  colors: ThemeColors; accentStyle: React.CSSProperties; look: Look | null;
  onBack: () => void; onSaved: () => Promise<void>; onNote: (n: string) => void;
}) {
  const [name, setName] = useState(look?.name ?? '');
  const [recipe, setRecipe] = useState(look?.recipe ?? '');
  const [kept, setKept] = useState<string[]>(look?.images ?? []);
  const [added, setAdded] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [makeDefault, setMakeDefault] = useState(look?.isDefault ?? false);
  const [busy, setBusy] = useState<'' | 'reading' | 'saving' | 'deleting'>('');
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const urls = added.map((f) => URL.createObjectURL(f));
    setPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [added]);

  const total = kept.length + added.length;
  const keptUrl = (f: string) => `/api/studio/spellbook/look-images/${encodeURIComponent(f)}`;

  const form = () => {
    const fd = new FormData();
    fd.append('keep', JSON.stringify(kept));
    for (const f of added) fd.append('images', f, f.name);
    return fd;
  };

  const readBoard = async () => {
    if (!total || busy) return;
    setBusy('reading'); setError('');
    try {
      const fd = form();
      if (look) fd.append('lookId', look.id);
      const d = await jsonOrError(await apiFetch('/api/studio/spellbook/looks/read-board', { method: 'POST', body: fd }));
      setRecipe(d.recipe);
      if (!name.trim()) setName(d.name);
    } catch (e) { setError(e instanceof Error ? e.message : 'The board reader failed.'); }
    finally { setBusy(''); }
  };

  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy('saving'); setError('');
    try {
      const fd = form();
      fd.append('name', name.trim());
      fd.append('recipe', recipe);
      if (makeDefault) fd.append('makeDefault', 'true');
      await jsonOrError(await apiFetch(look ? `/api/studio/spellbook/looks/${encodeURIComponent(look.id)}` : '/api/studio/spellbook/looks', { method: look ? 'PUT' : 'POST', body: fd }));
      if (look && makeDefault && !look.isDefault) await apiFetch(`/api/studio/spellbook/looks/${encodeURIComponent(look.id)}/default`, { method: 'POST' });
      onNote('Look saved');
      await onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save the look.'); setBusy(''); }
  };

  const remove = async () => {
    if (!look || look.builtin || busy) return;
    if (!window.confirm(`Delete the look "${look.name}"?`)) return;
    setBusy('deleting');
    try { await jsonOrError(await apiFetch(`/api/studio/spellbook/looks/${encodeURIComponent(look.id)}`, { method: 'DELETE' })); onNote('Look deleted'); await onSaved(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not delete it.'); setBusy(''); }
  };

  const field = cn('w-full rounded-xl border bg-transparent px-3 py-2 text-sm outline-none', colors.panelBorder, colors.textMain);
  const label = cn('mb-2 block text-[11px] font-semibold uppercase tracking-[0.14em]', colors.textMuted);

  return (
    <div className="bytelight-app-body min-h-0 flex-1 overflow-y-auto p-4 pb-10">
      <div className="mb-4 flex items-center gap-3">
        <button type="button" onClick={onBack} disabled={!!busy} aria-label="Back to looks" className={cn('rounded-xl border p-2 disabled:opacity-40', colors.panelBorder, colors.textMain)}><ArrowLeft className="h-4 w-4" /></button>
        <h3 className={cn('flex-1 text-lg font-semibold', colors.textMain)}>{look ? 'Edit look' : 'New look'}</h3>
        {look && !look.builtin && <button type="button" onClick={remove} disabled={!!busy} aria-label="Delete look" className={cn('rounded-xl border p-2 text-red-400 disabled:opacity-40', colors.panelBorder)}><Trash2 className="h-4 w-4" /></button>}
      </div>

      <section className={cn('mb-4 rounded-2xl border p-4', colors.panelBg, colors.panelBorder)}>
        <span className={label}>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Midnight flash, Sunday film…" className={cn(field, 'mb-4')} />

        {look?.keepPicture ? (
          <p className={cn('text-sm', colors.textMuted)}>This look keeps whatever style the dropped picture already has, so there is no recipe to write.</p>
        ) : (
          <>
            <span className={label}>The board · up to {MAX_IMAGES}</span>
            <div className="mb-3 grid grid-cols-3 gap-2">
              {kept.map((f) => (
                <div key={f} className="relative aspect-square">
                  <img src={keptUrl(f)} alt="" className="h-full w-full rounded-xl object-cover" />
                  <button type="button" onClick={() => setKept((k) => k.filter((x) => x !== f))} aria-label="Take off the board" className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white"><X className="h-3 w-3" /></button>
                </div>
              ))}
              {previews.map((u, i) => (
                <div key={u} className="relative aspect-square">
                  <img src={u} alt="" className="h-full w-full rounded-xl object-cover" />
                  <button type="button" onClick={() => setAdded((a) => a.filter((_, j) => j !== i))} aria-label="Take off the board" className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white"><X className="h-3 w-3" /></button>
                </div>
              ))}
              {total < MAX_IMAGES && (
                <button type="button" onClick={() => input.current?.click()} className={cn('flex aspect-square flex-col items-center justify-center gap-1 rounded-xl border border-dashed text-xs', colors.panelBorder, colors.textMuted)}>
                  <ImagePlus className="h-5 w-5" /> Add
                </button>
              )}
            </div>
            <input ref={input} type="file" accept="image/*" multiple className="hidden"
              onChange={(e) => { const fs = Array.from(e.currentTarget.files ?? []); setAdded((a) => [...a, ...fs].slice(0, MAX_IMAGES - kept.length)); e.currentTarget.value = ''; }} />
            <button type="button" onClick={readBoard} disabled={!total || !!busy}
              className={cn('mb-4 flex w-full items-center justify-center gap-2 rounded-xl border py-2.5 text-sm font-semibold disabled:opacity-40', colors.panelBorder, colors.textMain)}>
              {busy === 'reading' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
              {busy === 'reading' ? 'Reading the board…' : 'Read my board'}
            </button>
            <span className={label}>Recipe</span>
            <textarea value={recipe} onChange={(e) => setRecipe(e.target.value)} rows={6} maxLength={1200}
              placeholder="Grain, color, light, lens… or tap Read my board."
              className={cn(field, 'mb-1 resize-y leading-relaxed')} />
            <p className={cn('mb-4 text-xs', colors.textMuted)}>The pictures ride along with every render as style references (how it's drawn, never who is in it), on top of the recipe.</p>
          </>
        )}

        <label className={cn('flex items-center gap-2 text-sm', colors.textMain)}>
          <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} disabled={look?.isDefault} />
          {look?.isDefault ? 'This is your default look' : 'Make this my default'}
        </label>
      </section>

      {error && <p role="alert" className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</p>}

      <button type="button" onClick={save} disabled={!name.trim() || !!busy}
        className="flex w-full items-center justify-center gap-2 rounded-2xl py-3.5 text-base font-semibold disabled:opacity-40" style={accentStyle}>
        {busy === 'saving' && <Loader2 className="h-5 w-5 animate-spin" />} Save look
      </button>
    </div>
  );
}
