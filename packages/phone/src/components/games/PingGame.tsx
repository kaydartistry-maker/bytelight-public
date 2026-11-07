// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { RotateCcw } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useHeldKeys, useKeyPress } from './gameKeys';

export function PingGame({ colors, rawColors, onExit }: { colors: any, rawColors: any, onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [score, setScore] = useState(0);
  const [gameOver, setGameOver] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const requestRef = useRef<number>(0);
  
  const [bestScore, setBestScore] = useState(() => {
    const saved = localStorage.getItem('radar_ping_best');
    return saved ? parseInt(saved) : 0;
  });
  const bestScoreRef = useRef(bestScore);

  // Game state refs to avoid dependency issues in animation loop
  const state = useRef({
    ball: { x: 170, y: 255, dx: 3, dy: -3, radius: 6 },
    paddle: { x: 130, y: 470, width: 80, height: 10 },
    score: 0,
    isGameOver: false
  });

  const initGame = () => {
    state.current = {
      ball: { x: 170, y: 255, dx: 3 * (Math.random() > 0.5 ? 1 : -1), dy: -3, radius: 6 },
      paddle: { x: 130, y: 470, width: 80, height: 10 },
      score: 0,
      isGameOver: false
    };
    setScore(0);
    setGameOver(false);
    setIsPlaying(true);
  };

  const updatePhysics = () => {
    const s = state.current;
    if (s.isGameOver) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    // Move ball
    s.ball.x += s.ball.dx;
    s.ball.y += s.ball.dy;

    // Wall collisions (left/right)
    if (s.ball.x + s.ball.radius > canvas.width || s.ball.x - s.ball.radius < 0) {
      s.ball.dx *= -1;
      s.ball.x = Math.max(s.ball.radius, Math.min(s.ball.x, canvas.width - s.ball.radius));
    }

    // Top collision
    if (s.ball.y - s.ball.radius < 0) {
      s.ball.dy *= -1;
      s.ball.y = s.ball.radius;
    }

    // Paddle collision
    if (
      s.ball.y + s.ball.radius > s.paddle.y &&
      s.ball.y - s.ball.radius < s.paddle.y + s.paddle.height &&
      s.ball.x > s.paddle.x &&
      s.ball.x < s.paddle.x + s.paddle.width
    ) {
      s.ball.dy = -Math.abs(s.ball.dy) - 0.2; // Speed up slightly
      s.ball.y = s.paddle.y - s.ball.radius;
      
      // Add english based on where it hit the paddle
      const hitPoint = (s.ball.x - (s.paddle.x + s.paddle.width / 2)) / (s.paddle.width / 2);
      s.ball.dx = hitPoint * 4;
      
      s.score += 1;
      setScore(s.score);
    }

    // Bottom collision (Game Over)
    if (s.ball.y + s.ball.radius > canvas.height) {
      s.isGameOver = true;
      setGameOver(true);
      setIsPlaying(false);
      
      if (s.score > bestScoreRef.current) {
        setBestScore(s.score);
        bestScoreRef.current = s.score;
        localStorage.setItem('radar_ping_best', s.score.toString());
      }
    }
  };

  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const s = state.current;

    // Clear
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw Paddle
    ctx.fillStyle = colors.accent;
    ctx.beginPath();
    ctx.roundRect(s.paddle.x, s.paddle.y, s.paddle.width, s.paddle.height, 5);
    ctx.fill();

    // Draw Ball
    ctx.fillStyle = colors.textMain;
    ctx.beginPath();
    ctx.arc(s.ball.x, s.ball.y, s.ball.radius, 0, Math.PI * 2);
    ctx.fill();
  };

  const loop = () => {
    if (state.current.isGameOver) return;
    updatePhysics();
    draw();
    requestRef.current = requestAnimationFrame(loop);
  };

  useEffect(() => {
    if (isPlaying) {
      requestRef.current = requestAnimationFrame(loop);
    }
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [isPlaying]);

  // Handle pointer movement for paddle
  const handlePointerMove = (e: React.PointerEvent<HTMLElement>) => {
    if (!isPlaying || gameOver) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const x = (e.clientX - rect.left) * scaleX;

    const s = state.current;
    s.paddle.x = Math.max(0, Math.min(x - s.paddle.width / 2, canvas.width - s.paddle.width));
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (!isPlaying || gameOver) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    handlePointerMove(e);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLElement>) => {
    if (!isPlaying || gameOver) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Ignore if pointer capture was already released or invalid
    }
  };

  // Keyboard equivalent of dragging the paddle. Arrows or A/D steer; Enter or
  // Space starts a round the way the button does.
  useHeldKeys(isPlaying && !gameOver, ['ArrowLeft', 'ArrowRight', 'a', 'd', 'A', 'D'], (held) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const s = state.current;
    const step = canvas.width * 0.02;
    let dx = 0;
    if (held.has('ArrowLeft') || held.has('a') || held.has('A')) dx -= step;
    if (held.has('ArrowRight') || held.has('d') || held.has('D')) dx += step;
    s.paddle.x = Math.max(0, Math.min(s.paddle.x + dx, canvas.width - s.paddle.width));
  });

  useKeyPress(!isPlaying || gameOver, [' ', 'Enter'], initGame);

  // Initial draw
  useEffect(() => {
    if (!isPlaying && !gameOver) {
      draw();
    }
  }, []);

  return (
    <div className="flex flex-col h-full items-center p-4">
      <div className="w-full max-w-[420px] flex justify-between items-end mb-4 rounded-2xl border px-4 py-3 backdrop-blur-md shrink-0" style={{ backgroundColor: rawColors.panelBg, borderColor: rawColors.panelBorder }}>
        <div className="flex-1">
          <div className="text-[10px] uppercase tracking-widest opacity-60">Packets</div>
          <div className="text-xl font-light leading-none mt-1">{score}</div>
        </div>
        <div className="flex-1 text-center">
          <div className="text-[10px] uppercase tracking-widest opacity-60">Peak Rate</div>
          <div className="text-xl font-light leading-none mt-1">{bestScore}</div>
        </div>
        <div className="flex-1 text-right">
          <div className="text-[10px] uppercase tracking-widest opacity-60">Status</div>
          <div className="text-xl font-light leading-none mt-1 opacity-80">{gameOver ? 'Dropped' : isPlaying ? 'Active' : 'Standby'}</div>
        </div>
      </div>

      <div className="flex-1 min-h-0 w-full flex justify-center">
        <div className="relative h-full aspect-[2/3] max-w-full rounded-2xl overflow-hidden border" style={{ backgroundColor: rawColors.panelBg, borderColor: rawColors.panelBorder }}>
          <canvas
            ref={canvasRef}
            width={340}
            height={510}
            className="w-full h-full touch-none"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
          />

          {!isPlaying && !gameOver && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/20 backdrop-blur-sm">
              <button
                onClick={initGame}
                className={cn("px-6 py-3 rounded-[var(--shape-control)] font-medium text-sm hover:scale-105 transition-transform", "text-white")}
                style={{ backgroundColor: rawColors.accent, color: rawColors.accentText }}
              >
                Start Ping
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="h-16 w-full max-w-[420px] mt-4 relative shrink-0">
        {isPlaying ? (
          <div
            className="absolute inset-0 rounded-2xl border-2 border-dashed flex items-center justify-center touch-none cursor-ew-resize backdrop-blur-md"
            style={{ borderColor: `${rawColors.accent}80`, backgroundColor: rawColors.panelBg, backgroundImage: `linear-gradient(0deg, ${rawColors.accent}1a, ${rawColors.accent}1a)` }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
          >
            <div className="text-[10px] tracking-widest uppercase font-medium" style={{ color: rawColors.textMain }}>
              Slide to Control
            </div>
          </div>
        ) : gameOver ? (
          <div className="flex h-full items-center justify-center">
            <motion.button
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              onClick={initGame}
              className={cn("px-6 py-3 rounded-[var(--shape-control)] font-medium text-sm flex items-center gap-2 hover:scale-105 transition-transform", "text-white")}
              style={{ backgroundColor: rawColors.accent, color: rawColors.accentText }}
            >
              <RotateCcw size={16} /> Reconnect
            </motion.button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
