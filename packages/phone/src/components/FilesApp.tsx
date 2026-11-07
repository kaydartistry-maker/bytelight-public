import React, { useEffect, useMemo, useState } from 'react';
import { FolderOpen, RefreshCw, Loader2, Trash2, Copy, Check, Download } from 'lucide-react';
import { AppShell } from './AppShell';
import { Paginator, usePaged } from './Paginator';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import { copyToClipboard } from '../lib/clipboard';
import { saveToDevice } from '../lib/download';
import { apiFetch } from '../bytelight';
import { runPerItem } from '../lib/per-item';

interface FilesAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  embedded?: boolean;
}

interface FileEntry {
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  contentType: 'image' | 'audio' | 'file';
  createdAt: string;
  inUse: boolean;
}

type Filter = 'all' | 'image' | 'audio' | 'file' | 'orphan';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'image', label: 'Images' },
  { id: 'audio', label: 'Audio' },
  { id: 'file', label: 'Files' },
  { id: 'orphan', label: 'Orphans' },
];

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

const BADGE_LABELS: Record<string, string> = {
  image: 'IMG',
  audio: 'AUD',
  file: 'FILE',
};

// Anything we can render as words stays INSIDE the app. Leaving the SPA is
// what throws her to the lock screen, so the list of things worth reading in
// place is deliberately generous: the server labels plenty of readable files
// application/octet-stream, so the extension gets a vote too.
const TEXT_MIMES = new Set([
  'application/json',
  'application/javascript',
  'application/x-javascript',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/sql',
  'application/x-sh',
]);
const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonl', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'py', 'sh', 'bash', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'css', 'scss', 'html', 'xml', 'svg', 'csv', 'tsv', 'log', 'sql', 'diff', 'patch',
]);
// Big enough for the whole Cortex worker (67 KB) with room to spare; small
// enough that a stray database dump cannot lock the phone up rendering it.
const TEXT_PREVIEW_MAX = 2 * 1024 * 1024;

function isTextFile(file: FileEntry): boolean {
  const mime = (file.mimeType || '').toLowerCase();
  if (mime.startsWith('text/')) return true;
  if (TEXT_MIMES.has(mime)) return true;
  const ext = file.filename.includes('.') ? file.filename.split('.').pop()!.toLowerCase() : '';
  return TEXT_EXTS.has(ext);
}

export function FilesApp({ onClose, themeConfig, themeMode, embedded }: FilesAppProps) {
  const colors = themeConfig[themeMode];
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [totalSize, setTotalSize] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [orphanCount, setOrphanCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [preview, setPreview] = useState<FileEntry | null>(null);
  const [textBody, setTextBody] = useState<string | null>(null);
  const [textState, setTextState] = useState<'idle' | 'loading' | 'ready' | 'toobig' | 'error'>('idle');
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'failed'>('idle');
  // Special confirm states for the two bulk actions. "orphans" cleans
  // every file not referenced by any message metadata; "filtered" wipes
  // everything currently visible under the active filter.
  const [bulkConfirm, setBulkConfirm] = useState<null | 'orphans' | 'filtered'>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await apiFetch('/api/files/list');
      if (!res.ok) throw new Error('Failed to fetch files');
      const data = await res.json();
      setFiles(data.files || []);
      setTotalSize(data.totalSize || 0);
      setTotalCount(data.totalCount || 0);
      setOrphanCount(data.orphanCount || 0);
    } catch (err) {
      console.error('Failed to load files:', err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function deleteFile(fileId: string) {
    try {
      const res = await apiFetch(`/api/files/${fileId}`, { method: 'DELETE' });
      if (res.ok) {
        setFiles((prev) => {
          const next = prev.filter((f) => f.fileId !== fileId);
          setOrphanCount(next.filter((f) => !f.inUse).length);
          setTotalCount(next.length);
          setTotalSize(next.reduce((s, f) => s + f.size, 0));
          return next;
        });
      }
    } catch (err) {
      console.error('Failed to delete file:', err);
    }
    setDeleteConfirm(null);
  }

  const filtered = useMemo(() => {
    if (filter === 'orphan') return files.filter((f) => !f.inUse);
    if (filter === 'all') return files;
    return files.filter((f) => f.contentType === filter);
  }, [files, filter]);

  /* Files was the last list in the house still rolling its own paginator: fifty a
     page against everyone else's twenty, five bare numbers with no first or last to
     jump to, and — the one that actually cost her something — no clamp when the list
     shrank. This is the app whose whole verb is DELETE, singly and in bulk, so
     emptying the last page is not a corner case here. When it happened the page
     number stayed put, the slice came back empty, and because there were still files
     under the filter the empty-state never fired either: a blank screen with a row of
     page numbers under it. The shared hook keeps the page in range. */
  const { visible: paged, page, setPage, pageCount } = usePaged(filtered);

  // Clamping handles a list that shrank. Changing the FILTER is a different move and
  // wants page one outright, not the nearest page that happens to still exist.
  useEffect(() => {
    setPage(1);
  }, [filter, setPage]);

  // Text bodies are fetched, not <a href>'d — see the note on the View button.
  // Guarded against the racing close: a slow read landing after she has shut the
  // sheet must not repopulate it.
  useEffect(() => {
    setCopyState('idle');
    if (!preview || !isTextFile(preview)) {
      setTextBody(null);
      setTextState('idle');
      return;
    }
    if (preview.size > TEXT_PREVIEW_MAX) {
      setTextBody(null);
      setTextState('toobig');
      return;
    }
    let cancelled = false;
    setTextBody(null);
    setTextState('loading');
    (async () => {
      try {
        const res = await apiFetch(`/api/files/${preview.fileId}`);
        if (!res.ok) throw new Error(String(res.status));
        const body = await res.text();
        if (cancelled) return;
        setTextBody(body);
        setTextState('ready');
      } catch {
        if (!cancelled) setTextState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [preview]);

  async function copyBody() {
    if (textBody === null) return;
    setCopyState(await copyToClipboard(textBody) ? 'ok' : 'failed');
  }

  // There is no bulk route on the files API — only DELETE /api/files/:id — so both
  // bulk actions walk their list one file at a time. A file that fails stays put and
  // the rest still go; the list is reloaded from the server either way.
  async function deleteEach(ids: string[]) {
    setBulkBusy(true);
    try {
      const { failed } = await runPerItem(ids, async (id) => {
        const res = await apiFetch(`/api/files/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`Delete failed (${res.status})`);
      });
      if (failed.length) console.error(`Failed to delete ${failed.length} of ${ids.length} files`);
      await load();
    } finally {
      setBulkBusy(false);
      setBulkConfirm(null);
    }
  }

  async function cleanOrphans() {
    await deleteEach(files.filter((f) => !f.inUse).map((f) => f.fileId));
  }

  async function deleteFiltered() {
    await deleteEach(filtered.map((f) => f.fileId));
  }

  return (
    <AppShell
      embedded={embedded}
      title="Files"
      icon={FolderOpen}
      onClose={onClose}
      themeConfig={themeConfig}
      themeMode={themeMode}
      headerRight={
        <button
          onClick={() => load()}
          className={cn('rounded-full p-2 transition-colors hover:bg-black/10 dark:hover:bg-white/10', colors.textMuted)}
          title="Refresh"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
        </button>
      }
    >
      <div className={cn("p-4 rounded-2xl border backdrop-blur-md mb-4 space-y-3", colors.panelBg, colors.panelBorder)}>
      <div className={cn('flex items-center justify-between gap-2 text-xs', colors.textMuted)}>
        <div className="flex items-center gap-2">
          <span>{totalCount} files</span>
          <span>·</span>
          <span>{formatSize(totalSize)}</span>
          {orphanCount > 0 && (
            <>
              <span>·</span>
              <span style={{ color: colors.accent }}>{orphanCount} orphan{orphanCount === 1 ? '' : 's'}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {orphanCount > 0 && (
            <button
              onClick={() => setBulkConfirm('orphans')}
              className={cn('rounded-md border px-2 py-1 text-[10px] font-semibold uppercase tracking-wider', colors.panelBorder)}
              style={{ color: colors.accent, borderColor: colors.accent }}
              title="Delete every file not referenced by any message"
            >
              Clean orphans
            </button>
          )}
          {filter !== 'all' && filtered.length > 0 && (
            <button
              onClick={() => setBulkConfirm('filtered')}
              className={cn('rounded-md border px-2 py-1 text-[10px] font-semibold uppercase tracking-wider', colors.panelBorder)}
              style={{ color: colors.accent, borderColor: colors.accent }}
              title={`Delete all ${filtered.length} visible ${filter} files`}
            >
              Delete visible
            </button>
          )}
        </div>
      </div>

      {bulkConfirm && (
        <div className={cn('rounded-xl border p-3 mb-3', colors.panelBg)} style={{ borderColor: `${colors.accent}50` }}>
          <p className={cn('text-xs font-medium mb-2', colors.textMain)}>
            {bulkConfirm === 'orphans'
              ? `Delete ${orphanCount} orphan file${orphanCount === 1 ? '' : 's'}? Files not referenced by any message will be removed from disk.`
              : `Delete all ${filtered.length} ${filter} file${filtered.length === 1 ? '' : 's'} currently visible? This cannot be undone.`}
          </p>
          <div className="flex gap-2">
            <button
              onClick={bulkConfirm === 'orphans' ? cleanOrphans : deleteFiltered}
              disabled={bulkBusy}
              className="flex-1 rounded-md px-3 py-1.5 text-[11px] font-semibold disabled:opacity-50 flex items-center justify-center gap-1"
              style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}
            >
              {bulkBusy ? <Loader2 size={11} className="animate-spin" /> : <><Trash2 size={11} /> Yes, delete</>}
            </button>
            <button
              onClick={() => setBulkConfirm(null)}
              className={cn('flex-1 rounded-md border px-3 py-1.5 text-[11px]', colors.panelBorder, colors.textMain)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="flex gap-1.5 overflow-x-auto scrollbar-hide">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={cn('shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors border', colors.panelBorder, filter !== f.id && colors.panelBg)}
            style={filter === f.id ? { background: colors.accent, color: 'var(--bytelight-on-accent)' } : undefined}
          >
            {f.label}
          </button>
        ))}
      </div>
      </div>

      {loading ? (
        <div className={cn('text-xs py-6 text-center', colors.textMuted)}>Loading files…</div>
      ) : filtered.length === 0 ? (
        <div className={cn('text-xs py-6 text-center', colors.textMuted)}>
          {filter === 'orphan' ? 'No orphaned files.' : filter === 'all' ? 'No files uploaded yet.' : `No ${filter} files.`}
        </div>
      ) : (
        <div className="space-y-2">
          {paged.map((file) => {
            const badgeLabel = BADGE_LABELS[file.contentType] || 'FILE';
            return (
              <div key={file.fileId} className={cn('rounded-2xl border p-3', colors.panelBg, colors.panelBorder)}>
                <div className="flex items-center gap-2">
                  <span
                    className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide"
                    style={{ background: colors.accent + '22', color: colors.accent }}
                  >
                    {badgeLabel}
                  </span>
                  <span className={cn('flex-1 truncate text-sm', colors.textMain)}>{file.filename}</span>
                </div>
                <div className={cn('text-[11px] mt-1', colors.textMuted)}>
                  {formatSize(file.size)} · {formatDate(file.createdAt)}
                  {!file.inUse && <span style={{ color: colors.accent }}> · orphan</span>}
                </div>
                <div className="flex items-center gap-2 mt-2">
                  {/* Images, audio and now anything readable open in-app.
                      target="_blank" has no second tab inside the Android WebView,
                      so it replaced the whole app — and coming back remounted it,
                      which reinitialises osState from scratch. Viewing a file threw
                      her out of the app. Text was the gap: a long file was
                      the one thing she had to leave the app to read, on the morning
                      she most needed to copy one. Only what we genuinely cannot
                      render — pdf, zip, docx — still leaves. */}
                  {file.contentType === 'image' || file.contentType === 'audio' || isTextFile(file) ? (
                    <button
                      onClick={() => setPreview(file)}
                      className={cn('rounded-lg border px-2.5 py-1 text-[11px]', colors.panelBorder, colors.textMain)}
                    >
                      View
                    </button>
                  ) : null}
                  {/* Save was missing from this app entirely — every row offered
                      View and nothing else, and for a file this app cannot show
                      (pdf, zip, docx) View was a target="_blank" anchor. There is
                      no second tab in the WebView, so that REPLACED the whole app
                      and read as being thrown out to the lock screen; and with no
                      download flag on it nothing ever reached the shell's download
                      listener either. saveToDevice asks for ?download=1, which is
                      the Content-Disposition the listener actually reacts to, and
                      the server already answers it with the name she gave the
                      file. */}
                  <button
                    onClick={() => saveToDevice(`/api/files/${file.fileId}`, file.filename)}
                    className={cn('flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px]', colors.panelBorder, colors.textMain)}
                  >
                    <Download size={11} />
                    Save
                  </button>
                  {deleteConfirm === file.fileId ? (
                    <>
                      <button
                        onClick={() => deleteFile(file.fileId)}
                        className="rounded-lg px-2.5 py-1 text-[11px] font-semibold bytelight-on-accent"
                        style={{ background: colors.accent }}
                      >
                        Confirm
                      </button>
                      <button onClick={() => setDeleteConfirm(null)} className={cn('px-2 py-1 text-[11px]', colors.textMuted)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setDeleteConfirm(file.fileId)}
                      className={cn('rounded-lg px-2.5 py-1 text-[11px]', colors.textMuted)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          <Paginator page={page} pageCount={pageCount} onPage={setPage} colors={colors} />
        </div>
      )}

      {preview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
          onClick={() => setPreview(null)}
        >
          <div
            className={cn('w-full max-w-md rounded-2xl border p-4', colors.panelBg, colors.panelBorder)}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={cn('mb-3 truncate text-sm font-medium', colors.textMain)}>{preview.filename}</div>
            {preview.contentType === 'image' ? (
              <img
                src={`/api/files/${preview.fileId}`}
                alt={preview.filename}
                className="max-h-[60vh] w-full rounded-xl object-contain"
              />
            ) : preview.contentType === 'audio' ? (
              <audio src={`/api/files/${preview.fileId}`} controls autoPlay className="w-full" />
            ) : (
              <>
                {textState === 'loading' && (
                  <div className={cn('flex items-center gap-2 py-6 text-[12px]', colors.textMuted)}>
                    <Loader2 size={14} className="animate-spin" /> Reading…
                  </div>
                )}
                {textState === 'toobig' && (
                  <div className={cn('py-4 text-[12px]', colors.textMuted)}>
                    {formatSize(preview.size)} is too big to open in here without stalling the app.
                  </div>
                )}
                {textState === 'error' && (
                  <div className={cn('py-4 text-[12px]', colors.textMuted)}>That one would not read.</div>
                )}
                {textState === 'ready' && textBody !== null && (
                  /* whitespace-pre-wrap + break-all is the whole point: a code
                     block that does not wrap makes her scroll sideways through
                     the thing she is trying to read. */
                  <pre
                    className={cn(
                      'max-h-[55vh] overflow-auto rounded-xl border p-3 text-[11px] leading-relaxed',
                      'whitespace-pre-wrap break-all font-mono',
                      colors.panelBorder,
                      colors.textMain,
                    )}
                  >
                    {textBody}
                  </pre>
                )}
              </>
            )}
            <div className="mt-3 flex items-center justify-between gap-2">
              <span className={cn('text-[11px]', colors.textMuted)}>
                {formatSize(preview.size)} · {formatDate(preview.createdAt)}
              </span>
              <div className="flex items-center gap-2">
                {textState === 'ready' && (
                  <button
                    onClick={copyBody}
                    className={cn('flex items-center gap-1 rounded-lg border px-3 py-1 text-[11px]', colors.panelBorder, colors.textMain)}
                  >
                    {copyState === 'ok' ? <Check size={12} /> : <Copy size={12} />}
                    {copyState === 'ok' ? 'Copied' : copyState === 'failed' ? 'Select it by hand' : 'Copy'}
                  </button>
                )}
                <button
                  onClick={() => setPreview(null)}
                  className={cn('rounded-lg border px-3 py-1 text-[11px]', colors.panelBorder, colors.textMain)}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
