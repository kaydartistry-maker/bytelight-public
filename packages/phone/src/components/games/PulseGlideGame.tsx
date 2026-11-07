// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { RotateCcw } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useKeyPress } from './gameKeys';

interface Pipe {
  x: number;
  gapTop: number;
  gapBottom: number;
  passed: boolean;
}

export function PulseGlideGame({ colors, rawColors, onExit }: { colors: any, rawColors: any, onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [score, setScore] = useState(0);
  const [gameOver, setGameOver] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const requestRef = useRef<number>(0);

  const [highScore, setHighScore] = useState(() => {
    const saved = localStorage.getItem('signal_glide_high_score');
    return saved ? parseInt(saved, 10) : 0;
  });
  const highScoreRef = useRef(highScore);

  const GRAVITY = 0.15;
  const JUMP = -4;
  const PIPE_SPEED = 2;
  const PIPE_WIDTH = 10;
  const GAP_SIZE = 140;
  const SPAWN_RATE = 120; // frames

  const state = useRef({
    dot: { y: 200, velocity: 0, radius: 6 },
    pipes: [] as Pipe[],
    frameCount: 0,
    score: 0,
    isGameOver: false
  });

  const initGame = () => {
    state.current = {
      dot: { y: 200, velocity: 0, radius: 6 },
      pipes: [],
      frameCount: 0,
      score: 0,
      isGameOver: false
    };
    setScore(0);
    setGameOver(false);
    setIsPlaying(true);
  };

  const jump = () => {
    if (state.current.isGameOver) return;
    if (!isPlaying) initGame();
    state.current.dot.velocity = JUMP;
  };

  // Keyboard equivalent of tapping the field: boost while flying, retransmit
  // once you're down.
  useKeyPress(true, [' ', 'ArrowUp', 'Enter'], () => {
    if (gameOver) initGame();
    else jump();
  });

  const updatePhysics = () => {
    const s = state.current;
    if (s.isGameOver) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    // Apply gravity
    s.dot.velocity += GRAVITY;
    s.dot.y += s.dot.velocity;

    // Floor/Ceiling collision
    if (s.dot.y + s.dot.radius > canvas.height || s.dot.y - s.dot.radius < 0) {
      s.isGameOver = true;
      setGameOver(true);
      setIsPlaying(false);
      return;
    }

    // Spawn pipes
    s.frameCount++;
    if (s.frameCount % SPAWN_RATE === 0) {
      const minHeight = 50;
      const maxHeight = canvas.height - GAP_SIZE - minHeight;
      const gapTop = Math.random() * (maxHeight - minHeight) + minHeight;
      s.pipes.push({
        x: canvas.width,
        gapTop: gapTop,
        gapBottom: gapTop + GAP_SIZE,
        passed: false
      });
    }

    // Move pipes and check collisions
    for (let i = s.pipes.length - 1; i >= 0; i--) {
      const p = s.pipes[i];
      p.x -= PIPE_SPEED;

      // Collision
      const dotLeft = 50 - s.dot.radius; // Dot is fixed at x=50
      const dotRight = 50 + s.dot.radius;
      const dotTop = s.dot.y - s.dot.radius;
      const dotBottom = s.dot.y + s.dot.radius;

      if (dotRight > p.x && dotLeft < p.x + PIPE_WIDTH) {
        if (dotTop < p.gapTop || dotBottom > p.gapBottom) {
          s.isGameOver = true;
          setGameOver(true);
          setIsPlaying(false);
          return;
        }
      }

      // Score
      if (!p.passed && p.x + PIPE_WIDTH < 50) {
        p.passed = true;
        s.score++;
        setScore(s.score);
        if (s.score > highScoreRef.current) {
          highScoreRef.current = s.score;
          setHighScore(s.score);
          localStorage.setItem('signal_glide_high_score', s.score.toString());
        }
      }

      // Remove off-screen pipes
      if (p.x + PIPE_WIDTH < 0) {
        s.pipes.splice(i, 1);
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

    // Draw Pipes (Interference)
    ctx.fillStyle = rawColors.panelBorder;
    s.pipes.forEach(p => {
      // Top spike
      ctx.beginPath();
      ctx.moveTo(p.x, 0);
      ctx.lineTo(p.x + PIPE_WIDTH, 0);
      ctx.lineTo(p.x + PIPE_WIDTH / 2, p.gapTop);
      ctx.closePath();
      ctx.fill();

      // Bottom spike
      ctx.beginPath();
      ctx.moveTo(p.x, canvas.height);
      ctx.lineTo(p.x + PIPE_WIDTH, canvas.height);
      ctx.lineTo(p.x + PIPE_WIDTH / 2, p.gapBottom);
      ctx.closePath();
      ctx.fill();
    });

    // Draw Dot (Signal)
    ctx.fillStyle = rawColors.accent;
    ctx.save();
    ctx.translate(50, s.dot.y);
    // Rotate based on velocity
    const angle = Math.min(Math.PI / 4, Math.max(-Math.PI / 4, s.dot.velocity * 0.15));
    ctx.rotate(angle);
    
    ctx.beginPath();
    ctx.moveTo(12, 0); // Right point
    ctx.lineTo(0, 6);  // Bottom point
    ctx.lineTo(-12, 0); // Left point
    ctx.lineTo(0, -6); // Top point
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Draw trail (optional visual flair)
    ctx.fillStyle = `${rawColors.accent}40`;
    ctx.beginPath();
    ctx.arc(50 - 12, s.dot.y - s.dot.velocity, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(50 - 18, s.dot.y - s.dot.velocity * 1.5, 1.5, 0, Math.PI * 2);
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

  // Initial draw
  useEffect(() => {
    if (!isPlaying && !gameOver) {
      draw();
    }
  }, []);

  return (
    <div className="flex flex-col h-full items-center justify-center p-4">
      <div className="w-full max-w-[340px] flex justify-between items-end mb-4 rounded-2xl border px-4 py-3 backdrop-blur-md" style={{ backgroundColor: rawColors.panelBg, borderColor: rawColors.panelBorder }}>
        <div className="flex-1">
          <div className="text-[10px] uppercase tracking-widest opacity-60">Distance</div>
          <div className="text-xl font-light leading-none mt-1">{score}</div>
        </div>
        <div className="flex-1 text-center">
          <div className="text-[10px] uppercase tracking-widest opacity-60">Best</div>
          <div className="text-xl font-light leading-none mt-1">{highScore}</div>
        </div>
        <div className="flex-1 text-right">
          <div className="text-[10px] uppercase tracking-widest opacity-60">Status</div>
          <div className="text-xl font-light leading-none mt-1 opacity-80">{gameOver ? 'Offline' : isPlaying ? 'Active' : 'Standby'}</div>
        </div>
      </div>

      <div 
        className="relative w-full max-w-[340px] aspect-[3/4] rounded-2xl overflow-hidden border cursor-pointer" 
        style={{ backgroundColor: rawColors.panelBg, borderColor: rawColors.panelBorder }}
        onPointerDown={jump}
      >
        <canvas
          ref={canvasRef}
          width={340}
          height={453}
          className="w-full h-full touch-none"
        />
        
        {!isPlaying && !gameOver && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/20 backdrop-blur-sm pointer-events-none">
            <div className="text-center">
              <div className="text-xl font-light mb-2">Signal Glide</div>
              <div className="text-xs opacity-60 uppercase tracking-widest">Tap to Boost</div>
            </div>
          </div>
        )}
      </div>

      <div className="h-12 mt-6">
        {gameOver && (
          <motion.button 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            onClick={initGame}
            className={cn("px-6 py-3 rounded-[var(--shape-control)] font-medium text-sm flex items-center gap-2 hover:scale-105 transition-transform", "text-white")}
            style={{ backgroundColor: rawColors.accent, color: rawColors.accentText }}
          >
            <RotateCcw size={16} /> Retransmit
          </motion.button>
        )}
      </div>
    </div>
  );
}
