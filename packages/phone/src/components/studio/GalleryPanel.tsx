import { useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ChevronLeft, ChevronRight, Download, Trash2, Edit3, X,
  Copy, FolderPlus, Folder, Users,
} from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '../../lib/utils';
import { thumbSrc } from '../../lib/thumb';
import type { GalleryPanelProps, GeneratedImage } from './types';
import type { ThemeColors } from '../../lib/theme';
import { ACCENT_TEXT_COLOR_BY_THEME } from './constants';

const THUMB_SIZE = 64;
const THUMB_GAP = 8;

function VirtualizedHistoryStrip({
  filteredHistory,
  currentImage,
  selectFromHistory,
  colors,
}: {
  filteredHistory: GeneratedImage[];
  currentImage: GeneratedImage | null;
  selectFromHistory: (img: GeneratedImage) => void;
  colors: ThemeColors;
}) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: filteredHistory.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => THUMB_SIZE + THUMB_GAP,
    horizontal: true,
    overscan: 5,
  });

  return (
    <div
      ref={parentRef}
      className="overflow-x-auto pb-2"
      style={{ height: THUMB_SIZE + 8 }}
    >
      <div
        style={{
          width: virtualizer.getTotalSize(),
          height: THUMB_SIZE,
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const img = filteredHistory[virtualItem.index];
          const isSelected = currentImage?.id === img.id;
          return (
            <div
              key={img.id}
              onClick={() => selectFromHistory(img)}
              className={cn(
                "absolute top-0 rounded-lg overflow-hidden border-2 transition-all cursor-pointer",
                isSelected ? "border-current" : "border-transparent opacity-70 hover:opacity-100"
              )}
              style={{
                left: virtualItem.start,
                width: THUMB_SIZE,
                height: THUMB_SIZE,
                borderColor: isSelected ? colors.accent : undefined,
              }}
            >
              {img.mediaType === 'video' ? (
                <div className="relative w-full h-full">
                  <video src={img.src} className="w-full h-full object-cover" muted playsInline preload="metadata" />
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="w-5 h-5 rounded-full bg-black/50 flex items-center justify-center">
                      <div className="w-0 h-0 border-y-4 border-y-transparent border-l-[7px] border-l-white ml-0.5" />
                    </div>
                  </div>
                </div>
              ) : (
                <img src={thumbSrc(img.src, 480)} alt="" className="w-full h-full object-cover" loading="lazy" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function GalleryPanel({
  colors, themeMode,
  history, filteredHistory, currentImage, selectFromHistory, clearHistory, historyRef,
  folders, currentFolderId, setCurrentFolderId,
  drawers, currentRefFilter, setCurrentRefFilter,
  showFolders, setShowFolders,
  newFolderName, setNewFolderName, createFolder, deleteFolder,
  viewingImage, setViewingImage, viewerZoom, setViewerZoom, viewerPan, setViewerPan,
  handleDownload, setCurrentImage, setViewMode, setPrompt,
  confirmDelete, setConfirmDelete, deleteFromHistory,
}: GalleryPanelProps) {
  const [showRefFilter, setShowRefFilter] = useState(false);
  const usedRefs = Array.from(new Set(history.flatMap(img => img.references || [])));
  if (history.length === 0) return null;

  return (
    <>
      {/* History strip */}
      <div className={cn("p-4 rounded-2xl border backdrop-blur-md flex-1", colors.panelBg, colors.panelBorder)}>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <label className={cn("text-xs font-medium uppercase tracking-wide", colors.textMuted)}>History ({history.length})</label>
            <button onClick={() => setShowFolders(!showFolders)} className={cn("p-1 rounded", showFolders ? "" : colors.textMuted)} style={showFolders ? { color: colors.accent } : undefined}>
              <Folder className="w-3.5 h-3.5" />
            </button>
            {usedRefs.length > 0 && (
              <button onClick={() => setShowRefFilter(!showRefFilter)} className={cn("p-1 rounded", showRefFilter ? "" : colors.textMuted)} style={showRefFilter ? { color: colors.accent } : undefined}>
                <Users className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <button onClick={clearHistory} className={cn("text-xs flex items-center gap-1", colors.textMuted)}>
            <Trash2 className="w-3 h-3" />Clear
          </button>
        </div>

        <AnimatePresence>
          {showFolders && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden mb-2">
              <div className={cn("p-3 rounded-lg border space-y-2", colors.panelBg, colors.panelBorder)}>
                <div className="flex gap-1.5 flex-wrap">
                  <button
                    onClick={() => setCurrentFolderId(null)}
                    className={cn("px-2 py-1 rounded text-xs border", !currentFolderId ? "border-current" : cn(colors.panelBorder, colors.textMuted))}
                    style={!currentFolderId ? { borderColor: colors.accent, color: colors.accent } : undefined}
                  >
                    All
                  </button>
                  {folders.map(f => (
                    <button
                      key={f.id}
                      onClick={() => setCurrentFolderId(f.id)}
                      className={cn("px-2 py-1 rounded text-xs border flex items-center gap-1", currentFolderId === f.id ? "border-current" : cn(colors.panelBorder, colors.textMuted))}
                      style={currentFolderId === f.id ? { borderColor: colors.accent, color: colors.accent } : undefined}
                    >
                      {f.name}
                      <X className="w-3 h-3 opacity-50 hover:opacity-100" onClick={(e) => { e.stopPropagation(); deleteFolder(f.id); }} />
                    </button>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    placeholder="New folder..."
                    className={cn("flex-1 px-2 py-1 rounded border text-xs", colors.panelBg, colors.panelBorder, colors.textMain)}
                    onKeyDown={(e) => e.key === 'Enter' && createFolder()}
                  />
                  <button
                    onClick={createFolder}
                    className="px-2 py-1 rounded text-xs"
                    style={{ backgroundColor: colors.accent, color: ACCENT_TEXT_COLOR_BY_THEME[themeMode] }}
                  >
                    <FolderPlus className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {showRefFilter && usedRefs.length > 0 && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden mb-2">
              <div className={cn("p-3 rounded-lg border", colors.panelBg, colors.panelBorder)}>
                <div className="flex gap-1.5 flex-wrap">
                  <button
                    onClick={() => setCurrentRefFilter(null)}
                    className={cn("px-2 py-1 rounded text-xs border", !currentRefFilter ? "border-current" : cn(colors.panelBorder, colors.textMuted))}
                    style={!currentRefFilter ? { borderColor: colors.accent, color: colors.accent } : undefined}
                  >
                    All refs
                  </button>
                  {usedRefs.map(slug => {
                    const drawer = drawers.find(d => d.slug === slug);
                    const label = drawer?.label || slug;
                    return (
                      <button
                        key={slug}
                        onClick={() => setCurrentRefFilter(slug)}
                        className={cn("px-2 py-1 rounded text-xs border", currentRefFilter === slug ? "border-current" : cn(colors.panelBorder, colors.textMuted))}
                        style={currentRefFilter === slug ? { borderColor: colors.accent, color: colors.accent } : undefined}
                      >
                        {drawer?.emoji ? `${drawer.emoji} ` : ''}{label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <VirtualizedHistoryStrip
          filteredHistory={filteredHistory}
          currentImage={currentImage}
          selectFromHistory={selectFromHistory}
          colors={colors}
        />
      </div>

      {/* Image Viewer Modal */}
      <AnimatePresence>
        {viewingImage && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-40 flex flex-col"
            onAnimationComplete={() => { setViewerZoom(1); setViewerPan({ x: 0, y: 0 }); }}
          >
            <div
              className="absolute inset-0 bg-black/90"
              onClick={() => {
                if (viewerZoom === 1) setViewingImage(null);
                else { setViewerZoom(1); setViewerPan({ x: 0, y: 0 }); }
              }}
            />
            <div className="relative flex-1 flex flex-col z-10">
              {/* Viewer header */}
              <div className="flex items-center justify-between p-4">
                <button onClick={() => setViewingImage(null)} className="p-1.5 rounded-full bg-white/10 text-white">
                  <X className="w-4 h-4" />
                </button>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => handleDownload(viewingImage)}
                    className="p-1.5 rounded-full"
                    style={{ backgroundColor: colors.accent, color: ACCENT_TEXT_COLOR_BY_THEME[themeMode] }}
                  >
                    <Download className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => { setCurrentImage(viewingImage); setViewMode('edit'); setViewingImage(null); }}
                    className="p-1.5 rounded-full"
                    style={{ backgroundColor: colors.accent, color: ACCENT_TEXT_COLOR_BY_THEME[themeMode] }}
                  >
                    <Edit3 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setConfirmDelete(viewingImage)}
                    className="p-1.5 rounded-full"
                    style={{ backgroundColor: colors.accent, color: ACCENT_TEXT_COLOR_BY_THEME[themeMode] }}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
              {/* Image with pinch-to-zoom and swipe navigation */}
              {(() => {
                const viewerIndex = history.findIndex(img => img.id === viewingImage.id);
                const canGoPrev = viewerIndex > 0;
                const canGoNext = viewerIndex < history.length - 1 && viewerIndex >= 0;
                const goToPrev = () => {
                  if (canGoPrev) { setViewingImage(history[viewerIndex - 1]); setViewerZoom(1); setViewerPan({ x: 0, y: 0 }); }
                };
                const goToNext = () => {
                  if (canGoNext) { setViewingImage(history[viewerIndex + 1]); setViewerZoom(1); setViewerPan({ x: 0, y: 0 }); }
                };
                return (
                  <div
                    className="flex-1 flex items-center justify-center p-4 overflow-hidden touch-none relative"
                    onTouchStart={(e) => {
                      if (e.touches.length === 2) {
                        const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
                        (e.currentTarget as any)._pinchStart = { dist, zoom: viewerZoom };
                      } else if (e.touches.length === 1) {
                        (e.currentTarget as any)._swipeStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
                        if (viewerZoom > 1) {
                          (e.currentTarget as any)._panStart = { x: e.touches[0].clientX - viewerPan.x, y: e.touches[0].clientY - viewerPan.y };
                        }
                      }
                    }}
                    onTouchMove={(e) => {
                      if (e.touches.length === 2 && (e.currentTarget as any)._pinchStart) {
                        const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
                        const scale = dist / (e.currentTarget as any)._pinchStart.dist;
                        const newZoom = Math.max(1, Math.min(5, (e.currentTarget as any)._pinchStart.zoom * scale));
                        setViewerZoom(newZoom);
                        if (newZoom === 1) setViewerPan({ x: 0, y: 0 });
                      } else if (e.touches.length === 1 && viewerZoom > 1 && (e.currentTarget as any)._panStart) {
                        setViewerPan({ x: e.touches[0].clientX - (e.currentTarget as any)._panStart.x, y: e.touches[0].clientY - (e.currentTarget as any)._panStart.y });
                      }
                    }}
                    onTouchEnd={(e) => {
                      if (viewerZoom <= 1) {
                        setViewerZoom(1); setViewerPan({ x: 0, y: 0 });
                        const start = (e.currentTarget as any)._swipeStart;
                        if (start && e.changedTouches.length === 1) {
                          const dx = e.changedTouches[0].clientX - start.x;
                          if (dx < -50) goToNext();
                          else if (dx > 50) goToPrev();
                        }
                      }
                      (e.currentTarget as any)._swipeStart = null;
                    }}
                    onDoubleClick={() => {
                      if (viewerZoom > 1) { setViewerZoom(1); setViewerPan({ x: 0, y: 0 }); }
                      else { setViewerZoom(2.5); }
                    }}
                  >
                    {canGoPrev && (
                      <button
                        onClick={goToPrev}
                        className="absolute left-2 top-1/2 -translate-y-1/2 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur hover:bg-black/60"
                      >
                        <ChevronLeft size={24} />
                      </button>
                    )}
                    {canGoNext && (
                      <button
                        onClick={goToNext}
                        className="absolute right-2 top-1/2 -translate-y-1/2 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur hover:bg-black/60"
                      >
                        <ChevronRight size={24} />
                      </button>
                    )}
                    {viewingImage.mediaType === 'video' ? (
                      <video
                        src={viewingImage.src}
                        className="max-w-full max-h-full object-contain rounded-lg"
                        controls loop playsInline autoPlay
                      />
                    ) : (
                      <img
                        src={viewingImage.src}
                        alt={viewingImage.prompt}
                        className="max-w-full max-h-full object-contain rounded-lg select-none"
                        style={{ transform: `scale(${viewerZoom}) translate(${viewerPan.x / viewerZoom}px, ${viewerPan.y / viewerZoom}px)`, transition: viewerZoom === 1 ? 'transform 0.2s' : 'none' }}
                        draggable={false}
                      />
                    )}
                  </div>
                );
              })()}
              {/* Info */}
              <div className="p-4 text-white">
                <div className="flex items-start gap-2">
                  <p className="text-sm flex-1">{viewingImage.prompt}</p>
                  {viewingImage.prompt && (
                    <button
                      onClick={() => {
                        const parts = [viewingImage.prompt];
                        parts.push(`\nModel: ${viewingImage.backend}/${viewingImage.model}`);
                        if (viewingImage.aspectRatio) parts.push(`Aspect: ${viewingImage.aspectRatio}`);
                        if (viewingImage.references?.length) parts.push(`References: ${viewingImage.references.join(', ')}`);
                        const text = parts.join('\n');
                        if (navigator.clipboard && window.isSecureContext) {
                          navigator.clipboard.writeText(text);
                        } else {
                          const ta = document.createElement('textarea');
                          ta.value = text;
                          ta.style.position = 'fixed';
                          ta.style.left = '-9999px';
                          document.body.appendChild(ta);
                          ta.select();
                          document.execCommand('copy');
                          document.body.removeChild(ta);
                        }
                      }}
                      className="p-1.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: colors.accent, color: ACCENT_TEXT_COLOR_BY_THEME[themeMode] }}
                      title="Copy prompt + settings"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <p className="text-xs opacity-60 uppercase tracking-wide mt-1">
                  {viewingImage.backend} · {viewingImage.model.split('/').pop()}
                  {viewingImage.aspectRatio && ` · ${viewingImage.aspectRatio}`}
                  {viewingImage.references?.length ? ` · refs: ${viewingImage.references.join(', ')}` : ''}
                </p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Delete Confirmation Modal */}
      <AnimatePresence>
        {confirmDelete && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 flex items-center justify-center p-6"
          >
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setConfirmDelete(null)} />
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className={cn("relative w-full max-w-xs rounded-2xl border p-6 space-y-4", colors.panelBg, colors.panelBorder)}
            >
              <h2 className={cn("text-lg font-semibold text-center", colors.textMain)}>Delete this image?</h2>
              <p className={cn("text-sm text-center", colors.textMuted)}>This cannot be undone.</p>
              <div className="flex gap-3">
                <button
                  onClick={() => setConfirmDelete(null)}
                  className={cn("flex-1 py-2.5 rounded-xl font-semibold text-sm border", colors.panelBorder, colors.textMain)}
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    deleteFromHistory(confirmDelete.id);
                    setConfirmDelete(null);
                    if (viewingImage?.id === confirmDelete.id) setViewingImage(null);
                  }}
                  className="flex-1 py-2.5 rounded-xl font-semibold text-sm"
                  style={{ backgroundColor: colors.accent, color: 'var(--bytelight-on-accent)' }}
                >
                  Delete
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
