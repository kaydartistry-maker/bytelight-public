import { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils';

/**
 * An image you can zoom into, that will not let you lose it.
 *
 * Studio's full-screen viewer was a plain img — pinching did nothing. The messages
 * lightbox kept its zoom, so the feature existed and simply was not here. This is
 * that behaviour as its own piece, small enough to drop into a viewer that already
 * has chrome of its own (Studio keeps its prompt panel and its buttons).
 *
 * THE PART THAT MATTERS, and it is her spec: PANNING IS BOUNDED BY THE PICTURE.
 * You can push to any edge and stop there. Dragging never carries the image off into
 * empty space and leaves you hunting for it.
 *
 * At scale 1 the image is laid out to fit, so there is no slack and the clamp is
 * zero in both axes. Above that the slack is half the overhang, because the
 * transform scales about the centre — and offsetWidth/Height are the laid-out size
 * BEFORE the transform, which is what the overhang is measured against.
 */
const MIN_SCALE = 1;
const MAX_SCALE = 5;

export function ZoomableImage({
  src,
  alt,
  className,
}: {
  src: string;
  alt?: string;
  className?: string;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const lastDistRef = useRef<number | null>(null);
  const lastTapRef = useRef(0);
  // A double TAP makes the browser fire our touch handler AND a synthesized
  // dblclick. Both toggled the zoom, so it went in and straight back out — which
  // is exactly what a tap-to-zoom looked like from the outside.
  const lastTouchAtRef = useRef(0);

  const clamp = (pos: { x: number; y: number }, atScale: number) => {
    const el = imgRef.current;
    if (!el) return pos;
    const maxX = Math.max(0, (el.offsetWidth * atScale - el.offsetWidth) / 2);
    const maxY = Math.max(0, (el.offsetHeight * atScale - el.offsetHeight) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, pos.x)),
      y: Math.min(maxY, Math.max(-maxY, pos.y)),
    };
  };

  // Zooming out has to pull it home, or it stays parked off to one side at a scale
  // that can no longer reach there.
  useEffect(() => { setPosition((p) => clamp(p, scale)); }, [scale]);

  // A new picture starts where every picture starts.
  useEffect(() => { setScale(1); setPosition({ x: 0, y: 0 }); }, [src]);

  const zoomTo = (next: number) => setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, next)));
  // Pinch reads the LIVE scale rather than the one captured when the handler was
  // made, so two moves in the same frame compose instead of fighting each other.
  const zoomBy = (ratio: number) =>
    setScale((s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * ratio)));

  // One toggle, used by both the tap and the double-click, so the two paths cannot
  // drift apart or land on different scales.
  const toggleZoom = () => {
    if (scale > 1) { setScale(1); setPosition({ x: 0, y: 0 }); } else zoomTo(2.5);
  };

  return (
    <img
      ref={imgRef}
      src={src}
      alt={alt || ''}
      draggable={false}
      className={cn('max-h-full max-w-full select-none object-contain', className)}
      style={{
        transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
        transition: dragging ? 'none' : 'transform 0.12s ease-out',
        cursor: scale > 1 ? (dragging ? 'grabbing' : 'grab') : 'zoom-in',
        touchAction: 'none',
      }}
      onWheel={(e) => { e.preventDefault(); zoomTo(scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)); }}
      onDoubleClick={() => {
        // Ignore the dblclick the browser synthesizes from a double tap — the touch
        // handler has already toggled, and running both is a zoom that undoes itself.
        if (Date.now() - lastTouchAtRef.current < 700) return;
        toggleZoom();
      }}
      onPointerDown={(e) => {
        if (e.pointerType === 'touch') return; // touch is handled by the touch events
        if (scale <= 1) return;
        setDragging(true);
        lastPointRef.current = { x: e.clientX, y: e.clientY };
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!dragging || !lastPointRef.current) return;
        const dx = e.clientX - lastPointRef.current.x;
        const dy = e.clientY - lastPointRef.current.y;
        lastPointRef.current = { x: e.clientX, y: e.clientY };
        setPosition((p) => clamp({ x: p.x + dx, y: p.y + dy }, scale));
      }}
      onPointerUp={() => { setDragging(false); lastPointRef.current = null; }}
      onTouchStart={(e) => {
        lastTouchAtRef.current = Date.now();
        if (e.touches.length === 1) {
          lastPointRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
          // Double tap to zoom, the way every photo viewer does it.
          const now = Date.now();
          if (now - lastTapRef.current < 300) {
            toggleZoom();
            lastTapRef.current = 0; // three taps is not one and a half toggles
          } else {
            lastTapRef.current = now;
          }
        } else if (e.touches.length === 2) {
          // The first finger of a pinch already came through as a single touch. Left
          // seeded, a second pinch inside 300ms reads as a double tap and undoes itself.
          lastTapRef.current = 0;
          lastDistRef.current = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY,
          );
        }
      }}
      onTouchMove={(e) => {
        if (e.touches.length === 1 && lastPointRef.current && scale > 1) {
          const dx = e.touches[0].clientX - lastPointRef.current.x;
          const dy = e.touches[0].clientY - lastPointRef.current.y;
          lastPointRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
          setPosition((p) => clamp({ x: p.x + dx, y: p.y + dy }, scale));
        } else if (e.touches.length === 2 && lastDistRef.current !== null) {
          const dist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY,
          );
          zoomBy(dist / lastDistRef.current);
          lastDistRef.current = dist;
        }
      }}
      onTouchEnd={() => {
        lastTouchAtRef.current = Date.now();
        lastPointRef.current = null;
        lastDistRef.current = null;
      }}
    />
  );
}
