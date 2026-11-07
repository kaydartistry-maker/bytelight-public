// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { RotateCcw } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useHeldKeys, useKeyPress } from './gameKeys';

interface Ball {
  x: number;
  y: number;
  dx: number;
  dy: number;
  radius: number;
  isPiercing: boolean;
  isOverclocked: boolean;
}

interface Block {
  x: number;
  y: number;
  width: number;
  height: number;
  hp: number;
  maxHp: number;
}

interface PowerUp {
  x: number;
  y: number;
  dy: number;
  type: 'split' | 'width' | 'pierce' | 'overclock';
  width: number;
  height: number;
}

export function FirewallBreachGame({ colors, rawColors, onExit }: { colors: any, rawColors: any, onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [score, setScore] = useState(0);
  const [gameOver, setGameOver] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [message, setMessage] = useState('');
  const requestRef = useRef<number>(0);
  
  const [bestScore, setBestScore] = useState(() => {
    const saved = localStorage.getItem('firewall_breach_best');
    return saved ? parseInt(saved) : 0;
  });
  const bestScoreRef = useRef(bestScore);

  const state = useRef({
    balls: [] as Ball[],
    paddle: { x: 130, y: 470, width: 80, height: 10 },
    blocks: [] as Block[],
    powerUps: [] as PowerUp[],
    score: 0,
    level: 1,
    isGameOver: false,
    particles: [] as {x: number, y: number, dx: number, dy: number, life: number, color: string}[],
    _lastSave: 0
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

  const generateBlocks = (level: number) => {
    const blocks: Block[] = [];
    const rows = 4; // Always 4 layers
    const cols = 6;
    const padding = 5;
    const w = (340 - padding * (cols + 1)) / cols;
    const h = 15;
    const startY = 40;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let hp = 1;
        if (r === 0) hp = 4; // Orange (Top)
        else if (r === 1) hp = 3; // Red
        else if (r === 2) hp = 2; // Yellow
        else hp = 1; // Green

        blocks.push({
          x: padding + c * (w + padding),
          y: startY + r * (h + padding),
          width: w,
          height: h,
          hp: hp,
          maxHp: hp
        });
      }
    }
    state.current.blocks = blocks;
  };

  const initGame = (keepScore = false) => {
    const s = state.current;
    // Increase speed slightly per level
    const speed = 2.2 + (s.level * 0.4);
    s.balls = [{ x: 170, y: 450, dx: speed * (Math.random() > 0.5 ? 1 : -1), dy: -speed, radius: 4, isPiercing: false, isOverclocked: false }];
    s.paddle = { x: 130, y: 470, width: 80, height: 10 };
    s.powerUps = [];
    s.particles = [];
    s.isGameOver = false;
    
    if (!keepScore) {
      s.score = 0;
      s.level = 1;
      setScore(0);
    }
    
    generateBlocks(s.level);
    setMessage('');
    setGameOver(false);
    setIsPlaying(true);
  };

  const spawnPowerUp = (x: number, y: number) => {
    if (Math.random() > 0.2) return; // 20% chance
    
    const types: ('split' | 'width' | 'pierce' | 'overclock')[] = ['split', 'width', 'pierce', 'overclock'];
    const type = types[Math.floor(Math.random() * types.length)];
    
    state.current.powerUps.push({
      x, y, dy: 1.5, type, width: 20, height: 10
    });
  };

  const createExplosion = (x: number, y: number, color: string) => {
    for (let i = 0; i < 8; i++) {
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

  const showMessage = (msg: string) => {
    setMessage(msg);
    setTimeout(() => setMessage(''), 1500);
  };

  const applyPowerUp = (type: string) => {
    const s = state.current;
    if (type === 'split') {
      showMessage('Packet Split');
      const newBalls: Ball[] = [];
      s.balls.forEach(b => {
        newBalls.push({ ...b, dx: -b.dx, dy: b.dy });
      });
      s.balls.push(...newBalls);
    } else if (type === 'width') {
      showMessage('Bandwidth Boost');
      s.paddle.width = Math.min(150, s.paddle.width + 30);
    } else if (type === 'pierce') {
      showMessage('Direct Injection');
      s.balls.forEach(b => b.isPiercing = true);
    } else if (type === 'overclock') {
      showMessage('Overclocked');
      s.balls.forEach(b => {
        b.isOverclocked = true;
        // Increase speed slightly but maintain direction
        const speed = Math.hypot(b.dx, b.dy);
        const newSpeed = Math.min(8, speed * 1.3);
        b.dx = (b.dx / speed) * newSpeed;
        b.dy = (b.dy / speed) * newSpeed;
      });
    }
  };

  const updatePhysics = () => {
    const s = state.current;
    if (s.isGameOver) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    // Check level complete (Win if all Orange blocks are destroyed)
    const orangeBlocks = s.blocks.filter(b => b.maxHp === 4);
    if (orangeBlocks.length === 0 && s.blocks.length > 0) {
      s.level++;
      initGame(true);
      showMessage('Core Breached!');
      return;
    } else if (s.blocks.length === 0) {
      s.level++;
      initGame(true);
      showMessage('Firewall Cleared!');
      return;
    }

    // Update powerups
    for (let i = s.powerUps.length - 1; i >= 0; i--) {
      const p = s.powerUps[i];
      p.y += p.dy;
      
      // Paddle collision
      if (
        p.y + p.height > s.paddle.y &&
        p.y < s.paddle.y + s.paddle.height &&
        p.x + p.width > s.paddle.x &&
        p.x < s.paddle.x + s.paddle.width
      ) {
        applyPowerUp(p.type);
        s.powerUps.splice(i, 1);
        continue;
      }
      
      if (p.y > canvas.height) {
        s.powerUps.splice(i, 1);
      }
    }

    // Update particles
    for (let i = s.particles.length - 1; i >= 0; i--) {
      const p = s.particles[i];
      p.x += p.dx;
      p.y += p.dy;
      p.life -= 0.05;
      if (p.life <= 0) s.particles.splice(i, 1);
    }

    // Update balls
    for (let i = s.balls.length - 1; i >= 0; i--) {
      const b = s.balls[i];
      b.x += b.dx;
      b.y += b.dy;

      // Wall collisions
      if (b.x + b.radius > canvas.width || b.x - b.radius < 0) {
        b.dx *= -1;
        b.x = Math.max(b.radius, Math.min(b.x, canvas.width - b.radius));
      }
      if (b.y - b.radius < 0) {
        b.dy *= -1;
        b.y = b.radius;
      }

      // Paddle collision
      if (
        b.dy > 0 &&
        b.y + b.radius > s.paddle.y &&
        b.y - b.radius < s.paddle.y + s.paddle.height &&
        b.x > s.paddle.x &&
        b.x < s.paddle.x + s.paddle.width
      ) {
        b.dy = -Math.abs(b.dy);
        b.y = s.paddle.y - b.radius;
        
        // English
        const hitPoint = (b.x - (s.paddle.x + s.paddle.width / 2)) / (s.paddle.width / 2);
        const speed = Math.hypot(b.dx, b.dy);
        b.dx = hitPoint * (speed * 0.8);
        // Normalize speed
        const newSpeed = Math.hypot(b.dx, b.dy);
        b.dx = (b.dx / newSpeed) * speed;
        b.dy = (b.dy / newSpeed) * speed;
      }

      // Block collisions
      for (let j = s.blocks.length - 1; j >= 0; j--) {
        const bl = s.blocks[j];
        
        // Simple AABB collision
        if (
          b.x + b.radius > bl.x &&
          b.x - b.radius < bl.x + bl.width &&
          b.y + b.radius > bl.y &&
          b.y - b.radius < bl.y + bl.height
        ) {
          // Bounce unless piercing
          if (!b.isPiercing) {
            // Determine bounce direction
            const overlapLeft = (b.x + b.radius) - bl.x;
            const overlapRight = (bl.x + bl.width) - (b.x - b.radius);
            const overlapTop = (b.y + b.radius) - bl.y;
            const overlapBottom = (bl.y + bl.height) - (b.y - b.radius);
            
            const minOverlap = Math.min(overlapLeft, overlapRight, overlapTop, overlapBottom);
            
            if (minOverlap === overlapLeft || minOverlap === overlapRight) {
              b.dx *= -1;
            } else {
              b.dy *= -1;
            }
          }

          // Damage block
          bl.hp -= (b.isOverclocked ? 2 : 1);
          
          if (bl.hp <= 0) {
            const explosionColor = getThemeColor(bl.maxHp, rawColors.accent);

            createExplosion(bl.x + bl.width/2, bl.y + bl.height/2, explosionColor);
            spawnPowerUp(bl.x + bl.width/2 - 10, bl.y + bl.height/2);
            s.blocks.splice(j, 1);
            s.score += (b.isOverclocked ? 20 : 10) * bl.maxHp;
            
            // Direct DOM update instead of setScore to avoid React render lag
            const scoreEl = document.getElementById('firewall-score');
            if (scoreEl) scoreEl.innerText = s.score.toString();
            else setScore(s.score); // fallback
            
            if (s.score > bestScoreRef.current) {
              bestScoreRef.current = s.score;
              const bestEl = document.getElementById('firewall-best');
              if (bestEl) bestEl.innerText = s.score.toString();
              else setBestScore(s.score); // fallback
              
              // Throttle localStorage updates to avoid lag
              if (!state.current._lastSave || Date.now() - state.current._lastSave > 1000) {
                localStorage.setItem('firewall_breach_best', s.score.toString());
                state.current._lastSave = Date.now();
              }
            }
          }
          break; // Only hit one block per frame per ball
        }
      }

      // Bottom collision (lose ball)
      if (b.y + b.radius > canvas.height) {
        s.balls.splice(i, 1);
      }
    }

    // Game Over check
    if (s.balls.length === 0) {
      s.isGameOver = true;
      setGameOver(true);
      setIsPlaying(false);
    }
  };

  const drawStar = (ctx: CanvasRenderingContext2D, cx: number, cy: number, spikes: number, outerRadius: number, innerRadius: number) => {
    let rot = Math.PI / 2 * 3;
    let x = cx;
    let y = cy;
    const step = Math.PI / spikes;

    ctx.beginPath();
    ctx.moveTo(cx, cy - outerRadius);
    for (let i = 0; i < spikes; i++) {
      x = cx + Math.cos(rot) * outerRadius;
      y = cy + Math.sin(rot) * outerRadius;
      ctx.lineTo(x, y);
      rot += step;

      x = cx + Math.cos(rot) * innerRadius;
      y = cy + Math.sin(rot) * innerRadius;
      ctx.lineTo(x, y);
      rot += step;
    }
    ctx.lineTo(cx, cy - outerRadius);
    ctx.closePath();
    ctx.fill();
  };

  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const s = state.current;

    // Clear
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw Blocks
    s.blocks.forEach(bl => {
      ctx.fillStyle = getThemeColor(bl.hp, rawColors.accent);

      ctx.fillRect(bl.x, bl.y, bl.width, bl.height);
      // Inner border for style
      ctx.strokeStyle = rawColors.panelBg;
      ctx.lineWidth = 1;
      ctx.strokeRect(bl.x + 1, bl.y + 1, bl.width - 2, bl.height - 2);
    });

    // Draw PowerUps
    s.powerUps.forEach(p => {
      const cx = p.x + p.width / 2;
      const cy = p.y + p.height / 2;
      
      let pColor = rawColors.accent;
      if (p.type === 'split') pColor = getThemeColor(3, rawColors.accent); // Analogous
      else if (p.type === 'width') pColor = getThemeColor(2, rawColors.accent); // Complementary
      else if (p.type === 'pierce') pColor = getThemeColor(1, rawColors.accent); // Split Complementary
      else if (p.type === 'overclock') pColor = '#ff5555';
      
      ctx.fillStyle = pColor;
      
      // Draw star
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(Date.now() / 1000); // Spin slowly
      drawStar(ctx, 0, 0, 5, p.width / 1.6, p.width / 3.2);
      ctx.restore();
    });

    // Draw Paddle
    ctx.fillStyle = rawColors.textMain;
    ctx.beginPath();
    ctx.roundRect(s.paddle.x, s.paddle.y, s.paddle.width, s.paddle.height, 5);
    ctx.fill();

    // Draw Balls
    s.balls.forEach(b => {
      ctx.fillStyle = b.isOverclocked ? '#ff5555' : b.isPiercing ? rawColors.accent : rawColors.textMain;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
      ctx.fill();
      
      if (b.isOverclocked || b.isPiercing) {
        ctx.strokeStyle = `${ctx.fillStyle}80`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.radius + 2, 0, Math.PI * 2);
        ctx.stroke();
      }
    });

    // Draw Particles
    s.particles.forEach(p => {
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.life;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
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
  // Space starts a run the way the button does.
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

  useKeyPress(!isPlaying || gameOver, [' ', 'Enter'], () => initGame(false));

  useEffect(() => {
    if (!isPlaying && !gameOver) {
      generateBlocks(1);
      draw();
    }
  }, []);

  return (
    <div className="flex flex-col h-full items-center p-4">
      <div className="w-full max-w-[420px] flex justify-between items-end mb-4 rounded-2xl border px-4 py-3 backdrop-blur-md shrink-0" style={{ backgroundColor: rawColors.panelBg, borderColor: rawColors.panelBorder }}>
        <div className="flex-1">
          <div className="text-[10px] uppercase tracking-widest opacity-60">Score</div>
          <div id="firewall-score" className="text-xl font-light leading-none mt-1">{score}</div>
        </div>
        <div className="flex-1 text-center">
          <div className="text-[10px] uppercase tracking-widest opacity-60">Best</div>
          <div id="firewall-best" className="text-xl font-light leading-none mt-1">{bestScore}</div>
        </div>
        <div className="flex-1 text-right">
          <div className="text-[10px] uppercase tracking-widest opacity-60">Level</div>
          <div id="firewall-level" className="text-xl font-light leading-none mt-1 opacity-80">{state.current.level}</div>
        </div>
      </div>

      <div className="flex-1 min-h-0 w-full flex justify-center">
      <div
        className="relative h-full aspect-[2/3] max-w-full rounded-2xl overflow-hidden border"
        style={{ backgroundColor: rawColors.panelBg, borderColor: rawColors.panelBorder }}
      >
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
              onClick={() => initGame(false)}
              className={cn("px-6 py-3 rounded-[var(--shape-control)] font-medium text-sm hover:scale-105 transition-transform", "text-white")}
              style={{ backgroundColor: rawColors.accent, color: rawColors.accentText }}
            >
              Breach Firewall
            </button>
          </div>
        )}
        
        {message && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="bg-black/80 text-white px-4 py-2 rounded-[var(--shape-control)] text-sm font-medium tracking-wider uppercase">
              {message}
            </div>
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
              onClick={() => initGame(false)}
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
