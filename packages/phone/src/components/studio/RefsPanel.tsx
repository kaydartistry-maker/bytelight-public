import { useId, useRef, useState } from 'react';
import { Upload, Trash2, Loader2, Pencil, Plus, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { refThumbSrc } from '../../lib/thumb';
import type { RefsPanelProps } from './types';
import { ACCENT_TEXT_COLOR_BY_THEME } from './constants';

export function RefsPanel({
  colors,
  themeMode,
  drawers,
  uploadingFor,
  refInputRefs,
  handleRefFileChange,
  deleteRefImage,
  renameDrawer,
  deleteDrawer,
  newDrawerName,
  setNewDrawerName,
  createDrawer,
  creatingDrawer,
  error,
}: RefsPanelProps) {
  const inputIdPrefix = useId().replace(/:/g, '');
  const pendingRefDeletes = useRef(new Set<string>());
  const [pendingDeleteKeys, setPendingDeleteKeys] = useState<Set<string>>(() => new Set());
  const [renaming, setRenaming] = useState<{ slug: string; label: string; emoji: string } | null>(null);
  const [savingRename, setSavingRename] = useState(false);

  const confirmRename = async () => {
    if (!renaming || savingRename) return;
    const label = renaming.label.trim();
    if (!label) return;
    setSavingRename(true);
    try {
      if (await renameDrawer(renaming.slug, label, renaming.emoji.trim() || undefined)) setRenaming(null);
    } finally {
      setSavingRename(false);
    }
  };

  const requestRefDelete = async (slug: string, drawerLabel: string, filename: string) => {
    const key = `${slug}\u0000${filename}`;
    if (pendingRefDeletes.current.has(key)) return;
    if (!window.confirm(`Delete “${filename}” from ${drawerLabel}?`)) return;

    pendingRefDeletes.current.add(key);
    setPendingDeleteKeys(current => new Set(current).add(key));
    try {
      await deleteRefImage(slug, filename);
    } finally {
      pendingRefDeletes.current.delete(key);
      setPendingDeleteKeys(current => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      <p className={cn("rounded-xl border px-3 py-2 text-sm", colors.panelBg, colors.panelBorder, colors.textMuted)}>
        Upload reference images for each subject. When generating, select subjects to include their references.
      </p>
      {error && (
        <div className="sticky top-0 z-10 rounded-xl border border-red-500/30 bg-red-950/90 px-3 py-2 text-sm text-red-200 shadow-lg backdrop-blur">
          {error}
        </div>
      )}

      {drawers.map(drawer => {
        const inputId = `${inputIdPrefix}-reference-upload-${drawer.slug}`;

        return (
          <div key={drawer.slug} className={cn("rounded-xl border p-4", colors.panelBg, colors.panelBorder)}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex min-w-0 items-center gap-2">
                {drawer.emoji && <span className="text-lg">{drawer.emoji}</span>}
                <span className={cn("truncate font-medium", colors.textMain)}>{drawer.label}</span>
                <span className={cn("text-xs", colors.textMuted)}>({drawer.refs.length})</span>
              </div>
              <div className="ml-2 flex shrink-0 items-center gap-1">
                {/* accept must stay image/* — bare file extensions make the Android
                    WebView fall back to the full document chooser instead of the
                    photo picker, and returning from that is where the app comes
                    back black. (The Inbox still lists bare extensions, by the way —
                    that earlier "every other image input here uses image/*" was wrong.)

                    className must stay `hidden`, i.e. display:none. It was `peer
                    sr-only`, which keeps the input laid out at 1px, absolutely
                    positioned and clipped — the only one of the seventeen file
                    inputs in the app built that way, and the only one that took the
                    whole app black when its picker opened. A display:none input is
                    never laid out and cannot be focused or scrolled to; an sr-only
                    one is both, while the chooser Intent is launching. GIF Lab's
                    "Add Images" is the control case: same accept, same multiple,
                    also opened by a label, hidden with display:none, and it works. */}
                <input
                  id={inputId}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  ref={el => { refInputRefs.current[drawer.slug] = el; }}
                  onChange={(e) => handleRefFileChange(drawer.slug, e)}
                  disabled={uploadingFor === drawer.slug}
                  aria-label={`Add reference images to ${drawer.label}`}
                />
                <label
                  htmlFor={inputId}
                  aria-disabled={uploadingFor === drawer.slug}
                  className={cn(
                    "flex min-h-11 cursor-pointer touch-manipulation items-center gap-1 rounded-lg px-3 text-xs font-medium",
                    // No peer-focus-visible ring: a display:none input cannot take
                    // focus, so those classes could never fire once the input stopped
                    // being sr-only. Same trade GIF Lab's label already makes.
                    "hover:bg-black/10 dark:hover:bg-white/10",
                    colors.textMuted,
                    uploadingFor === drawer.slug && "pointer-events-none cursor-wait opacity-50",
                  )}
                >
                  {uploadingFor === drawer.slug ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
                  {uploadingFor === drawer.slug ? 'Uploading...' : 'Add'}
                </label>
                {!drawer.isDefault && (
                  <button
                    type="button"
                    onClick={() => setRenaming({ slug: drawer.slug, label: drawer.label, emoji: drawer.emoji ?? '' })}
                    className={cn("flex min-h-11 min-w-11 touch-manipulation items-center justify-center rounded-lg hover:bg-black/10 dark:hover:bg-white/10", colors.textMuted)}
                    title="Rename drawer"
                    aria-label={`Rename ${drawer.label} drawer`}
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                )}
                {!drawer.isDefault && (
                  <button
                    type="button"
                    onClick={() => deleteDrawer(drawer.slug)}
                    className={cn("flex min-h-11 min-w-11 touch-manipulation items-center justify-center rounded-lg text-red-500 hover:bg-red-500/10")}
                    title="Delete drawer"
                    aria-label={`Delete ${drawer.label} drawer`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>

            {renaming?.slug === drawer.slug && (
              <div className={cn("mb-3 flex gap-2 rounded-lg border p-2", colors.panelBorder)}>
                <input
                  type="text"
                  value={renaming.emoji}
                  onChange={(e) => setRenaming({ ...renaming, emoji: e.target.value })}
                  placeholder="🙂"
                  aria-label="Drawer emoji"
                  className={cn("w-12 rounded-lg border px-2 py-2 text-center text-sm", colors.panelBg, colors.panelBorder, colors.textMain)}
                />
                <input
                  type="text"
                  value={renaming.label}
                  onChange={(e) => setRenaming({ ...renaming, label: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter') void confirmRename(); if (e.key === 'Escape') setRenaming(null); }}
                  aria-label="Drawer name"
                  autoFocus
                  className={cn("min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm", colors.panelBg, colors.panelBorder, colors.textMain)}
                />
                <button
                  type="button"
                  onClick={() => void confirmRename()}
                  disabled={savingRename || !renaming.label.trim()}
                  className="rounded-lg px-3 py-2 text-xs font-semibold disabled:opacity-50"
                  style={{ backgroundColor: colors.accent, color: ACCENT_TEXT_COLOR_BY_THEME[themeMode] }}
                >
                  {savingRename ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Rename'}
                </button>
                <button
                  type="button"
                  onClick={() => setRenaming(null)}
                  className={cn("rounded-lg px-2", colors.textMuted)}
                  aria-label="Cancel rename"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {drawer.refs.length > 0 ? (
              <div className="grid grid-cols-3 gap-2">
                {drawer.refs.map(ref => {
                  const deleteKey = `${drawer.slug}\u0000${ref.filename}`;
                  const isDeleting = pendingDeleteKeys.has(deleteKey);

                  return (
                    <div
                      key={ref.filename}
                      className="relative aspect-square overflow-hidden rounded-lg bg-black/10 dark:bg-white/5"
                    >
                      <div
                        aria-hidden="true"
                        className="absolute inset-0 animate-pulse bg-gradient-to-br from-white/10 via-transparent to-black/10"
                      />
                      <img
                        src={refThumbSrc(ref.url, 256)}
                        alt={ref.filename}
                        loading="lazy"
                        decoding="async"
                        draggable={false}
                        className="relative h-full w-full object-cover"
                      />
                      <button
                        type="button"
                        onClick={() => void requestRefDelete(drawer.slug, drawer.label, ref.filename)}
                        disabled={isDeleting}
                        className="group absolute right-0 top-0 z-10 flex h-11 w-11 touch-manipulation items-center justify-center rounded-full text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white disabled:cursor-wait disabled:opacity-80"
                        title={isDeleting ? `Deleting ${ref.filename}` : `Delete ${ref.filename}`}
                        aria-label={isDeleting ? `Deleting ${ref.filename}` : `Delete ${ref.filename}`}
                        aria-busy={isDeleting}
                      >
                        <span className="flex h-7 w-7 items-center justify-center rounded-full border border-white/25 bg-black/75 shadow-md transition-colors group-hover:bg-red-600">
                          {isDeleting
                            ? <Loader2 className="h-4 w-4 animate-spin" />
                            : <X className="h-4 w-4" />}
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className={cn("text-sm text-center py-4", colors.textMuted)}>No references yet</p>
            )}
          </div>
        );
      })}

      {/* New Drawer */}
      <div className={cn("rounded-xl border-2 border-dashed p-4", colors.panelBorder)}>
        <div className="flex gap-2">
          <input
            type="text"
            value={newDrawerName}
            onChange={(e) => setNewDrawerName(e.target.value)}
            placeholder="New drawer name..."
            className={cn("flex-1 px-3 py-2 rounded-lg border text-sm", colors.panelBg, colors.panelBorder, colors.textMain, "placeholder:opacity-50")}
            onKeyDown={(e) => e.key === 'Enter' && createDrawer()}
          />
          <button
            type="button"
            onClick={createDrawer}
            disabled={!newDrawerName.trim() || creatingDrawer}
            className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 flex items-center gap-1"
            style={{ backgroundColor: colors.accent, color: ACCENT_TEXT_COLOR_BY_THEME[themeMode] }}
          >
            {creatingDrawer ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
