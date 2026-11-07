// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { RotateCcw, ChevronLeft, ChevronRight, ArrowUp } from 'lucide-react';
import { cn } from '../../lib/utils';

export function SignalLandingGame({ colors, rawColors, onExit }: { colors: any, rawColors: any, onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [score, setScore] = useState(0);
  const [gameOver, setGameOver] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [message, setMessage] = useState('');
  const requestRef = useRef<number>(0);
  
  const [bestScore, setBestScore] = useState(() => {
    const saved = localStorage.getItem('signal_landing_best');
    return saved ? parseInt(saved) : 0;
  });
  const bestScoreRef = useRef(bestScore);

  const GRAVITY = 0.025;
  const THRUST = -0.06;
  const SIDE_THRUST = 0.03;
  const MAX_LANDING_SPEED = 1.5;

  const state = useRef({
    lander: { x: 170, y: 50, dx: 0, dy: 0, width: 16, height: 16, fuel: 300, tilt: 0 },
    terrain: [] as {x: number, y: number}[],
    pad: { x: 0, width: 40, y: 0 },
    isThrusting: false,
    isThrustingLeft: false,
    isThrustingRight: false,
    score: 0,
    level: 1,
    isGameOver: false,
    hasLanded: false
  });

  const generateTerrain = (level: number) => {
    const points = [];
    const padWidth = Math.max(20, 60 - level * 5);
    const padX = Math.random() * (340 - padWidth - 40) + 20;
    const padY = 400 - Math.random() * 50;

    points.push({ x: 0, y: 350 + Math.random() * 50 });
    
    // Left of pad
    for (let x = 30; x < padX; x += 30) {
      points.push({ x, y: 350 + Math.random() * 80 });
    }
    
    // Pad
    points.push({ x: padX, y: padY });
    points.push({ x: padX + padWidth, y: padY });
    
    // Right of pad
    for (let x = padX + padWidth + 30; x < 340; x += 30) {
      points.push({ x, y: 350 + Math.random() * 80 });
    }
    
    points.push({ x: 340, y: 350 + Math.random() * 50 });
    
    state.current.pad = { x: padX, width: padWidth, y: padY };
    state.current.terrain = points;
  };

  const initGame = (keepScore = false) => {
    const s = state.current;
    s.lander = { 
      x: 170 + (Math.random() * 100 - 50), 
      y: 50, 
      dx: (Math.random() - 0.5) * 0.5, 
      dy: 0, 
      width: 16, 
      height: 16, 
      fuel: Math.max(100, 300 - s.level * 15),
      tilt: 0
    };
    if (!keepScore) {
      s.score = 0;
      s.level = 1;
      setScore(0);
    }
    s.isGameOver = false;
    s.hasLanded = false;
    s.isThrusting = false;
    s.isThrustingLeft = false;
    s.isThrustingRight = false;
    generateTerrain(s.level);
    
    setMessage('');
    setGameOver(false);
    setIsPlaying(true);
  };

  // Line intersection helper
  const lineIntersect = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, x4: number, y4: number) => {
    const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (den === 0) return false;
    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
    const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / den;
    return t > 0 && t < 1 && u > 0 && u < 1;
  };

  const checkCollision = () => {
    const s = state.current;
    const l = s.lander;
    const t = s.terrain;
    
    // Lander bounding box lines (Triangle)
    const landerLines = [
      [l.x, l.y - l.height/2, l.x + l.width/2, l.y + l.height/2], // Right side
      [l.x + l.width/2, l.y + l.height/2, l.x - l.width/2, l.y + l.height/2], // Bottom side
      [l.x - l.width/2, l.y + l.height/2, l.x, l.y - l.height/2]  // Left side
    ];

    for (let i = 0; i < t.length - 1; i++) {
      const p1 = t[i];
      const p2 = t[i+1];
      
      for (const line of landerLines) {
        if (lineIntersect(line[0], line[1], line[2], line[3], p1.x, p1.y, p2.x, p2.y)) {
          return true;
        }
      }
    }
    return false;
  };

  const updatePhysics = () => {
    const s = state.current;
    if (s.isGameOver || s.hasLanded) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    // Apply gravity
    s.lander.dy += GRAVITY;

    // Apply thrust
    let targetTilt = 0;
    if (s.isThrusting && s.lander.fuel > 0) {
      s.lander.dy += THRUST;
      s.lander.fuel -= 0.2;
    }
    if (s.isThrustingLeft && s.lander.fuel > 0) {
      s.lander.dx -= SIDE_THRUST;
      s.lander.fuel -= 0.1;
      targetTilt = -0.3;
    }
    if (s.isThrustingRight && s.lander.fuel > 0) {
      s.lander.dx += SIDE_THRUST;
      s.lander.fuel -= 0.1;
      targetTilt = 0.3;
    }
    
    // Interpolate tilt
    s.lander.tilt += (targetTilt - s.lander.tilt) * 0.15;

    // Move
    s.lander.x += s.lander.dx;
    s.lander.y += s.lander.dy;

    // Screen bounds (wrap horizontally)
    if (s.lander.x < 0) s.lander.x = canvas.width;
    if (s.lander.x > canvas.width) s.lander.x = 0;

    // Ceiling
    if (s.lander.y < 0) {
      s.lander.y = 0;
      s.lander.dy = 0;
    }

    // Check Landing
    const l = s.lander;
    const p = s.pad;
    
    // Is bottom of lander touching or below pad Y?
    if (l.y + l.height/2 >= p.y - 2 && l.y + l.height/2 <= p.y + 5) {
      // Is it within pad X bounds?
      if (l.x - l.width/2 >= p.x && l.x + l.width/2 <= p.x + p.width) {
        // Check speed
        if (l.dy <= MAX_LANDING_SPEED) {
          // Successful landing
          s.hasLanded = true;
          s.score += Math.floor(s.lander.fuel) + (s.level * 10);
          setScore(s.score);
          setMessage('Signal Acquired');
          
          if (s.score > bestScoreRef.current) {
            setBestScore(s.score);
            bestScoreRef.current = s.score;
            localStorage.setItem('signal_landing_best', s.score.toString());
          }
          
          setTimeout(() => {
            s.level++;
            initGame(true);
          }, 1500);
          return;
        } else {
          // Crashed (too fast)
          s.isGameOver = true;
          setGameOver(true);
          setIsPlaying(false);
          setMessage('Impact Too Hard');
          return;
        }
      }
    }

    // Check Terrain Collision
    if (checkCollision()) {
      s.isGameOver = true;
      setGameOver(true);
      setIsPlaying(false);
      setMessage('Signal Lost (Collision)');
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

    // Draw Terrain
    ctx.strokeStyle = rawColors.panelBorder;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(s.terrain[0].x, s.terrain[0].y);
    for (let i = 1; i < s.terrain.length; i++) {
      ctx.lineTo(s.terrain[i].x, s.terrain[i].y);
    }
    ctx.lineTo(canvas.width, canvas.height);
    ctx.lineTo(0, canvas.height);
    ctx.closePath();
    ctx.fillStyle = `${rawColors.panelBorder}40`;
    ctx.fill();
    ctx.stroke();

    // Draw Pad
    ctx.fillStyle = rawColors.accent;
    ctx.fillRect(s.pad.x, s.pad.y, s.pad.width, 4);

    // Draw Lander
    if (!s.isGameOver) {
      ctx.save();
      ctx.translate(s.lander.x, s.lander.y);
      ctx.rotate(s.lander.tilt);
      
      // Main body
      ctx.fillStyle = rawColors.textMain;
      ctx.beginPath();
      ctx.moveTo(0, -s.lander.height/2); // Nose
      ctx.lineTo(s.lander.width/3, -s.lander.height/4);
      ctx.lineTo(s.lander.width/3, s.lander.height/2);
      ctx.lineTo(-s.lander.width/3, s.lander.height/2);
      ctx.lineTo(-s.lander.width/3, -s.lander.height/4);
      ctx.closePath();
      ctx.fill();

      // Right fin
      ctx.fillStyle = rawColors.accent;
      ctx.beginPath();
      ctx.moveTo(s.lander.width/3, s.lander.height/4);
      ctx.lineTo(s.lander.width/2, s.lander.height/2 + 2);
      ctx.lineTo(s.lander.width/3, s.lander.height/2);
      ctx.closePath();
      ctx.fill();

      // Left fin
      ctx.beginPath();
      ctx.moveTo(-s.lander.width/3, s.lander.height/4);
      ctx.lineTo(-s.lander.width/2, s.lander.height/2 + 2);
      ctx.lineTo(-s.lander.width/3, s.lander.height/2);
      ctx.closePath();
      ctx.fill();

      // Window
      ctx.fillStyle = rawColors.pageBg;
      ctx.beginPath();
      ctx.arc(0, -2, 2, 0, Math.PI * 2);
      ctx.fill();

      // Draw Main Thrust
      if (s.isThrusting && s.lander.fuel > 0) {
        ctx.fillStyle = rawColors.accent;
        ctx.beginPath();
        ctx.moveTo(-3, s.lander.height/2);
        ctx.lineTo(3, s.lander.height/2);
        ctx.lineTo(0, s.lander.height/2 + 8 + Math.random() * 4);
        ctx.closePath();
        ctx.fill();
      }

      ctx.restore();
    } else {
      // Explosion
      ctx.fillStyle = rawColors.accent;
      for (let i = 0; i < 8; i++) {
        ctx.beginPath();
        ctx.arc(s.lander.x + (Math.random() - 0.5) * 30, s.lander.y + (Math.random() - 0.5) * 30, Math.random() * 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Draw Fuel & Speed HUD
    ctx.fillStyle = rawColors.textMain;
    ctx.font = '10px monospace';
    ctx.fillText(`FUEL: ${Math.max(0, Math.floor(s.lander.fuel))}`, 10, 20);
    
    ctx.fillStyle = s.lander.dy > MAX_LANDING_SPEED ? rawColors.accent : rawColors.textMain;
    ctx.fillText(`V-SPD: ${s.lander.dy.toFixed(1)}`, 10, 35);
  };

  const loop = () => {
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

  useEffect(() => {
    if (!isPlaying && !gameOver) {
      generateTerrain(1);
      draw();
    }
  }, []);

  return (
    <div className="flex flex-col h-full items-center justify-center p-4">
      <div className="w-full max-w-[340px] flex justify-between items-end mb-4 rounded-2xl border px-4 py-3 backdrop-blur-md" style={{ backgroundColor: rawColors.panelBg, borderColor: rawColors.panelBorder }}>
        <div className="flex-1">
          <div className="text-[10px] uppercase tracking-widest opacity-60">Score</div>
          <div className="text-xl font-light leading-none mt-1">{score}</div>
        </div>
        <div className="flex-1 text-center">
          <div className="text-[10px] uppercase tracking-widest opacity-60">Best</div>
          <div className="text-xl font-light leading-none mt-1">{bestScore}</div>
        </div>
        <div className="flex-1 text-right">
          <div className="text-[10px] uppercase tracking-widest opacity-60">Level</div>
          <div className="text-xl font-light leading-none mt-1 opacity-80">{state.current.level}</div>
        </div>
      </div>

      <div 
        className="relative w-full max-w-[340px] aspect-[3/4] rounded-2xl overflow-hidden border" 
        style={{ backgroundColor: rawColors.panelBg, borderColor: rawColors.panelBorder }}
      >
        <canvas
          ref={canvasRef}
          width={340}
          height={453}
          className="w-full h-full touch-none"
        />
        
        {!isPlaying && !gameOver && !state.current.hasLanded && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/20 backdrop-blur-sm pointer-events-none">
            <div className="text-center">
              <div className="text-xl font-light mb-2">Signal Landing</div>
              <div className="text-xs opacity-60 uppercase tracking-widest">Use controls below</div>
            </div>
          </div>
        )}
        
        {message && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="bg-black/80 text-white px-4 py-2 rounded-[var(--shape-control)] text-sm font-medium tracking-wider uppercase text-center">
              {message}
            </div>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="w-full max-w-[340px] flex gap-2 mt-4">
        <button
          className="flex-1 py-4 rounded-xl border flex justify-center items-center active:scale-95 transition-transform touch-none"
          style={{ backgroundColor: rawColors.panelBg, borderColor: rawColors.panelBorder, color: rawColors.textMain }}
          onPointerDown={() => { if(!isPlaying && !gameOver) initGame(); state.current.isThrustingLeft = true; }}
          onPointerUp={() => state.current.isThrustingLeft = false}
          onPointerLeave={() => state.current.isThrustingLeft = false}
        >
          <ChevronLeft size={24} />
        </button>
        <button
          className="flex-[2] py-4 rounded-xl border flex justify-center items-center active:scale-95 transition-transform touch-none"
          style={{ backgroundColor: rawColors.panelBg, borderColor: rawColors.panelBorder, color: rawColors.accent }}
          onPointerDown={() => { if(!isPlaying && !gameOver) initGame(); state.current.isThrusting = true; }}
          onPointerUp={() => state.current.isThrusting = false}
          onPointerLeave={() => state.current.isThrusting = false}
        >
          <ArrowUp size={24} />
        </button>
        <button
          className="flex-1 py-4 rounded-xl border flex justify-center items-center active:scale-95 transition-transform touch-none"
          style={{ backgroundColor: rawColors.panelBg, borderColor: rawColors.panelBorder, color: rawColors.textMain }}
          onPointerDown={() => { if(!isPlaying && !gameOver) initGame(); state.current.isThrustingRight = true; }}
          onPointerUp={() => state.current.isThrustingRight = false}
          onPointerLeave={() => state.current.isThrustingRight = false}
        >
          <ChevronRight size={24} />
        </button>
      </div>

      <div className="h-12 mt-4">
        {gameOver && (
          <motion.button 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            onClick={() => initGame(false)}
            className={cn("px-6 py-3 rounded-[var(--shape-control)] font-medium text-sm flex items-center gap-2 hover:scale-105 transition-transform", "text-white")}
            style={{ backgroundColor: rawColors.accent, color: rawColors.accentText }}
          >
            <RotateCcw size={16} /> Restart Sequence
          </motion.button>
        )}
      </div>
    </div>
  );
}
