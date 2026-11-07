// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The win cascade.
//
// The one from Windows Solitaire: cards launch off the foundations one after
// another, fall, bounce off the bottom edge and ricochet across the screen,
// each leaving a trail of itself behind until the board is buried.
//
// Canvas rather than DOM, because the trail IS the effect — every frame paints
// the card at its new position and nothing ever clears what came before. Fifty-
// two elements each leaving a few hundred copies would be tens of thousands of
// nodes; here it is one surface and a handful of moving rectangles.
import { useEffect, useRef } from 'react';

interface Flier {
  img: HTMLImageElement;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const GRAVITY = 0.32;
const BOUNCE = 0.82;
/** how often a new card leaves the foundation, in frames */
const LAUNCH_EVERY = 14;

export function CardCascade({ order, onDone }: { order: string[]; onDone?: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || order.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    const cardW = Math.max(44, Math.round(width / 8));
    const cardH = Math.round(cardW * 1.5);

    // Load every face first. A card that has not decoded yet would launch as a
    // blank and leave a trail of nothing, which is worse than launching late.
    const images = order.map((card) => {
      const img = new Image();
      img.src = `/api/games/cards/art/${card}`;
      return img;
    });

    const fliers: Flier[] = [];
    let frame = 0;
    let launched = 0;
    let raf = 0;
    let stopped = false;

    const tick = () => {
      if (stopped) return;
      frame += 1;

      if (launched < images.length && frame % LAUNCH_EVERY === 0) {
        const img = images[launched];
        launched += 1;
        // Cards come off the foundation row, top right-ish, thrown sideways.
        fliers.push({
          img,
          x: width * (0.55 + 0.1 * ((launched % 4) / 4)),
          y: height * 0.12,
          vx: (Math.random() > 0.5 ? 1 : -1) * (2.2 + Math.random() * 3.4),
          vy: -(1 + Math.random() * 2),
        });
      }

      for (const f of fliers) {
        f.vy += GRAVITY;
        f.x += f.vx;
        f.y += f.vy;
        if (f.y + cardH > height) {
          f.y = height - cardH;
          f.vy = -Math.abs(f.vy) * BOUNCE;
          // a card that has stopped bouncing gets one last shove sideways so it
          // walks off the edge instead of shivering in place
          if (Math.abs(f.vy) < 2.2) f.vy = -(2.2 + Math.random());
        }
        if (f.img.complete && f.img.naturalWidth > 0) {
          ctx.drawImage(f.img, f.x, f.y, cardW, cardH);
        }
      }

      // Everything has walked off the sides and the last card has launched.
      const gone = fliers.length > 0 && fliers.every((f) => f.x < -cardW * 2 || f.x > width + cardW * 2);
      if (launched >= images.length && gone) {
        onDone?.();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, [order, onDone]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 z-40 h-full w-full"
    />
  );
}
