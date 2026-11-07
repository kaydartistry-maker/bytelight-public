import { ChevronRight, Images } from 'lucide-react';
import { cn } from '../../lib/utils';
import { thumbSrc } from '../../lib/thumb';
import type { ThemeColors } from '../../lib/theme';
import type { GeneratedImage } from './types';

interface RecentGalleryRailProps {
  colors: ThemeColors;
  images: GeneratedImage[];
  currentImage: GeneratedImage | null;
  onSelect: (image: GeneratedImage) => void;
  onOpenGallery: () => void;
}

export function RecentGalleryRail({
  colors,
  images,
  currentImage,
  onSelect,
  onOpenGallery,
}: RecentGalleryRailProps) {
  return (
    <section className={cn('rounded-2xl border p-4 backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Images className="h-4 w-4" style={{ color: colors.accent }} />
          <div>
            <p className={cn('text-xs font-semibold uppercase tracking-[0.16em]', colors.textMain)}>Recent</p>
            <p className={cn('text-[10px]', colors.textMuted)}>Newest {Math.min(images.length, 30)} creations</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onOpenGallery}
          className={cn('flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium', colors.textMuted)}
        >
          Gallery <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
      {images.length === 0 ? (
        <button
          type="button"
          onClick={onOpenGallery}
          className={cn('w-full rounded-xl border border-dashed py-5 text-xs', colors.panelBorder, colors.textMuted)}
        >
          Gallery is waiting for its first creation
        </button>
      ) : (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {images.slice(0, 30).map((image) => {
            const selected = currentImage?.id === image.id;
            return (
              <button
                type="button"
                key={image.id}
                onClick={() => onSelect(image)}
                className={cn(
                  'h-16 w-16 shrink-0 overflow-hidden rounded-xl border-2 transition-opacity',
                  selected ? 'opacity-100' : 'border-transparent opacity-70',
                )}
                style={selected ? { borderColor: colors.accent } : undefined}
                aria-label={`Open recent creation ${image.prompt || image.id}`}
              >
                {image.mediaType === 'video' ? (
                  <video src={image.src} className="h-full w-full object-cover" muted playsInline preload="metadata" />
                ) : (
                  <img src={thumbSrc(image.src, 256)} alt="" className="h-full w-full object-cover" loading="lazy" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
