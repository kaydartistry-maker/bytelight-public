import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, ImagePlus, Loader2, Pencil, Plus, Star, Trash2, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { ThemeColors } from '../../lib/theme';
import { Button } from '../../ui';
import { studioRequest, type SavedStyle, type StyleLibrary, type StyleReference } from './my-styles';

type DraftRef = StyleReference & { file?: File; preview?: string };
type Draft = Omit<SavedStyle, 'references'> & { references: DraftRef[] };
export function MyStylesPanel({ colors, library, reload }: { colors: ThemeColors; library: StyleLibrary; reload: () => Promise<void> }) {
  const [draft, setDraft] = useState<Draft | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null), urls = useRef<string[]>([]);
  useEffect(() => () => urls.current.forEach(URL.revokeObjectURL), []);
  const panel = cn('rounded-2xl border p-4 space-y-3 backdrop-blur-md', colors.panelBg, colors.panelBorder);
  const field = cn('w-full rounded-xl border p-3 text-sm outline-none focus:ring-2 focus:ring-[var(--bytelight-accent)]', colors.panelBg, colors.panelBorder, colors.textMain);
  const act = async (fn: () => Promise<unknown>) => { if (busy) return; setBusy(true); setError(''); try { await fn(); } catch (e) { setError((e as Error).message); } finally { try { await reload(); } catch (e) { setError((e as Error).message); } setBusy(false); } };
  const close = () => { urls.current.forEach(URL.revokeObjectURL); urls.current = []; setDraft(null); setError(''); };
  const move = (index: number, delta: number) => setDraft(current => {
    if (!current) return current;
    const refs = [...current.references]; [refs[index], refs[index + delta]] = [refs[index + delta], refs[index]];
    return { ...current, references: refs };
  });
  const save = () => act(async () => {
    if (!draft) return;
    let saved = draft.id ? (await studioRequest<StyleLibrary>('styles')).styles.find(s => s.id === draft.id)! : (await studioRequest<{ style: SavedStyle }>('styles', 'POST', { title: draft.title, prompt: draft.prompt })).style;
    if (!saved || (draft.id && saved.revision !== draft.revision)) throw new Error('This style changed elsewhere. Close the editor and reload it before saving.');
    const ordered = [...draft.references];
    setDraft({ ...draft, id: saved.id, revision: saved.revision });
    for (let i = 0; i < ordered.length; i++) {
      const ref = ordered[i]; if (!ref.file) continue;
      const data = new FormData(); data.set('file', ref.file); data.set('revision', String(saved.revision));
      const before = new Set(saved.references.map(r => r.id));
      saved = (await studioRequest<{ style: SavedStyle }>(`styles/${saved.id}/references`, 'POST', data)).style;
      ordered[i] = saved.references.find(r => !before.has(r.id))!;
      setDraft({ ...draft, id: saved.id, revision: saved.revision, references: [...ordered] });
    }
    await studioRequest(`styles/${saved.id}`, 'PATCH', { title: draft.title, prompt: draft.prompt, referenceIds: ordered.map(r => r.id), revision: saved.revision });
    close();
  });
  return <div className="space-y-4">
    <div className={panel}>
      <div className="flex items-center justify-between gap-3"><h2 className="text-base font-semibold">My Styles</h2><Button colors={colors} variant="primary" onClick={() => { close(); setDraft({ id: '', title: '', prompt: '', references: [], revision: 0 }); }}><Plus className="inline h-4 w-4 mr-1" />Add style</Button></div>
      <p className={cn('text-xs leading-relaxed', colors.textMuted)}>Your exact written prompts and ordered style references. Star one to use it for future pictures generated in chat. Studio’s selection stays independent.</p>
      {!library.defaultChatStyleId && <p className={cn('text-xs', colors.textMuted)}>Chat default: no saved style.</p>}
    </div>
    {error && <p role="alert" className={cn(panel, 'text-sm')}>{error}</p>}
    {library.styles.length === 0 && !draft && <div className={panel}><p className="text-sm">Your style library is ready. Add a title, your written style, and its reference artworks.</p></div>}
    {library.styles.map(style => <div key={style.id} className={panel}>
      <div className="flex items-start gap-2"><div className="min-w-0 flex-1"><h3 className="font-semibold break-words">{style.title}</h3>{library.defaultChatStyleId === style.id && <p className={cn('text-xs mt-1', colors.textMuted)}>Default for chat images</p>}</div>
        <button disabled={busy} aria-label={library.defaultChatStyleId === style.id ? `Clear ${style.title} as chat default` : `Use ${style.title} as chat default`} aria-pressed={library.defaultChatStyleId === style.id} onClick={() => act(() => studioRequest('styles/default-chat', 'PUT', { styleId: library.defaultChatStyleId === style.id ? null : style.id }))} className="p-2 rounded-xl" style={{ color: library.defaultChatStyleId === style.id ? colors.accent : undefined }}><Star className={cn('h-5 w-5', library.defaultChatStyleId === style.id && 'fill-current')} /></button>
      </div>
      <p className={cn('text-xs whitespace-pre-wrap line-clamp-3', colors.textMuted)}>{style.prompt || 'Reference-only style'}</p>
      {style.references.length > 0 && <div className="flex gap-2 overflow-x-auto">{style.references.map((r, i) => <img key={r.id} src={r.url} alt={`${style.title}, reference ${i + 1}`} className="h-16 w-16 shrink-0 rounded-xl object-cover" />)}</div>}
      <div className="flex flex-wrap gap-2"><Button colors={colors} disabled={busy} onClick={() => { close(); setDraft(structuredClone(style)); }}><Pencil className="inline h-3.5 w-3.5 mr-1" />Edit</Button><Button colors={colors} disabled={busy} onClick={() => act(() => studioRequest(`styles/${style.id}/duplicate`, 'POST'))}><Copy className="inline h-3.5 w-3.5 mr-1" />Duplicate</Button><Button colors={colors} disabled={busy} onClick={() => { if (window.confirm(`Delete “${style.title}”? Existing artwork is kept. Its chat default will be cleared.`)) void act(() => studioRequest(`styles/${style.id}`, 'DELETE')); }}><Trash2 className="inline h-3.5 w-3.5 mr-1" />Delete</Button></div>
    </div>)}
    {draft && <div className="fixed inset-0 z-50 flex flex-col bg-black/60 p-3 pt-[calc(var(--sat)+0.75rem)] pb-[calc(var(--sab)+0.75rem)]" role="dialog" aria-modal="true" aria-label="Edit saved style"><div className={cn(panel, 'mx-auto w-full max-w-2xl flex min-h-0 flex-1 flex-col overflow-y-auto', colors.textMain)}>
      <div className="flex items-center justify-between"><h2 className="font-semibold">{draft.id ? 'Edit style' : 'New style'}</h2><button aria-label="Close style editor" disabled={busy} onClick={close} className="p-2"><X className="h-5 w-5" /></button></div>
      <label className="text-xs font-medium">Style title<input autoFocus className={cn(field, 'mt-1')} maxLength={100} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} placeholder="e.g. Example Style" disabled={busy} /></label>
      <label className="text-xs font-medium">Your written style<textarea className={cn(field, 'mt-1 min-h-40')} maxLength={12000} value={draft.prompt} onChange={e => setDraft({ ...draft, prompt: e.target.value })} placeholder="Paste the exact style prompt you use. No MJ flags." disabled={busy} /></label>
      <p className={cn('text-xs', colors.textMuted)}>Style references · {draft.references.length}/8. Their order is preserved. These define how to render; subject references stay separate.</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{draft.references.map((r, i) => <div key={r.id} className={cn('rounded-xl border p-2', colors.panelBorder)}><img src={r.preview || r.url} alt={`Reference ${i + 1}: ${r.name}`} className="aspect-square w-full rounded-lg object-cover" /><p className="truncate text-xs mt-1">{i + 1}. {r.name}</p><div className="flex justify-between mt-1"><button disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label={`Move reference ${i + 1} earlier`} className="p-2 disabled:opacity-30"><ArrowUp className="h-4 w-4" /></button><button disabled={busy || i === draft.references.length - 1} onClick={() => move(i, 1)} aria-label={`Move reference ${i + 1} later`} className="p-2 disabled:opacity-30"><ArrowDown className="h-4 w-4" /></button><button disabled={busy} onClick={() => setDraft({ ...draft, references: draft.references.filter(x => x.id !== r.id) })} aria-label={`Remove reference ${i + 1}`} className="p-2"><Trash2 className="h-4 w-4" /></button></div></div>)}</div>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={e => { const files = [...(e.target.files ?? [])]; if (files.length + draft.references.length > 8) { setError('A style can hold up to eight references.'); e.target.value = ''; return; } setDraft({ ...draft, references: [...draft.references, ...files.map(file => { const preview = URL.createObjectURL(file); urls.current.push(preview); return { id: crypto.randomUUID(), filename: '', name: file.name, url: '', file, preview }; })] }); e.target.value = ''; }} />
      <Button colors={colors} disabled={busy || draft.references.length >= 8} onClick={() => input.current?.click()}><ImagePlus className="inline h-4 w-4 mr-1" />Add reference images</Button>
      {error && <p role="alert" className="text-sm">{error}</p>}
      <div className="flex gap-2 pt-2"><Button colors={colors} variant="primary" disabled={busy || !draft.title.trim()} onClick={save}>{busy && <Loader2 className="inline h-4 w-4 animate-spin mr-1" />}Save style</Button><Button colors={colors} disabled={busy} onClick={close}>Cancel</Button></div>
    </div></div>}
  </div>;
}
