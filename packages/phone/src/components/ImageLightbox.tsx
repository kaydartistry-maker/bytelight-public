import React, { useEffect, useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, ZoomIn, ZoomOut, RotateCcw, ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { saveToDevice } from '../lib/download';

interface ImageLightboxProps {
  src?: string;
  images?: string[];
  startIndex?: number;
  alt?: string;
  onClose: () => void;
}

// Fullscreen image viewer rendered via a portal. Supports pinch-to-zoom and
// pan gestures on touch devices, plus button controls. When multiple images
// are provided, supports swiping/clicking to navigate between them.
// Closes on backdrop click, the close button, or the Escape key.
export function ImageLightbox({ src, images, startIndex = 0, alt, onClose }: ImageLightboxProps) {
  // Build image array from either prop
  const allImages = images && images.length > 0 ? images : (src ? [src] : []);
  const [currentIndex, setCurrentIndex] = useState(Math.min(startIndex, allImages.length - 1));
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const lastTouchRef = useRef<{ x: number; y: number } | null>(null);
  const lastDistRef = useRef<number | null>(null);
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  /**
   * Keep the picture under her finger.
   *
   * Panning was unbounded, so dragging a zoomed image carried it off into the black
   * and she had to find her way back. The image should be the whole world: zoom in,
   * push to any edge, and stop there — never past the edge into empty space.
   *
   * At scale 1 the image is laid out to FIT, so there is nothing to pan and the
   * clamp is zero in both axes. Above that, the slack is half the overhang, because
   * the transform scales about the centre. offsetWidth/Height are the laid-out size
   * BEFORE the transform, which is exactly what the overhang is measured against.
   */
  const clampToImage = (pos: { x: number; y: number }, atScale: number) => {
    const el = imgRef.current;
    if (!el) return pos;
    const maxX = Math.max(0, (el.offsetWidth * atScale - el.offsetWidth) / 2);
    const maxY = Math.max(0, (el.offsetHeight * atScale - el.offsetHeight) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, pos.x)),
      y: Math.min(maxY, Math.max(-maxY, pos.y)),
    };
  };

  // Zooming back out has to pull it home too, or the picture stays parked off
  // to one side at a scale that can no longer reach there.
  useEffect(() => {
    setPosition((p) => clampToImage(p, scale));
  }, [scale]);

  const hasMultiple = allImages.length > 1;

  const goNext = useCallback(() => {
    if (currentIndex < allImages.length - 1) {
      setCurrentIndex(i => i + 1);
      setScale(1);
      setPosition({ x: 0, y: 0 });
    }
  }, [currentIndex, allImages.length]);

  const goPrev = useCallback(() => {
    if (currentIndex > 0) {
      setCurrentIndex(i => i - 1);
      setScale(1);
      setPosition({ x: 0, y: 0 });
    }
  }, [currentIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === '+' || e.key === '=') setScale((s) => Math.min(s * 1.2, 5));
      if (e.key === '-') setScale((s) => Math.max(s / 1.2, 1));
      if (e.key === '0') { setScale(1); setPosition({ x: 0, y: 0 }); }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') goNext();
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') goPrev();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose, goNext, goPrev]);

  const reset = () => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setScale((s) => Math.max(1, Math.min(5, s * delta)));
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      lastTouchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      swipeStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      setIsDragging(true);
    } else if (e.touches.length === 2) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      lastDistRef.current = dist;
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 1 && lastTouchRef.current && scale > 1) {
      const dx = e.touches[0].clientX - lastTouchRef.current.x;
      const dy = e.touches[0].clientY - lastTouchRef.current.y;
      setPosition((p) => ({ x: p.x + dx, y: p.y + dy }));
      lastTouchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else if (e.touches.length === 2 && lastDistRef.current !== null) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const delta = dist / lastDistRef.current;
      setScale((s) => Math.max(1, Math.min(5, s * delta)));
      lastDistRef.current = dist;
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    // Detect horizontal swipe when not zoomed
    if (swipeStartRef.current && scale === 1 && hasMultiple && e.changedTouches.length === 1) {
      const endX = e.changedTouches[0].clientX;
      const dx = endX - swipeStartRef.current.x;
      const threshold = 50; // minimum swipe distance
      if (dx < -threshold) goNext();
      else if (dx > threshold) goPrev();
    }
    lastTouchRef.current = null;
    lastDistRef.current = null;
    swipeStartRef.current = null;
    setIsDragging(false);
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === containerRef.current && scale === 1) {
      onClose();
    }
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={containerRef}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 p-4 touch-none"
      onClick={handleBackdropClick}
      onWheel={handleWheel}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      role="dialog"
      aria-label="Image preview"
    >
      {/* Controls */}
      <div className="absolute top-4 right-4 z-10 flex gap-2">
        {scale !== 1 && (
          <button
            onClick={(e) => { e.stopPropagation(); reset(); }}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur hover:bg-black/60"
            aria-label="Reset zoom"
          >
            <RotateCcw size={18} />
          </button>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); setScale((s) => Math.max(s / 1.3, 1)); }}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur hover:bg-black/60"
          aria-label="Zoom out"
        >
          <ZoomOut size={18} />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); setScale((s) => Math.min(s * 1.3, 5)); }}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur hover:bg-black/60"
          aria-label="Zoom in"
        >
          <ZoomIn size={18} />
        </button>
        {/* Saving a picture used to be a press-and-hold on the bubble, which
            is the least visible control there is — and attachments never had
            one wired at all. The viewer is where the picture is already big
            and being looked at, so the save says so out loud, in a button. */}
        <button
          onClick={(e) => { e.stopPropagation(); saveToDevice(allImages[currentIndex]); }}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur hover:bg-black/60"
          aria-label="Save image"
          title="Save image"
        >
          <Download size={18} />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur hover:bg-black/60"
          aria-label="Close"
        >
          <X size={20} />
        </button>
      </div>

      {/* Navigation arrows for multiple images */}
      {hasMultiple && currentIndex > 0 && (
        <button
          onClick={(e) => { e.stopPropagation(); goPrev(); }}
          className="absolute left-4 top-1/2 -translate-y-1/2 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur hover:bg-black/60"
          aria-label="Previous image"
        >
          <ChevronLeft size={24} />
        </button>
      )}
      {hasMultiple && currentIndex < allImages.length - 1 && (
        <button
          onClick={(e) => { e.stopPropagation(); goNext(); }}
          className="absolute right-4 top-1/2 -translate-y-1/2 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur hover:bg-black/60"
          aria-label="Next image"
        >
          <ChevronRight size={24} />
        </button>
      )}

      {/* Zoom indicator */}
      {scale !== 1 && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-3 py-1 text-sm text-white backdrop-blur">
          {Math.round(scale * 100)}%
        </div>
      )}

      <img
        src={allImages[currentIndex]}
        alt={alt || ''}
        ref={imgRef}
        className="max-h-full max-w-full object-contain select-none"
        style={{
          transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
          transition: isDragging ? 'none' : 'transform 0.1s ease-out',
          cursor: scale > 1 ? 'grab' : 'default',
        }}
        onClick={(e) => e.stopPropagation()}
        draggable={false}
        referrerPolicy="no-referrer"
      />
    </div>,
    document.body,
  );
}
