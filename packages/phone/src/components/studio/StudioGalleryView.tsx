import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check, ChevronDown, Copy, Download, Folder, FolderPlus, Images,
  Loader2, MessageSquare, MoreHorizontal, Tag, Trash2, X,
} from 'lucide-react';
import { apiFetch } from '../../bytelight';
import { cn } from '../../lib/utils';
import { runPerItem } from '../../lib/per-item';
import { Paginator, usePaged } from '../Paginator';
import { thumbSrc } from '../../lib/thumb';
import type { ThemeColors } from '../../lib/theme';
import { ACCENT_TEXT_COLOR_BY_THEME } from './constants';
import { copyStudioText, filterGallery, galleryItemToImage } from './gallery-utils';
import type { GeneratedImage, RefDrawer, StudioFolder, ThemeMode } from './types';
import { ZoomableImage } from '../ZoomableImage';

interface StudioGalleryViewProps {
  /** Rendered as the first thing inside the scroller — Studio hands its nav
   *  card down here so the tabs scroll away with the gallery instead of
   *  sitting pinned above it. */
  topSlot?: React.ReactNode;
  colors: ThemeColors;
  themeMode: ThemeMode;
  drawers: RefDrawer[];
  folders: StudioFolder[];
  setFolders: (folders: StudioFolder[] | ((folders: StudioFolder[]) => StudioFolder[])) => void;
  onUsePrompt: (image: GeneratedImage) => void;
  onReuseSetup: (image: GeneratedImage) => void;
  onDownload: (image: GeneratedImage) => void;
  onGalleryChanged: () => void;
  /** Leave Studio for the chat message an item was posted in. */
  onJumpToMessage?: (threadId: string, messageId: string) => void;
}

// Thirty a page because the grid is three wide and thirty is ten clean rows.
const PAGE_SIZE = 30;

function mediaPreview(image: GeneratedImage, className: string) {
  if (image.mediaType === 'video') {
    return <video src={image.src} className={className} muted playsInline preload="metadata" />;
  }
  return <img src={thumbSrc(image.src, 480)} alt={image.prompt} className={className} loading="lazy" />;
}

export function StudioGalleryView({
  topSlot,
  colors,
  themeMode,
  drawers,
  folders,
  setFolders,
  onUsePrompt,
  onReuseSetup,
  onDownload,
  onGalleryChanged,
  onJumpToMessage,
}: StudioGalleryViewProps) {
  // GET /api/studio/gallery takes no query and returns every item, newest first.
  // The gallery is fetched once and the folder and subject views are cut from it
  // here, the way the desktop Studio gallery does it.
  const [items, setItems] = useState<GeneratedImage[]>([]);
  const [folderId, setFolderId] = useState('');
  const [subject, setSubject] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<GeneratedImage | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showFolderCreator, setShowFolderCreator] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [folderBusy, setFolderBusy] = useState(false);
  const [showBulkFolderPicker, setShowBulkFolderPicker] = useState(false);
  const [movingSelection, setMovingSelection] = useState(false);
  const [bulkFolderName, setBulkFolderName] = useState('');

  const filtered = useMemo(() => filterGallery(items, folderId, subject), [items, folderId, subject]);
  const imagesPage = usePaged(filtered, PAGE_SIZE);
  const setImagesPage = imagesPage.setPage;
  const labels = useMemo(() => new Map(drawers.map((drawer) => [drawer.slug, drawer.label])), [drawers]);
  const labelFor = useCallback((slug: string) => labels.get(slug) ?? slug, [labels]);

  const loadGallery = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch('/api/studio/gallery');
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Gallery request failed (${response.status})`);
      }
      const data = await response.json();
      setItems(Array.isArray(data.items) ? data.items.map(galleryItemToImage) : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Gallery could not be loaded');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadGallery(); }, [loadGallery]);

  // A new filter is a new view: back to page one, nothing carried over selected.
  useEffect(() => {
    setImagesPage(1);
    setSelectedIds(new Set());
  }, [folderId, subject, setImagesPage]);

  useEffect(() => {
    if (!selectionMode || selectedIds.size === 0) setShowBulkFolderPicker(false);
  }, [selectionMode, selectedIds]);

  const refresh = useCallback(async () => {
    await loadGallery();
    onGalleryChanged();
  }, [loadGallery, onGalleryChanged]);

  const toggleSelected = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const moveToFolder = async (image: GeneratedImage, nextFolderId: string) => {
    try {
      const response = await apiFetch(`/api/studio/gallery/${encodeURIComponent(image.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId: nextFolderId || null }),
      });
      if (!response.ok) throw new Error('Move failed');
      const updated = { ...image, folderId: nextFolderId || undefined };
      setViewing(updated);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Move failed');
    }
  };

  // The gallery API only moves one item at a time (PATCH /api/studio/gallery/:filename),
  // so a selection is moved item by item. One that fails does not stop the others.
  const moveEach = async (filenames: string[], nextFolderId: string) => {
    const { failed } = await runPerItem(filenames, async (filename) => {
      const response = await apiFetch(`/api/studio/gallery/${encodeURIComponent(filename)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId: nextFolderId || null }),
      });
      if (!response.ok) throw new Error('Move failed');
    });
    return failed;
  };

  const finishSelectionMove = async (failed: string[], total: number) => {
    setShowBulkFolderPicker(false);
    setSelectedIds(new Set());
    setSelectionMode(false);
    await refresh();
    if (failed.length) setError(`${failed.length} of ${total} images could not be moved`);
  };

  const moveSelectionToFolder = async (nextFolderId: string) => {
    if (selectedIds.size === 0 || movingSelection) return;
    setMovingSelection(true);
    try {
      const filenames = Array.from(selectedIds);
      const failed = await moveEach(filenames, nextFolderId);
      await finishSelectionMove(failed, filenames.length);
    } finally {
      setMovingSelection(false);
    }
  };

  const createFolderAndMoveSelection = async () => {
    const name = bulkFolderName.trim();
    if (!name || selectedIds.size === 0 || movingSelection) return;
    setMovingSelection(true);
    try {
      const folderResponse = await apiFetch('/api/studio/folders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!folderResponse.ok) throw new Error('Folder could not be created');
      const folderData = await folderResponse.json();
      const newFolder = folderData.folder as StudioFolder;
      setFolders((current) => [...current, newFolder]);
      setBulkFolderName('');

      const filenames = Array.from(selectedIds);
      const failed = await moveEach(filenames, newFolder.id);
      await finishSelectionMove(failed, filenames.length);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Folder could not be created');
    } finally {
      setMovingSelection(false);
    }
  };

  const deleteImage = async (image: GeneratedImage) => {
    if (!window.confirm('Delete this gallery item? This cannot be undone.')) return;
    try {
      const response = await apiFetch(`/api/studio/gallery/${encodeURIComponent(image.id)}`, { method: 'DELETE' });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Delete failed');
      }
      setViewing(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Delete failed');
    }
  };

  const createFolder = async () => {
    if (!folderName.trim() || folderBusy) return;
    setFolderBusy(true);
    try {
      const response = await apiFetch('/api/studio/folders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: folderName.trim() }),
      });
      if (!response.ok) throw new Error('Folder could not be created');
      const data = await response.json();
      setFolders((current) => [...current, data.folder]);
      setFolderId(data.folder.id);
      setFolderName('');
      setShowFolderCreator(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Folder could not be created');
    } finally {
      setFolderBusy(false);
    }
  };

  const deleteCurrentFolder = async () => {
    if (!folderId || !window.confirm('Delete this folder? Its images will return to the main gallery.')) return;
    try {
      const response = await apiFetch(`/api/studio/folders/${encodeURIComponent(folderId)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Folder could not be deleted');
      setFolders((current) => current.filter((folder) => folder.id !== folderId));
      setFolderId('');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Folder could not be deleted');
    }
  };

  const copyPrompt = async (image: GeneratedImage) => {
    const lines = [image.prompt];
    lines.push(`Model: ${image.backend}/${image.model}`);
    if (image.aspectRatio) lines.push(`Aspect: ${image.aspectRatio}`);
    if (image.referenceDrawers?.length) lines.push(`References: ${image.referenceDrawers.join(', ')}`);
    await copyStudioText(lines.join('\n'));
  };

  return (
    <div className="bytelight-app-body flex-1 overflow-y-auto px-4 pb-24 pt-3">
      {topSlot}
      <div className="space-y-4">
        <section className={cn('space-y-3 rounded-2xl border p-3 shadow-lg backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
          <div className="flex items-center gap-2">
            <div className={cn('relative min-w-0 flex-1 rounded-xl border', colors.panelBg, colors.panelBorder)}>
              <Folder className={cn('pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2', colors.textMuted)} />
              <select
                value={folderId}
                onChange={(event) => setFolderId(event.target.value)}
                className={cn('w-full appearance-none bg-transparent py-2 pl-9 pr-8 text-xs outline-none', colors.textMain)}
              >
                <option value="">Every project folder</option>
                {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
              </select>
              <ChevronDown className={cn('pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2', colors.textMuted)} />
            </div>
            <button type="button" onClick={() => setShowFolderCreator((value) => !value)} className={cn('rounded-xl border p-2', colors.panelBg, colors.panelBorder, colors.textMuted)} title="New folder">
              <FolderPlus className="h-4 w-4" />
            </button>
            {folderId && (
              <button type="button" onClick={deleteCurrentFolder} className="rounded-xl border border-red-500/30 p-2 text-red-400" title="Delete selected folder">
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>

          <div className={cn('relative rounded-xl border', colors.panelBg, colors.panelBorder)}>
            <Tag className={cn('pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2', colors.textMuted)} />
            <select
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              className={cn('w-full appearance-none bg-transparent py-2 pl-9 pr-8 text-xs outline-none', colors.textMain)}
            >
              <option value="">Every subject</option>
              {drawers.map((drawer) => <option key={drawer.slug} value={drawer.slug}>{drawer.label}</option>)}
            </select>
            <ChevronDown className={cn('pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2', colors.textMuted)} />
          </div>

          {showFolderCreator && (
            <div className={cn('flex gap-2 rounded-xl border p-2', colors.panelBg, colors.panelBorder)}>
              <input
                value={folderName}
                onChange={(event) => setFolderName(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void createFolder(); }}
                placeholder="Project folder name"
                className={cn('min-w-0 flex-1 bg-transparent px-2 text-sm outline-none', colors.textMain)}
                autoFocus
              />
              <button type="button" onClick={createFolder} disabled={folderBusy || !folderName.trim()} className="rounded-lg px-3 py-2 text-xs font-semibold disabled:opacity-40" style={{ backgroundColor: colors.accent, color: ACCENT_TEXT_COLOR_BY_THEME[themeMode] }}>
                {folderBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create'}
              </button>
            </div>
          )}
        </section>

        <div className={cn('flex items-center justify-between rounded-2xl border px-3 py-2.5 shadow-lg backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
          <div>
            <p className={cn('text-sm font-semibold', colors.textMain)}>{filtered.length} {filtered.length === 1 ? 'creation' : 'creations'}</p>
            <p className={cn('text-[10px]', colors.textMuted)}>{folderId || subject ? `Filtered from ${items.length}` : 'Newest first'}</p>
          </div>
          <button
            type="button"
            onClick={() => { setSelectionMode((value) => !value); setSelectedIds(new Set()); }}
            className={cn('rounded-lg px-2.5 py-1.5 text-xs font-medium', colors.textMuted)}
          >
            {selectionMode ? 'Done' : 'Select'}
          </button>
        </div>

        {error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}

        {filtered.length === 0 && !loading ? (
          <div className={cn('rounded-2xl border border-dashed py-16 text-center', colors.panelBorder, colors.textMuted)}>
            <Images className="mx-auto mb-3 h-10 w-10 opacity-30" />
            <p className="text-sm">Nothing here yet</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              {imagesPage.visible.map((image) => {
                const selected = selectedIds.has(image.id);
                return (
                  <button
                    type="button"
                    key={image.id}
                    onClick={() => selectionMode ? toggleSelected(image.id) : setViewing(image)}
                    className={cn(
                      'relative aspect-square overflow-hidden rounded-xl border-2 p-0.5 shadow-md backdrop-blur-sm transition-[border-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60',
                      colors.panelBg,
                      !selected && colors.panelBorder,
                    )}
                    style={selected ? {
                      borderColor: colors.accent,
                      boxShadow: `0 0 0 1px ${colors.accent}, 0 8px 20px rgba(0, 0, 0, 0.28)`,
                    } : undefined}
                    aria-pressed={selectionMode ? selected : undefined}
                    aria-label={selectionMode ? `${selected ? 'Deselect' : 'Select'} gallery image` : 'Open gallery image'}
                  >
                    {mediaPreview(image, 'h-full w-full rounded-[9px] object-cover')}
                    {selectionMode && (
                      <span className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full border bg-black/65 text-white">
                        {selected && <Check className="h-4 w-4" />}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <Paginator page={imagesPage.page} pageCount={imagesPage.pageCount} onPage={imagesPage.setPage} colors={colors} />
          </>
        )}

        {loading && (
          <div className={cn('flex items-center justify-center gap-2 py-6 text-xs', colors.textMuted)}>
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading gallery
          </div>
        )}
      </div>

      {selectionMode && selectedIds.size > 0 && (
        <div className="fixed bottom-[calc(var(--sab)+1rem)] left-1/2 z-30 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-2xl border border-white/15 bg-black/90 px-3 py-2 text-white shadow-2xl backdrop-blur-xl">
          <span className="text-xs font-semibold">{selectedIds.size} selected</span>
          <button type="button" onClick={() => setShowBulkFolderPicker(true)} className="flex items-center gap-1 rounded-lg bg-white/10 px-2.5 py-1.5 text-xs">
            <Folder className="h-3.5 w-3.5" /> Move
          </button>
        </div>
      )}

      {showBulkFolderPicker && selectedIds.size > 0 && (
        <div className="absolute inset-0 z-50 flex items-end bg-black/70 p-4">
          <div className={cn('max-h-[75vh] w-full overflow-y-auto rounded-2xl border p-4 shadow-2xl', colors.pageBg, colors.panelBorder)}>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className={cn('font-semibold', colors.textMain)}>Move {selectedIds.size} {selectedIds.size === 1 ? 'image' : 'images'}</h2>
                <p className={cn('text-xs', colors.textMuted)}>Choose a project folder.</p>
              </div>
              <button type="button" onClick={() => setShowBulkFolderPicker(false)} disabled={movingSelection} className={cn('rounded-full p-2', colors.textMuted)}><X className="h-4 w-4" /></button>
            </div>
            <div className="space-y-2">
              <div className={cn('flex gap-2 rounded-xl border p-2', colors.panelBg, colors.panelBorder)}>
                <input
                  value={bulkFolderName}
                  onChange={(event) => setBulkFolderName(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') void createFolderAndMoveSelection(); }}
                  placeholder="New folder for these images"
                  disabled={movingSelection}
                  className={cn('min-w-0 flex-1 bg-transparent px-2 text-sm outline-none', colors.textMain)}
                />
                <button
                  type="button"
                  onClick={() => void createFolderAndMoveSelection()}
                  disabled={movingSelection || !bulkFolderName.trim()}
                  className="shrink-0 rounded-lg px-3 py-2 text-xs font-semibold disabled:opacity-40"
                  style={{ backgroundColor: colors.accent, color: ACCENT_TEXT_COLOR_BY_THEME[themeMode] }}
                >
                  Create + move
                </button>
              </div>
              <button
                type="button"
                onClick={() => void moveSelectionToFolder('')}
                disabled={movingSelection}
                className={cn('flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left text-sm disabled:opacity-50', colors.panelBg, colors.panelBorder, colors.textMain)}
              >
                <Folder className={cn('h-4 w-4', colors.textMuted)} /> No project folder
              </button>
              {folders.map((folder) => (
                <button
                  type="button"
                  key={folder.id}
                  onClick={() => void moveSelectionToFolder(folder.id)}
                  disabled={movingSelection}
                  className={cn('flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left text-sm disabled:opacity-50', colors.panelBg, colors.panelBorder, colors.textMain)}
                >
                  <Folder className="h-4 w-4" style={{ color: colors.accent }} /> {folder.name}
                </button>
              ))}
              {folders.length === 0 && (
                <p className={cn('rounded-xl border border-dashed px-3 py-6 text-center text-xs', colors.panelBorder, colors.textMuted)}>
                  No project folders yet. Name one above to create it and move this selection in one step.
                </p>
              )}
            </div>
            {movingSelection && <div className={cn('mt-3 flex items-center justify-center gap-2 text-xs', colors.textMuted)}><Loader2 className="h-4 w-4 animate-spin" /> Moving images</div>}
          </div>
        </div>
      )}

      {viewing && (
        <div className="absolute inset-0 z-40 flex flex-col bg-black/95 text-white">
          <div className="flex items-center justify-between p-4" style={{ paddingTop: 'calc(var(--sat) + 0.75rem)' }}>
            <button type="button" onClick={() => setViewing(null)} className="rounded-full bg-white/10 p-2"><X className="h-5 w-5" /></button>
            <div className="flex gap-2">
              <button type="button" onClick={() => onDownload(viewing)} className="rounded-full bg-white/10 p-2" title="Download"><Download className="h-4 w-4" /></button>
              <button type="button" onClick={() => void deleteImage(viewing)} className="rounded-full bg-red-500/20 p-2 text-red-300" title="Delete"><Trash2 className="h-4 w-4" /></button>
            </div>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center p-4">
            {viewing.mediaType === 'video'
              ? <video src={viewing.src} className="max-h-full max-w-full" controls loop playsInline autoPlay />
              : <ZoomableImage src={viewing.src} alt={viewing.prompt} className="rounded-xl" />}
          </div>
          <div className="space-y-3 border-t border-white/10 bg-black/85 p-4 pb-[calc(var(--sab)+1rem)]">
            <p className="max-h-24 overflow-y-auto whitespace-pre-wrap text-sm">{viewing.prompt || 'No prompt stored for this asset.'}</p>
            <div className="flex gap-2 overflow-x-auto">
              <button type="button" onClick={() => onUsePrompt(viewing)} disabled={!viewing.prompt} className="shrink-0 rounded-xl px-3 py-2 text-xs font-semibold disabled:opacity-40" style={{ backgroundColor: colors.accent, color: ACCENT_TEXT_COLOR_BY_THEME[themeMode] }}>Use prompt</button>
              <button type="button" onClick={() => onReuseSetup(viewing)} disabled={!viewing.prompt} className="shrink-0 rounded-xl bg-white/10 px-3 py-2 text-xs font-semibold disabled:opacity-40">Reuse setup</button>
              <button type="button" onClick={() => void copyPrompt(viewing)} disabled={!viewing.prompt} className="shrink-0 rounded-xl bg-white/10 p-2.5 disabled:opacity-40" title="Copy prompt and settings"><Copy className="h-4 w-4" /></button>
              {onJumpToMessage && viewing.threadId && viewing.messageId && (
                <button
                  type="button"
                  onClick={() => { const { threadId, messageId } = viewing; setViewing(null); onJumpToMessage(threadId!, messageId!); }}
                  className="flex shrink-0 items-center gap-1 rounded-xl bg-white/10 px-3 py-2 text-xs font-semibold"
                  title={`Jump to "${viewing.threadName ?? 'chat'}"`}
                >
                  <MessageSquare className="h-3.5 w-3.5" /> Go to chat
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Folder className="h-4 w-4 text-white/50" />
              <select value={viewing.folderId ?? ''} onChange={(event) => void moveToFolder(viewing, event.target.value)} className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/10 px-2 py-2 text-xs text-white">
                <option value="">No project folder</option>
                {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
              </select>
              <MoreHorizontal className="h-4 w-4 text-white/30" />
            </div>
            <p className="text-[10px] uppercase tracking-wide text-white/45">
              {viewing.backend} · {viewing.model.split('/').pop()}
              {viewing.references?.length ? ` · ${viewing.references.map(labelFor).join(', ')}` : ''}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
