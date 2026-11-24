// The vaults come in (slice 4): the community archive and the operator's Notion image
// prompts. Dry run first ("211 new, 4 duplicates, 3 couldn't parse"), then
// confirm. After import, the house rewrites named people into [Character N]
// in the background; the original words stay on every spell.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, FileUp, Loader2, RefreshCw } from 'lucide-react';
import { apiFetch } from '../../../bytelight';
import { cn } from '../../../lib/utils';
import type { ThemeColors } from '../../../lib/theme';
import { jsonOrError } from './shared';

interface Preview {
  token: string; vault: string; newCount: number; duplicates: number; unparsedCount: number;
  unparsed: Array<{ where: string; why: string }>;
  sample: Array<{ title: string; credit?: string; tags: string[]; excerpt: string }>;
  authors: number;
}
interface Neutralize { running: boolean; done: number; total: number; failed: number; finishedAt: string | null; error: string | null }
interface VaultState { notionStaged: { pulledAt: string | null; count: number } | null; archiveStaged: { savedAt: string } | null; notionLive: boolean; neutralize: Neutralize }

interface Props {
  colors: ThemeColors;
  accentStyle: React.CSSProperties;
  onBack: () => void;
  onImported: () => void;
  onNote: (n: string) => void;
}

export function SpellbookVaults({ colors, accentStyle, onBack, onImported, onNote }: Props) {
  const [state, setState] = useState<VaultState | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [showUnparsed, setShowUnparsed] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  // The dry run lands below both vault cards, off-screen on a phone: bring it into view.
  useEffect(() => { if (preview) previewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [preview]);

  const load = useCallback(async () => {
    try { setState(await jsonOrError(await apiFetch('/api/studio/spellbook/vaults'))); } catch { /* keep the last */ }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!state?.neutralize.running) return;
    const t = setInterval(() => { void load(); }, 4000);
    return () => clearInterval(t);
  }, [state?.neutralize.running, load]);

  const dryRun = async (body: FormData, label: string) => {
    setBusy(label); setError(''); setPreview(null);
    try {
      const p: Preview = await jsonOrError(await apiFetch('/api/studio/spellbook/vaults/preview', { method: 'POST', body }));
      setPreview(p);
      onNote(`Dry run · ${p.newCount} new`);
    }
    catch (e) { setError(e instanceof Error ? e.message : 'The dry run failed.'); }
    finally { setBusy(''); }
  };

  const fromSource = (source: string, label: string) => { const fd = new FormData(); fd.append('source', source); void dryRun(fd, label); };
  const fromFile = (f: File | undefined) => { if (!f) return; const fd = new FormData(); fd.append('file', f, f.name); void dryRun(fd, 'file'); };

  const commit = async () => {
    if (!preview || busy) return;
    setBusy('commit'); setError('');
    try {
      const d = await jsonOrError(await apiFetch('/api/studio/spellbook/vaults/commit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: preview.token }),
      }));
      onNote(`${d.added} spells on the wall`);
      setPreview(null);
      onImported();
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'The import failed.'); }
    finally { setBusy(''); }
  };

  const card = cn('mb-4 rounded-2xl border p-4 backdrop-blur-md', colors.panelBg, colors.panelBorder);
  const soft = cn('flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2.5 text-sm font-medium disabled:opacity-40', colors.panelBorder, colors.textMain);
  const n = state?.neutralize;

  return (
    <div className="bytelight-app-body min-h-0 flex-1 overflow-y-auto p-4 pb-10">
      <div className="mb-4 flex items-center gap-3">
        <button type="button" onClick={onBack} disabled={busy === 'commit'} aria-label="Back to the Spellbook" className={cn('rounded-xl border p-2 disabled:opacity-40', colors.panelBorder, colors.textMain)}><ArrowLeft className="h-4 w-4" /></button>
        <h3 className={cn('text-lg font-semibold', colors.textMain)}>The vaults</h3>
      </div>
      <p className={cn('mb-4 text-sm', colors.textMuted)}>Bring old prompts in as spells. Nothing lands until you've seen the dry run. Importing the same vault twice never doubles anything. The vault stays in the house.</p>

      <section className={card}>
        <h4 className={cn('mb-1 font-semibold', colors.textMain)}>Image prompts · Notion</h4>
        <p className={cn('mb-3 text-sm', colors.textMuted)}>
          {state?.notionStaged
            ? `${state.notionStaged.count} pages pulled${state.notionStaged.pulledAt ? ` ${new Date(state.notionStaged.pulledAt).toLocaleDateString()}` : ''}. These land as yours, with their tags.`
            : 'Not pulled into the house yet.'}
        </p>
        <div className="grid gap-2">
          {state?.notionStaged && (
            <button type="button" onClick={() => fromSource('notion-staged', 'notion')} disabled={!!busy} className={soft}>
              {busy === 'notion' ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Dry run
            </button>
          )}
          {state?.notionLive && (
            <button type="button" onClick={() => fromSource('notion-live', 'notion-live')} disabled={!!busy} className={soft}>
              {busy === 'notion-live' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Pull fresh from Notion
            </button>
          )}
        </div>
      </section>

      <section className={card}>
        <h4 className={cn('mb-1 font-semibold', colors.textMain)}>community archive</h4>
        <p className={cn('mb-3 text-sm', colors.textMuted)}>
          {state?.archiveStaged ? 'The archive is already in the house. ' : 'Drop the archive\'s markdown file. '}
          Each prompt comes in as a community spell credited to its author.
        </p>
        <div className="grid gap-2">
          {state?.archiveStaged && (
            <button type="button" onClick={() => fromSource('archive-staged', 'archive')} disabled={!!busy} className={soft}>
              {busy === 'archive' ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Dry run
            </button>
          )}
          <button type="button" onClick={() => file.current?.click()} disabled={!!busy} className={soft}>
            {busy === 'file' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />} {state?.archiveStaged ? 'Use a newer file' : 'Choose the file'}
          </button>
        </div>
        <input ref={file} type="file" accept=".md,.markdown,.txt,.json,text/markdown,text/plain,application/json" className="hidden"
          onChange={(e) => { fromFile(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }} />
      </section>

      {error && <p role="alert" className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</p>}

      {preview && (
        <section ref={previewRef} className={card}>
          <h4 className={cn('mb-2 font-semibold', colors.textMain)}>Dry run</h4>
          <p className={cn('mb-3 text-base', colors.textMain)}>
            <b>{preview.newCount}</b> new · {preview.duplicates} duplicate{preview.duplicates === 1 ? '' : 's'} · {preview.unparsedCount} couldn't parse
            {preview.authors > 0 && <span className={colors.textMuted}> · {preview.authors} authors</span>}
          </p>
          {preview.sample.length > 0 && (
            <div className="mb-3 grid gap-2">
              {preview.sample.map((s, i) => (
                <div key={i} className={cn('rounded-xl border p-3 text-sm', colors.panelBorder)}>
                  <div className={cn('font-medium', colors.textMain)}>{s.title}{s.credit && <span className={cn('ml-2 text-xs', colors.textMuted)}>{s.credit}</span>}</div>
                  <div className={cn('line-clamp-2', colors.textMuted)}>{s.excerpt}</div>
                </div>
              ))}
            </div>
          )}
          {preview.unparsedCount > 0 && (
            <>
              <button type="button" onClick={() => setShowUnparsed((v) => !v)} className={cn('mb-2 text-sm', colors.textMuted)}>{showUnparsed ? '▾' : '▸'} What couldn't be read</button>
              {showUnparsed && (
                <ul className={cn('mb-3 list-disc pl-5 text-xs', colors.textMuted)}>
                  {preview.unparsed.map((u, i) => <li key={i}>{u.where}: {u.why}</li>)}
                </ul>
              )}
            </>
          )}
          <button type="button" onClick={commit} disabled={!preview.newCount || !!busy}
            className="flex w-full items-center justify-center gap-2 rounded-2xl py-3.5 text-base font-semibold disabled:opacity-40" style={accentStyle}>
            {busy === 'commit' && <Loader2 className="h-5 w-5 animate-spin" />}
            {preview.newCount ? `Bring in ${preview.newCount} spells` : 'Nothing new to bring in'}
          </button>
        </section>
      )}

      {n && (n.running || n.total > 0) && (
        <section className={card}>
          <h4 className={cn('mb-1 font-semibold', colors.textMain)}>Taking the names out</h4>
          <p className={cn('text-sm', colors.textMuted)}>
            {n.running
              ? `Rewriting people as [Character 1], [Character 2]… ${n.done} of ${n.total}.`
              : n.total ? `${n.total} still waiting to be rewritten.` : ''}
            {n.failed > 0 && ` ${n.failed} kept their original words.`}
          </p>
          {!n.running && n.total > 0 && (
            <button type="button" onClick={async () => { await apiFetch('/api/studio/spellbook/vaults/neutralize', { method: 'POST' }); void load(); }} className={cn(soft, 'mt-3 w-full')}>Start it</button>
          )}
        </section>
      )}
    </div>
  );
}
