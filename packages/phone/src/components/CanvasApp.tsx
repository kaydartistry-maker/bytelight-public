import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, RefreshCw, Loader2, Plus, Trash2, Eye, Pencil, MessageSquarePlus, Tag, X, Search, Link2, Check, ChevronDown } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { AppShell } from './AppShell';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import { apiFetch } from '../bytelight';
import { addCanvasRef } from '../lib/canvas-refs';
import { subscribeCanvasFrames } from '../bytelight/canvas-frames';
import {
  applyFrameToEditor,
  applyFrameToList,
  canAutoSave,
  editDraft,
  emptyEchoes,
  markContentSent,
  markTagsSent,
  markTitleSent,
  openEditor,
  pendingSaveFields,
  normalizeTag,
  takeIncoming,
  type CanvasDoc,
  type CanvasEchoes,
  type CanvasEditor,
} from '../lib/canvas-live';

interface CanvasAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  /** When set, jump straight into this canvas (a tapped message chip). */
  openId?: string | null;
  /** Send-to-chat: ref added, now take her back to the thread. */
  onSentToChat?: () => void;
}

type Canvas = CanvasDoc;

const TYPES: Canvas['content_type'][] = ['markdown', 'code', 'text', 'html'];

export function CanvasApp({ onClose, themeConfig, themeMode, openId, onSentToChat }: CanvasAppProps) {
  const colors = themeConfig[themeMode];
  const [list, setList] = useState<Canvas[]>([]);
  const [loading, setLoading] = useState(true);
  // The open canvas: server base + her draft (lib/canvas-live). The ref is the
  // copy socket frames and timers read, so they never act on a stale render.
  const [ed, setEd] = useState<CanvasEditor | null>(null);
  const edRef = useRef<CanvasEditor | null>(null);
  const echoesRef = useRef<CanvasEchoes>(emptyEchoes());
  const [saving, setSaving] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newType, setNewType] = useState<Canvas['content_type']>('markdown');
  const [newLanguage, setNewLanguage] = useState('');
  // Editor view — BL's Canvas flushes the save before switching to preview.
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  // Tags — chips + autocomplete over every tag in the house (BL behaviour).
  const [newTag, setNewTag] = useState('');
  const [allTags, setAllTags] = useState<string[]>([]);
  // List search + tag filter (BL's CanvasList: search covers title AND tags)
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [tagDropdownOpen, setTagDropdownOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // Leaving while a newer version is waiting would drop one side's words.
  const [confirmLeave, setConfirmLeave] = useState(false);
  // Delete asks first, from the editor and from a list row alike.
  const [confirmDelete, setConfirmDelete] = useState<Canvas | null>(null);
  // BL's debounced auto-save (Canvas.svelte handleContentInput, 500ms)
  const saveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const active = ed?.base ?? null;
  const draftTags = ed?.draftTags ?? [];

  function commit(next: CanvasEditor | null) {
    edRef.current = next;
    setEd(next);
  }

  function clearSaveTimer() {
    if (saveTimeout.current) clearTimeout(saveTimeout.current);
    saveTimeout.current = null;
  }

  const filteredList = useMemo(() => {
    let result = list;
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      result = result.filter((cv) =>
        cv.title.toLowerCase().includes(q) || cv.tags?.some((t) => t.toLowerCase().includes(q)),
      );
    }
    if (activeTag) result = result.filter((cv) => cv.tags?.includes(activeTag));
    return result;
  }, [list, searchQuery, activeTag]);
  const tagSuggestions = useMemo(() => {
    const q = newTag.trim().toLowerCase();
    if (!q) return [];
    return allTags.filter((t) => t.toLowerCase().includes(q) && !draftTags.includes(t)).slice(0, 6);
  }, [newTag, allTags, draftTags]);

  // Strip markdown syntax for a clean preview — BL CanvasList verbatim
  function contentPreview(content: string): string {
    return content
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*\*|__/g, '')
      .replace(/\*|_/g, '')
      .replace(/`{1,3}[^`]*`{1,3}/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\n+/g, ' ')
      .trim()
      .slice(0, 120);
  }

  // BL CanvasList formatTime verbatim
  function formatTime(iso: string): string {
    const d = new Date(iso);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  async function patch(id: string, body: Record<string, unknown>) {
    try {
      await apiFetch(`/api/canvases/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch { /* quiet */ }
  }

  // Body saves go out on their own: the server's tag frame carries the body as
  // it stood before the request, so a combined body+tags save would echo back
  // an old body.
  function sendContent(content: string): Promise<void> {
    const cur = edRef.current;
    if (!cur) return Promise.resolve();
    const r = markContentSent(cur, echoesRef.current, content);
    echoesRef.current = r.echoes;
    commit(r.editor);
    return patch(cur.base.id, { content });
  }

  // Debounced content auto-save — BL's 500ms; flushOnClose mirrors handleClose
  function handleContentInput(next: string) {
    const cur = edRef.current;
    if (!cur) return;
    commit(editDraft(cur, next));
    clearSaveTimer();
    saveTimeout.current = setTimeout(flushSave, 500);
  }

  // Never fires while a newer version is waiting on her choice.
  function flushSave() {
    clearSaveTimer();
    const cur = edRef.current;
    if (cur && canAutoSave(cur)) void sendContent(cur.draft);
  }

  function keepMine() {
    clearSaveTimer();
    const cur = edRef.current;
    if (cur) void sendContent(cur.draft);
  }

  function takeLatest() {
    clearSaveTimer();
    const cur = edRef.current;
    if (cur) commit(takeIncoming(cur));
  }

  function setDraftTitle(title: string) {
    const cur = edRef.current;
    if (cur) commit({ ...cur, draftTitle: title });
  }

  // Title saves on blur (BL handleTitleBlur)
  function handleTitleBlur() {
    const cur = edRef.current;
    if (cur && cur.draftTitle !== cur.base.title) {
      commit(markTitleSent(cur, cur.draftTitle));
      void patch(cur.base.id, { title: cur.draftTitle });
    }
  }

  // Tags apply immediately (BL sendCanvasUpdateTags on add/remove)
  function applyTags(updated: string[]) {
    const cur = edRef.current;
    if (!cur) return;
    const r = markTagsSent(cur, echoesRef.current, updated);
    echoesRef.current = r.echoes;
    commit(r.editor);
    void patch(cur.base.id, { tags: updated }).then(loadTags);
  }

  // BL addTag: cleaned (lowercase, letters/digits/dashes) so "Ideas" and
  // "ideas" are one tag; empty or already-present tags are dropped.
  function addTag(raw: string) {
    const tag = normalizeTag(raw);
    setNewTag('');
    if (!tag || draftTags.includes(tag)) return;
    applyTags([...draftTags, tag]);
  }

  // BL copyReference: the <<canvas:id:title>> ref onto the clipboard
  function copyReference() {
    if (!active) return;
    void navigator.clipboard?.writeText(`<<canvas:${active.id}:${active.title}>>`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function loadTags() {
    try {
      const res = await apiFetch('/api/canvases/tags');
      if (res.ok) setAllTags((await res.json()).tags || []);
    } catch { /* empty */ }
  }

  function sendToChat(c: Canvas) {
    addCanvasRef(c.id, c.title);
    onSentToChat?.();
  }

  async function loadList() {
    setLoading(true);
    try {
      const res = await apiFetch('/api/canvases');
      if (res.ok) setList((await res.json()).canvases || []);
    } catch {
      /* empty */
    }
    setLoading(false);
  }

  useEffect(() => {
    loadList();
    loadTags();
  }, []);

  // Live canvas frames — classic applies these to its store and its editor
  // follows (protocol.ts canvas_*; Canvas.svelte sync-when-not-dirty).
  useEffect(() => subscribeCanvasFrames((frame) => {
    setList((l) => applyFrameToList(l, frame));
    const cur = edRef.current;
    if (cur) {
      const r = applyFrameToEditor(cur, echoesRef.current, frame);
      echoesRef.current = r.echoes;
      if (r.editor !== cur) {
        if (!r.editor) clearSaveTimer();
        commit(r.editor);
      }
    }
    if (frame.type !== 'canvas_updated' || frame.tags !== undefined) void loadTags();
  }), []);

  useEffect(() => clearSaveTimer, []);

  // A tapped chip in the thread lands here already pointed at its canvas.
  useEffect(() => {
    if (openId) void open(openId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId]);

  function showCanvas(canvas: Canvas) {
    clearSaveTimer();
    echoesRef.current = emptyEchoes();
    commit(openEditor(canvas));
    setNewTag('');
    setView('edit');
  }

  async function open(id: string) {
    try {
      const res = await apiFetch(`/api/canvases/${id}`);
      if (res.ok) showCanvas((await res.json()).canvas);
    } catch {
      /* ignore */
    }
  }

  // BL CanvasList handleCreate: a blank title becomes "Untitled", and code
  // canvases carry their language.
  async function createCanvas() {
    const title = newTitle.trim() || 'Untitled';
    const language = newType === 'code' ? newLanguage.trim() || undefined : undefined;
    try {
      const res = await apiFetch('/api/canvases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, contentType: newType, language }),
      });
      if (res.ok) {
        const canvas: Canvas = (await res.json()).canvas;
        setNewTitle('');
        setNewType('markdown');
        setNewLanguage('');
        setShowCreate(false);
        await loadList();
        showCanvas(canvas);
      }
    } catch {
      /* ignore */
    }
  }

  // Save sends only what she changed (pendingSaveFields), so it can't put an
  // old title, body or tag set back over a newer one. With a newer version
  // waiting, tapping Save is her choosing her own words.
  async function save() {
    const cur = edRef.current;
    if (!cur) return;
    clearSaveTimer();
    setSaving(true);
    const fields = pendingSaveFields(cur);
    if (fields.title !== undefined) {
      commit(markTitleSent(edRef.current!, fields.title));
      await patch(cur.base.id, { title: fields.title });
    }
    if (fields.content !== undefined) await sendContent(fields.content);
    if (fields.tags !== undefined) {
      const r = markTagsSent(edRef.current!, echoesRef.current, fields.tags);
      echoesRef.current = r.echoes;
      commit(r.editor);
      await patch(cur.base.id, { tags: fields.tags });
    }
    await loadList();
    await loadTags();
    setSaving(false);
  }

  function closeEditor(force = false) {
    const cur = edRef.current;
    if (!force && cur?.incoming != null) {
      setConfirmLeave(true);
      return;
    }
    setConfirmLeave(false);
    if (!force) flushSave();
    clearSaveTimer();
    commit(null);
    void loadList();
  }

  async function remove(id: string) {
    try {
      await apiFetch(`/api/canvases/${id}`, { method: 'DELETE' });
      if (edRef.current?.base.id === id) { clearSaveTimer(); commit(null); }
      await loadList();
    } catch {
      /* ignore */
    }
  }

  const deleteDialog = confirmDelete && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-6" onClick={() => setConfirmDelete(null)}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="canvas-delete-title"
        className={cn('w-full max-w-xs rounded-2xl border p-5 shadow-2xl', colors.panelBg, colors.panelBorder)}
        onClick={(e) => e.stopPropagation()}
      >
        <h4 id="canvas-delete-title" className={cn('mb-2 break-words text-sm font-bold', colors.textMain)}>
          Delete canvas "{confirmDelete.title}"?
        </h4>
        <p className={cn('mb-4 text-xs leading-relaxed', colors.textMuted)}>This can't be undone.</p>
        <div className="flex justify-end gap-2">
          <button
            onClick={() => setConfirmDelete(null)}
            className={cn('rounded-lg border px-3 py-1.5 text-xs font-semibold', colors.panelBorder, colors.textMain)}
          >
            Cancel
          </button>
          <button
            onClick={() => { const id = confirmDelete.id; setConfirmDelete(null); void remove(id); }}
            className="rounded-lg px-3 py-1.5 text-xs font-semibold"
            style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );

  const input = cn('rounded-lg border px-3 py-2 text-sm bg-transparent', colors.panelBorder, colors.textMain);

  if (ed && active) {
    return (
      <AppShell
        title="Canvas"
        icon={FileText}
        onClose={() => closeEditor()}
        themeConfig={themeConfig}
        themeMode={themeMode}
        bodyClassName="flex flex-col"
        headerRight={
          <div className="flex items-center gap-1.5">
            {(active.content_type === 'markdown' || active.content_type === 'html') && (
              <button
                onClick={() => {
                  // BL toggleMode: flush the pending body save before previewing.
                  if (view === 'edit') flushSave();
                  setView(view === 'edit' ? 'preview' : 'edit');
                }}
                className={cn('rounded-full p-2 transition-colors hover:bg-black/10 dark:hover:bg-white/10', colors.textMuted)}
                title={view === 'edit' ? 'Preview formatted' : 'Back to editing'}
              >
                {view === 'edit' ? <Eye size={16} /> : <Pencil size={16} />}
              </button>
            )}
            <button
              onClick={() => sendToChat(active)}
              className={cn('rounded-full p-2 transition-colors hover:bg-black/10 dark:hover:bg-white/10', colors.textMuted)}
              title="Send to chat"
            >
              <MessageSquarePlus size={16} />
            </button>
            <button
              onClick={copyReference}
              className={cn('rounded-full p-2 transition-colors hover:bg-black/10 dark:hover:bg-white/10', colors.textMuted)}
              title={copied ? 'Copied!' : 'Copy reference'}
            >
              {copied ? <Check size={16} /> : <Link2 size={16} />}
            </button>
            <button
              onClick={() => setConfirmDelete(active)}
              className={cn('rounded-full p-2 transition-colors hover:bg-black/10 dark:hover:bg-white/10', colors.textMuted)}
              title="Delete canvas"
            >
              <Trash2 size={16} />
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="rounded-lg px-3 py-1.5 text-xs font-semibold bytelight-on-accent disabled:opacity-50"
              style={{ background: colors.accent }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        }
      >
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <section className={cn('shrink-0 rounded-2xl border p-3 shadow-sm backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
            <div className={cn('mb-1 text-[10px] font-bold uppercase tracking-[0.12em]', colors.textMuted)}>Document title</div>
            <input
              className={cn('w-full border-none bg-transparent p-0 text-base font-semibold outline-none', colors.textMain)}
              value={ed.draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onBlur={handleTitleBlur}
              onKeyDown={(e) => {
                // BL handleTitleKeydown: Enter commits the title.
                if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
              }}
              placeholder="Title"
            />
            <div className="mt-2 flex items-center gap-2">
              <span className={cn('rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide', colors.panelBorder, colors.textMuted)}>
                {active.content_type}
              </span>
              {active.language && (
                <span className={cn('text-[10px] uppercase tracking-wide', colors.textMuted)}>{active.language}</span>
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Tag size={12} className={cn(colors.textMuted)} />
              {draftTags.map((t, i) => (
                <span key={t} className={cn('flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold', colors.panelBorder, colors.textMain)}>
                  {t}
                  <button onClick={() => applyTags(draftTags.filter((_, j) => j !== i))} className="opacity-60 hover:opacity-100">
                    <X size={10} />
                  </button>
                </span>
              ))}
              <input
                className={cn('w-24 border-none bg-transparent text-[11px] outline-none', colors.textMain)}
                placeholder="+ tag"
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => {
                  // BL handleTagKeydown
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault();
                    addTag(newTag);
                  } else if (e.key === 'Escape') {
                    setNewTag('');
                  } else if (e.key === 'Backspace' && !newTag && draftTags.length > 0) {
                    applyTags(draftTags.slice(0, -1));
                  }
                }}
              />
            </div>
            {tagSuggestions.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {tagSuggestions.map((t) => (
                  <button
                    key={t}
                    onClick={() => addTag(t)}
                    className={cn('rounded-full border px-2 py-0.5 text-[10px]', colors.panelBorder, colors.textMuted)}
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}
          </section>
          <section className={cn('flex min-h-[24rem] flex-1 flex-col overflow-hidden rounded-2xl border shadow-sm backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
            <div className={cn('shrink-0 px-4 pt-3 text-[10px] font-bold uppercase tracking-[0.12em]', colors.textMuted)}>Content</div>
            {ed.incoming !== null && (
              <div
                className={cn('mx-3 mt-2 shrink-0 rounded-xl border px-3 py-2.5', colors.panelBorder)}
                style={{ borderColor: `${colors.accent}50` }}
                role="status"
              >
                <p className={cn('text-[12px] leading-snug', colors.textMain)}>A newer version came in while you were typing.</p>
                <p className={cn('mt-0.5 text-[11px] leading-snug', colors.textMuted)}>Your words are still here and nothing has saved over either one.</p>
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={takeLatest}
                    className={cn('flex-1 rounded-lg border px-3 py-1.5 text-[11px] font-semibold', colors.panelBorder, colors.textMain)}
                  >
                    Use latest
                  </button>
                  <button
                    onClick={keepMine}
                    className="flex-1 rounded-lg px-3 py-1.5 text-[11px] font-semibold bytelight-on-accent"
                    style={{ background: colors.accent }}
                  >
                    Keep mine
                  </button>
                </div>
              </div>
            )}
            {view === 'preview' && active.content_type === 'html' ? (
              // BL Canvas.svelte: HTML renders in a sandboxed frame on white.
              <div className="min-h-0 flex-1 px-3 pb-3 pt-2">
                <iframe
                  srcDoc={ed.draft}
                  sandbox="allow-same-origin"
                  title={active.title}
                  className="h-full w-full rounded-lg border-none bg-white"
                />
              </div>
            ) : view === 'preview' && active.content_type === 'markdown' ? (
              <div className={cn('prose prose-sm max-w-none min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-2', themeMode === 'dark' && 'prose-invert', colors.textMain)}>
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{ed.draft}</ReactMarkdown>
              </div>
            ) : (
              <textarea
                value={ed.draft}
                onChange={(e) => handleContentInput(e.target.value)}
                className={cn(
                  'min-h-0 w-full flex-1 resize-none border-none bg-transparent px-4 pb-4 pt-2 text-[13px] leading-relaxed outline-none',
                  colors.textMain,
                  active.content_type !== 'text' && 'font-mono',
                )}
              />
            )}
          </section>
        </div>
        {confirmLeave && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-6" onClick={() => setConfirmLeave(false)}>
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="canvas-leave-title"
              className={cn('w-full max-w-xs rounded-2xl border p-5 shadow-2xl', colors.panelBg, colors.panelBorder)}
              onClick={(e) => e.stopPropagation()}
            >
              <h4 id="canvas-leave-title" className={cn('mb-2 text-sm font-bold', colors.textMain)}>Leave without your edits?</h4>
              <p className={cn('mb-4 text-xs leading-relaxed', colors.textMuted)}>
                A newer version came in while you were typing. Leaving keeps that one and drops what you typed since.
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setConfirmLeave(false)}
                  className={cn('rounded-lg border px-3 py-1.5 text-xs font-semibold', colors.panelBorder, colors.textMain)}
                >
                  Stay
                </button>
                <button
                  onClick={() => closeEditor(true)}
                  className="rounded-lg px-3 py-1.5 text-xs font-semibold"
                  style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}
                >
                  Leave
                </button>
              </div>
            </div>
          </div>
        )}
        {deleteDialog}
      </AppShell>
    );
  }

  return (
    <AppShell
      title="Canvas"
      icon={FileText}
      onClose={onClose}
      themeConfig={themeConfig}
      themeMode={themeMode}
      headerRight={
        <button
          onClick={loadList}
          className={cn('rounded-full p-2 transition-colors hover:bg-black/10 dark:hover:bg-white/10', colors.textMuted)}
          title="Refresh"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
        </button>
      }
    >
      <div className={cn('rounded-2xl border p-3 backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
        <div className="flex items-center justify-between mb-3">
          <span className={cn('text-[11px] font-bold uppercase tracking-[0.12em]', colors.textMuted)}>Documents</span>
          <button onClick={() => setShowCreate(!showCreate)} className="rounded-full p-1.5 bytelight-on-accent" style={{ background: colors.accent }}>
            <Plus size={14} />
          </button>
        </div>

        {showCreate && (
          <div className="flex flex-col gap-2 mb-3">
            <input
              className={input}
              placeholder="Document title"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); void createCanvas(); }
                else if (e.key === 'Escape') setShowCreate(false);
              }}
            />
            <div className="flex gap-2">
              <select className={cn(input, 'flex-1')} value={newType} onChange={(e) => setNewType(e.target.value as Canvas['content_type'])}>
                {TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              {newType === 'code' && (
                <input
                  className={cn(input, 'w-28 min-w-0')}
                  placeholder="Language"
                  value={newLanguage}
                  onChange={(e) => setNewLanguage(e.target.value)}
                />
              )}
              <button onClick={createCanvas} className="rounded-lg px-4 text-sm font-semibold bytelight-on-accent" style={{ background: colors.accent }}>
                Create
              </button>
            </div>
          </div>
        )}

        <div className="mb-3 flex items-center gap-2">
          <div className={cn('flex flex-1 items-center gap-2 rounded-xl border px-3 py-2', colors.panelBorder)}>
            <Search size={14} className={cn(colors.textMuted)} />
            <input
              className={cn('w-full border-none bg-transparent text-sm outline-none', colors.textMain)}
              placeholder="Search title or tags…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <div className="relative">
            <button
              onClick={() => setTagDropdownOpen(!tagDropdownOpen)}
              className={cn('flex items-center gap-1 rounded-xl border px-3 py-2 text-xs font-semibold', colors.panelBorder, activeTag ? colors.textMain : colors.textMuted)}
              style={activeTag ? { borderColor: colors.accent } : undefined}
            >
              <Tag size={12} /> {activeTag || 'Tag'} <ChevronDown size={12} />
            </button>
            {tagDropdownOpen && (
              <div className={cn('absolute right-0 z-20 mt-1 max-h-48 w-40 overflow-y-auto rounded-xl border p-1 shadow-xl backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
                <button
                  onClick={() => { setActiveTag(null); setTagDropdownOpen(false); }}
                  className={cn('block w-full rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-black/5 dark:hover:bg-white/5', colors.textMuted)}
                >
                  All tags
                </button>
                {allTags.map((t) => (
                  <button
                    key={t}
                    onClick={() => { setActiveTag(t); setTagDropdownOpen(false); }}
                    className={cn('block w-full rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-black/5 dark:hover:bg-white/5', t === activeTag ? colors.textMain : colors.textMuted)}
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {loading ? (
          <div className={cn('text-xs py-6 text-center', colors.textMuted)}>Loading…</div>
        ) : filteredList.length === 0 ? (
          <div className={cn('text-xs py-6 text-center', colors.textMuted)}>{list.length === 0 ? 'No canvases yet.' : 'Nothing matches.'}</div>
        ) : (
          <div className="space-y-2">
            {filteredList.map((c) => (
              <div key={c.id} className={cn('flex items-center gap-2 rounded-xl border p-3', colors.panelBorder)}>
                <button onClick={() => open(c.id)} className="flex-1 min-w-0 text-left">
                  <div className={cn('text-sm font-medium truncate', colors.textMain)}>{c.title}</div>
                  {c.content && (
                    <div className={cn('truncate text-[12px] opacity-80', colors.textMuted)}>{contentPreview(c.content)}</div>
                  )}
                  <div className={cn('text-[11px]', colors.textMuted)}>
                    {c.content_type}{c.language ? ` · ${c.language}` : ''} · {formatTime(c.updated_at)}
                    {(c.tags?.length ?? 0) > 0 && <> · {c.tags!.join(', ')}</>}
                  </div>
                </button>
                <button onClick={() => sendToChat(c)} className={cn('p-1.5 shrink-0', colors.textMuted)} title="Send to chat">
                  <MessageSquarePlus size={15} />
                </button>
                <button onClick={() => setConfirmDelete(c)} className={cn('p-1.5 shrink-0', colors.textMuted)} title="Delete canvas">
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      {deleteDialog}
    </AppShell>
  );
}
