// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { RotateCcw, Crosshair } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useHeldKeys, useKeyPress } from './gameKeys';

interface Projectile {
  x: number;
  y: number;
  dx: number;
  dy: number;
  life: number;
}

interface Virus {
  x: number;
  y: number;
  dx: number;
  dy: number;
  radius: number;
  hp: number;
  type: 'packet' | 'worm' | 'leak' | 'trojan';
  baseAngle: number;
  split?: boolean;
}

export function CoreDefenseGame({ colors, rawColors, onExit }: { colors: any, rawColors: any, onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [score, setScore] = useState(0);
  const [gameOver, setGameOver] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const requestRef = useRef<number>(0);
  
  const [bestScore, setBestScore] = useState(() => {
    const saved = localStorage.getItem('core_defense_best');
    return saved ? parseInt(saved) : 0;
  });
  const bestScoreRef = useRef(bestScore);

  const state = useRef({
    projectiles: [] as Projectile[],
    viruses: [] as Virus[],
    particles: [] as {x: number, y: number, dx: number, dy: number, life: number, color?: string}[],
    score: 0,
    frameCount: 0,
    isGameOver: false,
    coreRadius: 15,
    coreAngle: -Math.PI / 2, // Start pointing up
    isRotatingLeft: false,
    isRotatingRight: false,
    isFiring: false,
    lastFireFrame: 0,
    spawnRate: 100
  });

  const getThemeColor = (hp: number, baseHex: string) => {
    let hexToUse = baseHex;
    if (baseHex.startsWith('var(')) {
      const varName = baseHex.match(/var\((.*?)\)/)?.[1];
      if (varName) {
        hexToUse = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
      }
    }
    
    const hex = hexToUse.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16) || 0;
    const g = parseInt(hex.substring(2, 4), 16) || 0;
    const b = parseInt(hex.substring(4, 6), 16) || 0;
    
    const rNorm = r / 255;
    const gNorm = g / 255;
    const bNorm = b / 255;
    const max = Math.max(rNorm, gNorm, bNorm);
    const min = Math.min(rNorm, gNorm, bNorm);
    let h = 0, s = 0, l = (max + min) / 2;
    
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case rNorm: h = (gNorm - bNorm) / d + (gNorm < bNorm ? 6 : 0); break;
        case gNorm: h = (bNorm - rNorm) / d + 2; break;
        case bNorm: h = (rNorm - gNorm) / d + 4; break;
      }
      h /= 6;
    }
    
    const hue = h * 360;
    const sat = s * 100;
    const lit = l * 100;
    
    if (sat < 10) {
      if (hp >= 4) return hexToUse;
      if (hp === 3) return `rgba(${r},${g},${b},0.8)`;
      if (hp === 2) return `rgba(${r},${g},${b},0.5)`;
      return `rgba(${r},${g},${b},0.3)`;
    }
    
    if (hp >= 4) return `hsl(${hue}, ${sat}%, ${lit}%)`; // Core (Accent)
    if (hp === 3) return `hsl(${(hue + 330) % 360}, ${sat}%, ${lit}%)`; // Analogous
    if (hp === 2) return `hsl(${(hue + 180) % 360}, ${sat}%, ${lit}%)`; // Complementary
    return `hsl(${(hue + 150) % 360}, ${sat}%, ${lit}%)`; // Split Complementary
  };

  const handlePadMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const angle = Math.atan2(e.clientY - cy, e.clientX - cx);
    state.current.coreAngle = angle;
  };

  // Keyboard equivalent of the aim pad: arrows or A/D sweep the core, space
  // holds fire the way a finger held on the pad does.
  useHeldKeys(isPlaying && !gameOver, ['ArrowLeft', 'ArrowRight', 'a', 'd', 'A', 'D', ' '], (held) => {
    const s = state.current;
    const rotation = 0.055;
    if (held.has('ArrowLeft') || held.has('a') || held.has('A')) s.coreAngle -= rotation;
    if (held.has('ArrowRight') || held.has('d') || held.has('D')) s.coreAngle += rotation;
    s.isFiring = held.has(' ');
  });

  useKeyPress(!isPlaying || gameOver, [' ', 'Enter'], () => initGame());

  const initGame = () => {
    state.current = {
      projectiles: [],
      viruses: [],
      particles: [],
      score: 0,
      frameCount: 0,
      isGameOver: false,
      coreRadius: 15,
      coreAngle: -Math.PI / 2,
      isRotatingLeft: false,
      isRotatingRight: false,
      isFiring: false,
      lastFireFrame: 0,
      spawnRate: 100
    };
    setScore(0);
    setGameOver(false);
    setIsPlaying(true);
  };

  const spawnVirus = (overrideType?: 'packet' | 'worm' | 'leak' | 'trojan', overrideX?: number, overrideY?: number, overrideAngle?: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    let x = overrideX ?? 0;
    let y = overrideY ?? 0;
    
    if (overrideX === undefined || overrideY === undefined) {
      // Spawn on edge
      const edge = Math.floor(Math.random() * 4);
      if (edge === 0) { x = Math.random() * canvas.width; y = -20; } // Top
      else if (edge === 1) { x = canvas.width + 20; y = Math.random() * canvas.height; } // Right
      else if (edge === 2) { x = Math.random() * canvas.width; y = canvas.height + 20; } // Bottom
      else { x = -20; y = Math.random() * canvas.height; } // Left
    }

    // Calculate direction to center
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const angle = overrideAngle ?? Math.atan2(cy - y, cx - x);
    
    // Speed increases slightly with score
    const speed = 0.5 + Math.random() * 0.5 + (state.current.score * 0.01);
    
    const types: ('packet' | 'worm' | 'leak' | 'trojan')[] = ['packet', 'packet', 'worm', 'leak', 'trojan'];
    const type = overrideType || types[Math.floor(Math.random() * types.length)];
    
    let radius = 8 + Math.random() * 6;
    let hp = 1;
    let dx = Math.cos(angle) * speed;
    let dy = Math.sin(angle) * speed;

    if (type === 'leak') {
      radius = 6; // Starts small
      dx *= 0.5; // Moves slower
      dy *= 0.5;
    } else if (type === 'trojan') {
      radius = 12; // Slightly larger
    }

    state.current.viruses.push({
      x, y,
      dx, dy,
      radius,
      hp,
      type,
      baseAngle: angle,
      split: false
    });
  };

  const createExplosion = (x: number, y: number, color: string) => {
    for (let i = 0; i < 10; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 2;
      state.current.particles.push({
        x, y,
        dx: Math.cos(angle) * speed,
        dy: Math.sin(angle) * speed,
        life: 1.0,
        color
      });
    }
  };

  const updatePhysics = () => {
    const s = state.current;
    if (s.isGameOver) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;

    s.frameCount++;
    
    // Handle Controls
    if (s.isFiring && s.frameCount - s.lastFireFrame > 8) {
      s.lastFireFrame = s.frameCount;
      const speed = 6;
      s.projectiles.push({
        x: cx + Math.cos(s.coreAngle) * s.coreRadius,
        y: cy + Math.sin(s.coreAngle) * s.coreRadius,
        dx: Math.cos(s.coreAngle) * speed,
        dy: Math.sin(s.coreAngle) * speed,
        life: 100
      });
    }
    
    // Difficulty curve
    if (s.frameCount % Math.max(20, Math.floor(s.spawnRate)) === 0) {
      spawnVirus();
      s.spawnRate = Math.max(20, s.spawnRate - 0.5);
    }

    // Update projectiles
    for (let i = s.projectiles.length - 1; i >= 0; i--) {
      const p = s.projectiles[i];
      p.x += p.dx;
      p.y += p.dy;
      p.life--;
      if (p.life <= 0 || p.x < 0 || p.x > canvas.width || p.y < 0 || p.y > canvas.height) {
        s.projectiles.splice(i, 1);
      }
    }

    // Update particles
    for (let i = s.particles.length - 1; i >= 0; i--) {
      const p = s.particles[i];
      p.x += p.dx;
      p.y += p.dy;
      p.life -= 0.05;
      if (p.life <= 0) {
        s.particles.splice(i, 1);
      }
    }

    // Update viruses
    for (let i = s.viruses.length - 1; i >= 0; i--) {
      const v = s.viruses[i];
      
      // Apply specific behaviors
      if (v.type === 'worm') {
        const wiggle = Math.sin(s.frameCount * 0.2) * 2;
        v.x += v.dx + Math.cos(v.baseAngle + Math.PI/2) * wiggle;
        v.y += v.dy + Math.sin(v.baseAngle + Math.PI/2) * wiggle;
      } else if (v.type === 'leak') {
        v.radius = Math.min(25, v.radius + 0.05); // Expands slowly
        v.x += v.dx;
        v.y += v.dy;
      } else {
        v.x += v.dx;
        v.y += v.dy;
      }
      
      const distToCore = Math.hypot(v.x - cx, v.y - cy);

      // Trojan split logic
      if (v.type === 'trojan' && !v.split && distToCore < 100) {
        v.split = true;
        s.viruses.splice(i, 1);
        spawnVirus('packet', v.x, v.y, v.baseAngle - 0.5);
        spawnVirus('packet', v.x, v.y, v.baseAngle + 0.5);
        createExplosion(v.x, v.y, getThemeColor(1, rawColors.accent)); // Disguised color explosion when splitting
        continue;
      }
      
      // Check collision with core
      if (distToCore < s.coreRadius + v.radius) {
        s.isGameOver = true;
        setGameOver(true);
        setIsPlaying(false);
        createExplosion(cx, cy, rawColors.accent);
        
        if (s.score > bestScoreRef.current) {
          setBestScore(s.score);
          bestScoreRef.current = s.score;
          localStorage.setItem('core_defense_best', s.score.toString());
        }
        return;
      }

      // Check collision with projectiles
      let hit = false;
      for (let j = s.projectiles.length - 1; j >= 0; j--) {
        const p = s.projectiles[j];
        const dist = Math.hypot(v.x - p.x, v.y - p.y);
        if (dist < v.radius + 2) {
          hit = true;
          s.projectiles.splice(j, 1);
          break;
        }
      }

      if (hit) {
        if (v.type === 'trojan' && !v.split) {
          v.split = true;
          s.viruses.splice(i, 1);
          spawnVirus('packet', v.x, v.y, v.baseAngle - 0.5);
          spawnVirus('packet', v.x, v.y, v.baseAngle + 0.5);
          createExplosion(v.x, v.y, getThemeColor(1, rawColors.accent));
        } else {
          let explosionColor = rawColors.accent;
          if (v.type === 'leak') explosionColor = getThemeColor(3, rawColors.accent);
          if (v.type === 'worm') explosionColor = getThemeColor(2, rawColors.accent);
          
          createExplosion(v.x, v.y, explosionColor);
          s.viruses.splice(i, 1);
          s.score += (v.type === 'leak' ? 20 : 10);
          setScore(s.score);
        }
      }
    }
  };

  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const s = state.current;
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;

    // Clear
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw Core
    if (!s.isGameOver) {
      ctx.fillStyle = rawColors.accent;
      ctx.beginPath();
      ctx.arc(cx, cy, s.coreRadius, 0, Math.PI * 2);
      ctx.fill();
      
      // Core pulse
      ctx.strokeStyle = `${rawColors.accent}40`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, s.coreRadius + 5 + Math.sin(s.frameCount * 0.1) * 3, 0, Math.PI * 2);
      ctx.stroke();
      
      // Draw Turret Barrel
      ctx.strokeStyle = rawColors.textMain;
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(s.coreAngle) * (s.coreRadius + 8), cy + Math.sin(s.coreAngle) * (s.coreRadius + 8));
      ctx.stroke();
    }

    // Draw Projectiles
    ctx.fillStyle = rawColors.textMain;
    s.projectiles.forEach(p => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
      ctx.fill();
    });

    // Draw Viruses
    ctx.lineWidth = 2;
    s.viruses.forEach(v => {
      if (v.type === 'trojan' && !v.split) {
        ctx.strokeStyle = getThemeColor(1, rawColors.accent); // Disguised
      } else if (v.type === 'leak') {
        ctx.strokeStyle = getThemeColor(3, rawColors.accent); // Analogous
      } else if (v.type === 'worm') {
        ctx.strokeStyle = getThemeColor(2, rawColors.accent); // Complementary
      } else {
        ctx.strokeStyle = rawColors.accent; // Normal red/accent
      }
      
      ctx.beginPath();
      // Draw jagged virus shape
      for (let i = 0; i < 6; i++) {
        const angle = (i / 6) * Math.PI * 2 + (s.frameCount * 0.05);
        const r = v.radius + (i % 2 === 0 ? 2 : -2);
        const px = v.x + Math.cos(angle) * r;
        const py = v.y + Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
      
      // Inner core for leak
      if (v.type === 'leak') {
        ctx.fillStyle = getThemeColor(3, rawColors.accent);
        ctx.globalAlpha = 0.25;
        ctx.fill();
        ctx.globalAlpha = 1.0;
      }
    });

    // Draw Particles
    s.particles.forEach(p => {
      ctx.fillStyle = p.color ? p.color : `rgba(255, 255, 255, ${p.life})`;
      if (p.color) {
        ctx.globalAlpha = p.life;
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1.0;
    });
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
        <div className="flex-1 text-right">
          <div className="text-[10px] uppercase tracking-widest opacity-60">Best</div>
          <div className="text-xl font-light leading-none mt-1 opacity-80">{bestScore}</div>
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
        
        {!isPlaying && !gameOver && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/20 backdrop-blur-sm pointer-events-none">
            <div className="text-center">
              <div className="text-xl font-light mb-2">Core Defense</div>
              <div className="text-xs opacity-60 uppercase tracking-widest">Use controls below</div>
            </div>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="w-full max-w-[340px] flex justify-center mt-4">
        <div 
          className="w-32 h-32 rounded-full border-2 flex items-center justify-center touch-none relative cursor-pointer"
          style={{ backgroundColor: rawColors.panelBg, borderColor: rawColors.panelBorder }}
          onPointerDown={(e) => {
            if(!isPlaying && !gameOver) initGame();
            state.current.isFiring = true;
            handlePadMove(e);
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (state.current.isFiring) {
              handlePadMove(e);
            }
          }}
          onPointerUp={(e) => {
            state.current.isFiring = false;
            (e.target as HTMLElement).releasePointerCapture(e.pointerId);
          }}
          onPointerCancel={(e) => {
            state.current.isFiring = false;
            (e.target as HTMLElement).releasePointerCapture(e.pointerId);
          }}
        >
          <div className="w-12 h-12 rounded-full flex items-center justify-center pointer-events-none" style={{ backgroundColor: `${rawColors.accent}20`, color: rawColors.accent }}>
            <Crosshair size={24} />
          </div>
        </div>
      </div>

      <div className="h-12 mt-4">
        {gameOver && (
          <motion.button 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            onClick={initGame}
            className={cn("px-6 py-3 rounded-[var(--shape-control)] font-medium text-sm flex items-center gap-2 hover:scale-105 transition-transform", "text-white")}
            style={{ backgroundColor: rawColors.accent, color: rawColors.accentText }}
          >
            <RotateCcw size={16} /> Reinitialize Core
          </motion.button>
        )}
      </div>
    </div>
  );
}
