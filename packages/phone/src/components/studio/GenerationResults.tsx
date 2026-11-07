import { Download, Image as ImageIcon, Edit3, Copy, Maximize2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { GenerationResultsProps } from './types';
import { ACCENT_TEXT_COLOR_BY_THEME } from './constants';

export function GenerationResults({
  colors, themeMode,
  currentImage,
  setViewMode,
  setViewingImage,
  handleDownload,
  setPrompt,
}: GenerationResultsProps) {
  return (
    <div className={cn("rounded-xl border overflow-hidden min-h-[200px] flex items-center justify-center backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
      {currentImage ? (
        <div className="relative w-full">
          {currentImage.mediaType === 'video' ? (
            <video src={currentImage.src} className="w-full h-auto" controls loop playsInline autoPlay muted />
          ) : (
            <img src={currentImage.src} alt={currentImage.prompt} className="w-full h-auto" />
          )}
          <div className="absolute top-2 right-2 flex gap-1.5">
            {currentImage.mediaType !== 'video' && (
              <button
                onClick={() => setViewingImage(currentImage)}
                className="p-1.5 rounded-full transition-colors"
                style={{ backgroundColor: colors.accent, color: ACCENT_TEXT_COLOR_BY_THEME[themeMode] }}
                title="Fullscreen"
              >
                <Maximize2 className="w-4 h-4" />
              </button>
            )}
            {currentImage.mediaType !== 'video' && (
              <button
                onClick={() => setViewMode('edit')}
                className="p-1.5 rounded-full transition-colors"
                style={{ backgroundColor: colors.accent, color: ACCENT_TEXT_COLOR_BY_THEME[themeMode] }}
                title="Edit"
              >
                <Edit3 className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={() => handleDownload(currentImage)}
              className="p-1.5 rounded-full transition-colors"
              style={{ backgroundColor: colors.accent, color: ACCENT_TEXT_COLOR_BY_THEME[themeMode] }}
              title="Download"
            >
              <Download className="w-4 h-4" />
            </button>
            <button
              onClick={() => setPrompt(currentImage.prompt || '')}
              className="p-1.5 rounded-full transition-colors"
              style={{ backgroundColor: colors.accent, color: ACCENT_TEXT_COLOR_BY_THEME[themeMode] }}
              title="Reuse prompt"
            >
              <Copy className="w-4 h-4" />
            </button>
          </div>
          <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/70 to-transparent">
            <p className="text-white text-xs truncate">{currentImage.prompt}</p>
            <p className="text-white/60 text-[10px] uppercase tracking-wide">{currentImage.backend} · {currentImage.model.split('/').pop()}</p>
          </div>
        </div>
      ) : (
        <div className={cn("text-center py-12", colors.textMuted)}>
          <ImageIcon className="w-12 h-12 mx-auto mb-2 opacity-30" />
          <p className="text-sm">Your creation will appear here</p>
        </div>
      )}
    </div>
  );
}
