// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronLeft, Gamepad2, RotateCcw, BrainCircuit, Zap, Cpu, Wifi, Battery, Bluetooth, Cloud, Radio, Terminal, Grid3X3, KeyRound, CircleDot, ActivitySquare, ArrowDownToLine, ShieldAlert, Layers, Anchor, Spade } from 'lucide-react';
import { AppShell } from './AppShell';
import { ThemeConfig, contrastTextColor } from '../lib/theme';
import { cn } from '../lib/utils';
import { useBackHandler } from '../lib/use-back-handler';
import { SystemSweeper } from './games/SystemSweeper';
import { PasscodeGame } from './games/PasscodeGame';
import { PingGame } from './games/PingGame';
import { PulseGlideGame } from './games/PulseGlideGame';
import { SignalLandingGame } from './games/SignalLandingGame';
import { CoreDefenseGame } from './games/CoreDefenseGame';
import { FirewallBreachGame } from './games/FirewallBreachGame';
import { BattleshipGame } from './games/BattleshipGame';
import { CardRoom } from './games/CardRoom';

interface GamesAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

// --- MEMORY MATCH ---
const CARD_PAIRS = [Cpu, Wifi, Battery, Bluetooth, Cloud, Zap, Radio, Terminal];

interface Card {
  id: number;
  Icon: any;
  isFlipped: boolean;
  isMatched: boolean;
}

function MemoryGame({ colors, rawColors, onExit }: { colors: any, rawColors: any, onExit: () => void }) {
  const [cards, setCards] = useState<Card[]>([]);
  const [flippedIndices, setFlippedIndices] = useState<number[]>([]);
  const [moves, setMoves] = useState(0);
  const [matches, setMatches] = useState(0);
  const [isLocked, setIsLocked] = useState(false);

  const initializeGame = () => {
    const shuffled = [...CARD_PAIRS, ...CARD_PAIRS]
      .sort(() => Math.random() - 0.5)
      .map((Icon, index) => ({
        id: index,
        Icon,
        isFlipped: false,
        isMatched: false,
      }));
    setCards(shuffled);
    setFlippedIndices([]);
    setMoves(0);
    setMatches(0);
    setIsLocked(false);
  };

  useEffect(() => {
    initializeGame();
  }, []);

  const handleCardClick = (index: number) => {
    if (isLocked || cards[index].isFlipped || cards[index].isMatched) return;

    const newFlipped = [...flippedIndices, index];
    setFlippedIndices(newFlipped);
    
    const newCards = [...cards];
    newCards[index].isFlipped = true;
    setCards(newCards);

    if (newFlipped.length === 2) {
      setIsLocked(true);
      setMoves(m => m + 1);
      
      const [firstIndex, secondIndex] = newFlipped;
      if (cards[firstIndex].Icon === cards[secondIndex].Icon) {
        setTimeout(() => {
          const matchedCards = [...newCards];
          matchedCards[firstIndex].isMatched = true;
          matchedCards[secondIndex].isMatched = true;
          setCards(matchedCards);
          setFlippedIndices([]);
          setMatches(m => m + 1);
          setIsLocked(false);
        }, 500);
      } else {
        setTimeout(() => {
          const resetCards = [...newCards];
          resetCards[firstIndex].isFlipped = false;
          resetCards[secondIndex].isFlipped = false;
          setCards(resetCards);
          setFlippedIndices([]);
          setIsLocked(false);
        }, 1000);
      }
    }
  };

  const isWon = matches === CARD_PAIRS.length;

  return (
    <div className="flex flex-col h-full items-center justify-center p-4">
      <div className="w-full max-w-[320px] flex justify-between items-end mb-4 rounded-2xl border px-4 py-3 backdrop-blur-md" style={{ backgroundColor: rawColors.panelBg, borderColor: rawColors.panelBorder }}>
        <div className="flex-1">
          <div className="text-[10px] uppercase tracking-widest opacity-60">Moves</div>
          <div className="text-xl font-light leading-none mt-1">{moves}</div>
        </div>
        <div className="flex-1 text-right">
          <div className="text-[10px] uppercase tracking-widest opacity-60">Matches</div>
          <div className="text-xl font-light leading-none mt-1 opacity-80">{matches} / {CARD_PAIRS.length}</div>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2 w-full max-w-[320px] aspect-square mb-6 rounded-2xl border p-2 backdrop-blur-md" style={{ backgroundColor: rawColors.panelBg, borderColor: rawColors.panelBorder }}>
        {cards.map((card, i) => (
          <button
            key={card.id}
            onClick={() => handleCardClick(i)}
            className={cn(
              "relative w-full h-full rounded-xl transition-all duration-300 preserve-3d",
              (card.isFlipped || card.isMatched) ? "rotate-y-180" : "hover:scale-105 active:scale-95"
            )}
            style={{ perspective: '1000px' }}
          >
            <div 
              className={cn(
                "absolute inset-0 w-full h-full rounded-xl backface-hidden flex items-center justify-center border"
              )}
              style={{
                backgroundColor: rawColors.panelBg,
                backgroundImage: `linear-gradient(0deg, ${rawColors.accent}26, ${rawColors.accent}26)`,
                borderColor: `${rawColors.accent}50`
              }}
            >
              <BrainCircuit className="opacity-20" size={24} />
            </div>
            <div 
              className={cn(
                "absolute inset-0 w-full h-full rounded-xl backface-hidden flex items-center justify-center border rotate-y-180",
                card.isMatched ? "opacity-50" : ""
              )}
              style={{
                backgroundColor: card.isMatched ? 'transparent' : rawColors.panelBg,
                backgroundImage: card.isMatched ? undefined : `linear-gradient(0deg, ${rawColors.accent}26, ${rawColors.accent}26)`,
                borderColor: card.isMatched ? rawColors.panelBorder : rawColors.accent,
                color: card.isMatched ? rawColors.textMain : rawColors.accent
              }}
            >
              <card.Icon size={28} strokeWidth={1.5} />
            </div>
          </button>
        ))}
      </div>

      <div className="h-12">
        {isWon && (
          <motion.button 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            onClick={initializeGame}
            className={cn("px-6 py-3 rounded-[var(--shape-control)] font-medium text-sm flex items-center gap-2 hover:scale-105 transition-transform", "text-white")}
            style={{ backgroundColor: rawColors.accent, color: rawColors.accentText }}
          >
            <RotateCcw size={16} /> Play Again
          </motion.button>
        )}
      </div>
    </div>
  );
}

// --- REACTION TEST ---
type ReactionState = 'idle' | 'waiting' | 'ready' | 'result' | 'early';

function ReactionGame({ colors, rawColors, themeMode, themeConfig, onExit }: { colors: any, rawColors: any, themeMode: string, themeConfig: any, onExit: () => void }) {
  const [gameState, setGameState] = useState<ReactionState>('idle');
  const [reactionTime, setReactionTime] = useState<number | null>(null);
  const [bestTime, setBestTime] = useState<number | null>(() => {
    const saved = localStorage.getItem('radar_reaction_best');
    return saved ? parseInt(saved) : null;
  });
  
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const startTimeRef = useRef<number>(0);

  const startGame = () => {
    setGameState('waiting');
    setReactionTime(null);
    
    const delay = Math.random() * 3000 + 2000; // 2 to 5 seconds
    timeoutRef.current = setTimeout(() => {
      setGameState('ready');
      startTimeRef.current = Date.now();
    }, delay);
  };

  const handleClick = () => {
    if (gameState === 'idle' || gameState === 'result' || gameState === 'early') {
      startGame();
    } else if (gameState === 'waiting') {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      setGameState('early');
    } else if (gameState === 'ready') {
      const time = Date.now() - startTimeRef.current;
      setReactionTime(time);
      setGameState('result');
      if (!bestTime || time < bestTime) {
        setBestTime(time);
        localStorage.setItem('radar_reaction_best', time.toString());
      }
    }
  };

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const getBgColor = () => {
    if (gameState === 'waiting') return `${rawColors.accent}cc`; // waiting state
    if (gameState === 'ready') return rawColors.accent; // ready state
    return `${rawColors.accent}10`;
  };

  const getTextColor = () => {
    // WAIT / TAP! sit on the accent itself — use the readable text colour the
    // house already derives for that accent instead of assuming white.
    if (gameState === 'waiting' || gameState === 'ready') return rawColors.accentText;
    return rawColors.textMain;
  };

  return (
    <div className="flex flex-col h-full items-center justify-center p-6">
      <div className="w-full max-w-[320px] flex justify-between items-end mb-4 rounded-2xl border px-4 py-3 backdrop-blur-md" style={{ backgroundColor: rawColors.panelBg, borderColor: rawColors.panelBorder }}>
        <div className="flex-1">
          <div className="text-[10px] uppercase tracking-widest opacity-60">Status</div>
          <div className="text-xl font-light leading-none mt-1 capitalize">{gameState === 'idle' ? 'Ready' : gameState}</div>
        </div>
        <div className="flex-1 text-right">
          <div className="text-[10px] uppercase tracking-widest opacity-60">Best Time</div>
          <div className="text-xl font-light leading-none mt-1 opacity-80">{bestTime ? `${bestTime}ms` : '---'}</div>
        </div>
      </div>

      <button
        onClick={handleClick}
        className={cn(
          "w-full max-w-[320px] aspect-square rounded-3xl border-2 transition-all duration-200 flex flex-col items-center justify-center gap-4",
          gameState === 'idle' || gameState === 'result' || gameState === 'early' ? "hover:scale-[1.02] active:scale-95" : ""
        )}
        style={{
          backgroundColor: gameState === 'waiting' || gameState === 'ready' ? getBgColor() : rawColors.panelBg,
          backgroundImage: gameState === 'waiting' || gameState === 'ready' ? undefined : `linear-gradient(0deg, ${rawColors.accent}1a, ${rawColors.accent}1a)`,
          borderColor: gameState === 'idle' || gameState === 'result' || gameState === 'early' ? `${rawColors.accent}30` : getBgColor(),
          color: getTextColor()
        }}
      >
        {gameState === 'idle' && (
          <>
            <Zap size={48} className="opacity-50" />
            <div className="text-xl font-light">Tap to Start</div>
            <div className="text-xs opacity-60">Wait for green, then tap quickly</div>
          </>
        )}
        
        {gameState === 'waiting' && (
          <>
            <div className="text-3xl font-bold tracking-widest">WAIT</div>
          </>
        )}

        {gameState === 'ready' && (
          <>
            <div className="text-4xl font-bold tracking-widest">TAP!</div>
          </>
        )}

        {gameState === 'early' && (
          <>
            <div className="text-2xl font-light">Too Early!</div>
            <div className="text-sm opacity-80 mt-2">Tap to try again</div>
          </>
        )}

        {gameState === 'result' && (
          <>
            <div className="text-5xl font-light">{reactionTime}</div>
            <div className="text-sm opacity-60 tracking-widest uppercase">Milliseconds</div>
            <div className="text-sm opacity-80 mt-6">Tap to try again</div>
          </>
        )}
      </button>
    </div>
  );
}

// --- MAIN APP COMPONENT ---
export function GamesApp({ onClose, themeConfig, themeMode }: GamesAppProps) {
  const colors = themeConfig[themeMode];
  const [activeGame, setActiveGame] = useState<'menu' | 'battleship' | 'cards' | 'memory' | 'reaction' | 'sweeper' | 'passcode' | 'ping' | 'glide' | 'landing' | 'core' | 'breach'>('menu');

  const extractColor = (twClass: string) => {
    if (twClass.startsWith('#')) return twClass;
    
    // A custom theme and every palette name their colors as CSS variables,
    // bare (var(--pal-primary)) or inside a Tailwind class
    // (bg-[var(--pal-surface)]). Read the live value: the games mix and pastel
    // these, and a palette class that fell through to the white fallback below
    // is what turned every game white when the palettes came in.
    const varMatch = twClass.match(/var\((--[A-Za-z0-9-]+)\)/);
    if (varMatch) {
      const val = getComputedStyle(document.documentElement).getPropertyValue(varMatch[1]).trim();
      if (val) return val;
      return `var(${varMatch[1]})`;
    }
    
    const match = twClass.match(/\[(#[0-9A-Fa-f]{6})\]/);
    if (match) return match[1];
    
    // Fallbacks for standard tailwind colors used in monochrome
    if (twClass.includes('white')) return '#ffffff';
    if (twClass.includes('black')) return '#000000';
    if (twClass.includes('gray-100')) return '#f3f4f6';
    if (twClass.includes('gray-400')) return '#9ca3af';
    if (twClass.includes('gray-500')) return '#6b7280';
    if (twClass.includes('gray-900')) return '#111827';
    
    return '#ffffff'; // default fallback
  };

  const toPastel = (hex: string) => {
    if (!hex.startsWith('#')) return hex;
    const r = parseInt(hex.substring(1, 3), 16) || 0;
    const g = parseInt(hex.substring(3, 5), 16) || 0;
    const b = parseInt(hex.substring(5, 7), 16) || 0;
    
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
    
    // Keep the accent legible without repainting it. The old floors (0.75 dark,
    // 0.65 light) lightened every accent past its own identity — an orange came
    // out peach across the whole arcade. Floor only what would actually be
    // unreadable against the surface, and leave anything already legible alone.
    if (themeMode === 'dark') {
      if (s > 0.1) {
        s = Math.max(s, 0.85); // high saturation
      }
      l = Math.max(l, 0.5); // only lift accents too dark to read on black
    } else {
      if (s > 0.1) {
        s = Math.min(s, 0.8);
      }
      l = Math.min(Math.max(l, 0.35), 0.6); // keep it off white, not washed toward it
    }
    
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    
    let rNew, gNew, bNew;
    if (s === 0) {
      rNew = gNew = bNew = l;
    } else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      rNew = hue2rgb(p, q, h + 1/3);
      gNew = hue2rgb(p, q, h);
      bNew = hue2rgb(p, q, h - 1/3);
    }
    
    const toHex = (x: number) => {
      const hexStr = Math.round(x * 255).toString(16);
      return hexStr.length === 1 ? '0' + hexStr : hexStr;
    };
    
    return `#${toHex(rNew)}${toHex(gNew)}${toHex(bNew)}`;
  };

  const fleetAccent = extractColor(colors.accent);
  // One accent for every game card, halfway between the theme's own color and
  // the old pastel: on a dark palette the pastel was harsh on the eyes and the
  // raw color dim. The Fleet Room and Card Room keep their own colors
  // inside; only their cards on this menu take the shared one.
  const mixHex = (a: string, b: string, t: number) => {
    const pa = /^#([0-9a-f]{6})$/i.exec(a.trim()), pb = /^#([0-9a-f]{6})$/i.exec(b.trim());
    if (!pa || !pb) return b;
    const ca = [0, 2, 4].map((i) => parseInt(pa[1].slice(i, i + 2), 16));
    const cb = [0, 2, 4].map((i) => parseInt(pb[1].slice(i, i + 2), 16));
    return '#' + ca.map((v, i) => Math.round(v + (cb[i] - v) * t).toString(16).padStart(2, '0')).join('');
  };
  const gameAccent = mixHex(fleetAccent, toPastel(fleetAccent), 0.5);
  const rawColors = {
    pageBg: extractColor(colors.pageBg),
    panelBg: extractColor(colors.panelBg),
    panelBorder: extractColor(colors.panelBorder),
    textMain: extractColor(colors.textMain),
    textMuted: extractColor(colors.textMuted),
    userBubbleBg: extractColor(colors.userBubbleBg),
    userBubbleText: extractColor(colors.userBubbleText),
    compBubbleBg: extractColor(colors.compBubbleBg),
    compBubbleText: extractColor(colors.compBubbleText),
    accent: gameAccent,
    accentText: contrastTextColor(gameAccent),
  };
  const fleetColors = {
    ...rawColors,
    accent: fleetAccent,
    accentText: 'var(--bytelight-on-accent)',
  };

  const getGameTitle = () => {
    switch (activeGame) {
      case 'battleship': return 'The Fleet Room';
      case 'cards': return 'The Card Room';
      case 'memory': return 'Memory Match';
      case 'reaction': return 'Reaction Test';
      case 'sweeper': return 'System Sweeper';
      case 'passcode': return 'Passcode';
      case 'ping': return 'Ping';
      case 'glide': return 'Signal Glide';
      case 'landing': return 'Signal Landing';
      case 'core': return 'Core Defense';
      case 'breach': return 'Firewall Breach';
      default: return 'Games';
    }
  };

  // Back button goes "one level out": from a game back to the menu, from
  // the menu out of the app — same behaviour as the hand-rolled header
  // had, just plumbed into AppShell's onClose.
  // Coming back from a game landed the user wherever the last scroll left this
  // container — bottom of a chat meant bottom of the games list. The menu is a
  // place you arrive at, so it starts at the top.
  const menuScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (activeGame === 'menu') menuScrollRef.current?.scrollTo({ top: 0 });
  }, [activeGame]);

  const handleBack = () => (activeGame === 'menu' ? onClose() : setActiveGame('menu'));
  // The phone's back gesture goes to this menu from inside a game, the same
  // place the header's arrow goes, rather than out to the app drawer.
  useBackHandler(activeGame !== 'menu', () => setActiveGame('menu'));

  return (
    <AppShell
      title={getGameTitle()}
      icon={Gamepad2}
      onClose={handleBack}
      themeConfig={themeConfig}
      themeMode={themeMode}
      // A flex column with no padding, so the content below has a real height:
      // the Card Room's h-full and its table talk were sizing off nothing and
      // pushed the talk box below the screen.
      bodyClassName="p-0 overflow-hidden flex flex-col"
    >
      {/* Content */}
      <div className="relative min-h-0 flex-1 overflow-y-auto scrollbar-hide">
        <AnimatePresence mode="wait">
          {activeGame === 'menu' && (
            <motion.div
              key="menu"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="h-full p-4 flex flex-col gap-4"
            >
              <div ref={menuScrollRef} className="grid grid-cols-1 auto-rows-max gap-4 overflow-y-auto pb-20 scrollbar-hide">
                <button
                  onClick={() => setActiveGame('battleship')}
                  className={cn(
                    "relative overflow-hidden rounded-3xl border p-6 text-left shadow-[0_16px_40px_rgba(0,0,0,.22)] transition-all hover:scale-[1.02] active:scale-95",
                    colors.panelBg, colors.panelBorder
                  )}
                >
                  <div className="relative flex items-center gap-4">
                    <div
                      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border"
                      style={{
                        backgroundColor: `color-mix(in srgb, ${gameAccent} 16%, var(--bytelight-surface))`,
                        borderColor: `color-mix(in srgb, ${gameAccent} 30%, var(--custom-panelBorder, var(--bytelight-border)))`,
                        color: gameAccent,
                      }}
                    >
                      <Anchor size={24} />
                    </div>
                    <div>
                      <div className="text-[9px] font-semibold uppercase tracking-[.24em] opacity-60">House waters</div>
                      <h3 className="mt-1 font-serif text-xl" style={{ color: gameAccent }}>The Fleet Room</h3>
                      <p className="mt-1 text-xs" style={{ color: 'var(--bytelight-text)' }}>Sealed boards, saved battles, permanent trash talk.</p>
                    </div>
                  </div>
                </button>

                <button
                  onClick={() => setActiveGame('cards')}
                  className={cn(
                    "relative overflow-hidden rounded-3xl border p-6 text-left shadow-[0_16px_40px_rgba(0,0,0,.22)] transition-all hover:scale-[1.02] active:scale-95",
                    colors.panelBg, colors.panelBorder
                  )}
                >
                  <div className="relative flex items-center gap-4">
                    <div
                      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border"
                      style={{
                        backgroundColor: `color-mix(in srgb, ${gameAccent} 16%, var(--bytelight-surface))`,
                        borderColor: `color-mix(in srgb, ${gameAccent} 30%, var(--custom-panelBorder, var(--bytelight-border)))`,
                        color: gameAccent,
                      }}
                    >
                      <Spade size={24} />
                    </div>
                    <div>
                      <div className="text-[9px] font-semibold uppercase tracking-[.24em] opacity-60">House deck</div>
                      <h3 className="mt-1 font-serif text-xl" style={{ color: gameAccent }}>The Card Room</h3>
                      <p className="mt-1 text-xs" style={{ color: 'var(--bytelight-text)' }}>Fifty-two cards. Four seats. One table.</p>
                    </div>
                  </div>
                </button>

                <button
                  onClick={() => setActiveGame('memory')}
                  className={cn(
                    "p-6 rounded-3xl border flex items-center gap-4 transition-all hover:scale-[1.02] active:scale-95 text-left",
                    colors.panelBg, colors.panelBorder
                  )}
                >
                  <div className="h-12 w-12 rounded-2xl flex items-center justify-center shrink-0" style={{ backgroundColor: `${rawColors.accent}20` }}>
                    <BrainCircuit size={24} style={{ color: rawColors.accent }} />
                  </div>
                  <div>
                    <h3 className="font-medium text-lg" style={{ color: rawColors.accent }}>Memory Match</h3>
                    <p className="text-xs opacity-60 mt-1">Test your recall with system icons.</p>
                  </div>
                </button>

                <button
                  onClick={() => setActiveGame('reaction')}
                  className={cn(
                    "p-6 rounded-3xl border flex items-center gap-4 transition-all hover:scale-[1.02] active:scale-95 text-left",
                    colors.panelBg, colors.panelBorder
                  )}
                >
                  <div className="h-12 w-12 rounded-2xl flex items-center justify-center shrink-0" style={{ backgroundColor: `${rawColors.accent}20` }}>
                    <Zap size={24} style={{ color: rawColors.accent }} />
                  </div>
                  <div>
                    <h3 className="font-medium text-lg" style={{ color: rawColors.accent }}>Reaction Test</h3>
                    <p className="text-xs opacity-60 mt-1">How fast are your reflexes?</p>
                  </div>
                </button>

                <button
                  onClick={() => setActiveGame('sweeper')}
                  className={cn(
                    "p-6 rounded-3xl border flex items-center gap-4 transition-all hover:scale-[1.02] active:scale-95 text-left",
                    colors.panelBg, colors.panelBorder
                  )}
                >
                  <div className="h-12 w-12 rounded-2xl flex items-center justify-center shrink-0" style={{ backgroundColor: `${rawColors.accent}20` }}>
                    <Grid3X3 size={24} style={{ color: rawColors.accent }} />
                  </div>
                  <div>
                    <h3 className="font-medium text-lg" style={{ color: rawColors.accent }}>System Sweeper</h3>
                    <p className="text-xs opacity-60 mt-1">Clear the corrupted sectors.</p>
                  </div>
                </button>

                <button
                  onClick={() => setActiveGame('passcode')}
                  className={cn(
                    "p-6 rounded-3xl border flex items-center gap-4 transition-all hover:scale-[1.02] active:scale-95 text-left",
                    colors.panelBg, colors.panelBorder
                  )}
                >
                  <div className="h-12 w-12 rounded-2xl flex items-center justify-center shrink-0" style={{ backgroundColor: `${rawColors.accent}20` }}>
                    <KeyRound size={24} style={{ color: rawColors.accent }} />
                  </div>
                  <div>
                    <h3 className="font-medium text-lg" style={{ color: rawColors.accent }}>Passcode</h3>
                    <p className="text-xs opacity-60 mt-1">Decrypt the 5-letter system key.</p>
                  </div>
                </button>

                <button
                  onClick={() => setActiveGame('ping')}
                  className={cn(
                    "p-6 rounded-3xl border flex items-center gap-4 transition-all hover:scale-[1.02] active:scale-95 text-left",
                    colors.panelBg, colors.panelBorder
                  )}
                >
                  <div className="h-12 w-12 rounded-2xl flex items-center justify-center shrink-0" style={{ backgroundColor: `${rawColors.accent}20` }}>
                    <CircleDot size={24} style={{ color: rawColors.accent }} />
                  </div>
                  <div>
                    <h3 className="font-medium text-lg" style={{ color: rawColors.accent }}>Ping</h3>
                    <p className="text-xs opacity-60 mt-1">Bounce packets off the firewall.</p>
                  </div>
                </button>

                <button
                  onClick={() => setActiveGame('glide')}
                  className={cn(
                    "p-6 rounded-3xl border flex items-center gap-4 transition-all hover:scale-[1.02] active:scale-95 text-left",
                    colors.panelBg, colors.panelBorder
                  )}
                >
                  <div className="h-12 w-12 rounded-2xl flex items-center justify-center shrink-0" style={{ backgroundColor: `${rawColors.accent}20` }}>
                    <ActivitySquare size={24} style={{ color: rawColors.accent }} />
                  </div>
                  <div>
                    <h3 className="font-medium text-lg" style={{ color: rawColors.accent }}>Signal Glide</h3>
                    <p className="text-xs opacity-60 mt-1">Navigate the interference wave.</p>
                  </div>
                </button>

                <button
                  onClick={() => setActiveGame('landing')}
                  className={cn(
                    "p-6 rounded-3xl border flex items-center gap-4 transition-all hover:scale-[1.02] active:scale-95 text-left",
                    colors.panelBg, colors.panelBorder
                  )}
                >
                  <div className="h-12 w-12 rounded-2xl flex items-center justify-center shrink-0" style={{ backgroundColor: `${rawColors.accent}20` }}>
                    <ArrowDownToLine size={24} style={{ color: rawColors.accent }} />
                  </div>
                  <div>
                    <h3 className="font-medium text-lg" style={{ color: rawColors.accent }}>Signal Landing</h3>
                    <p className="text-xs opacity-60 mt-1">Acquire signal on the landing pad.</p>
                  </div>
                </button>

                <button
                  onClick={() => setActiveGame('core')}
                  className={cn(
                    "p-6 rounded-3xl border flex items-center gap-4 transition-all hover:scale-[1.02] active:scale-95 text-left",
                    colors.panelBg, colors.panelBorder
                  )}
                >
                  <div className="h-12 w-12 rounded-2xl flex items-center justify-center shrink-0" style={{ backgroundColor: `${rawColors.accent}20` }}>
                    <ShieldAlert size={24} style={{ color: rawColors.accent }} />
                  </div>
                  <div>
                    <h3 className="font-medium text-lg" style={{ color: rawColors.accent }}>Core Defense</h3>
                    <p className="text-xs opacity-60 mt-1">Protect the node from corrupted packets.</p>
                  </div>
                </button>

                <button
                  onClick={() => setActiveGame('breach')}
                  className={cn(
                    "p-6 rounded-3xl border flex items-center gap-4 transition-all hover:scale-[1.02] active:scale-95 text-left",
                    colors.panelBg, colors.panelBorder
                  )}
                >
                  <div className="h-12 w-12 rounded-2xl flex items-center justify-center shrink-0" style={{ backgroundColor: `${rawColors.accent}20` }}>
                    <Layers size={24} style={{ color: rawColors.accent }} />
                  </div>
                  <div>
                    <h3 className="font-medium text-lg" style={{ color: rawColors.accent }}>Firewall Breach</h3>
                    <p className="text-xs opacity-60 mt-1">Break through the security layers.</p>
                  </div>
                </button>
              </div>
            </motion.div>
          )}

          {activeGame === 'battleship' && (
            <motion.div
              key="battleship"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="h-full"
            >
              <BattleshipGame colors={colors} rawColors={fleetColors} onExit={() => setActiveGame('menu')} />
            </motion.div>
          )}

          {activeGame === 'cards' && (
            <motion.div
              key="cards"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="h-full"
            >
              <CardRoom colors={colors} onExit={() => setActiveGame('menu')} />
            </motion.div>
          )}

          {activeGame === 'memory' && (
            <motion.div 
              key="memory"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="h-full"
            >
              <MemoryGame colors={colors} rawColors={rawColors} onExit={() => setActiveGame('menu')} />
            </motion.div>
          )}

          {activeGame === 'reaction' && (
            <motion.div 
              key="reaction"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="h-full"
            >
              <ReactionGame colors={colors} rawColors={rawColors} themeMode={themeMode} themeConfig={themeConfig} onExit={() => setActiveGame('menu')} />
            </motion.div>
          )}

          {activeGame === 'sweeper' && (
            <motion.div 
              key="sweeper"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="h-full"
            >
              <SystemSweeper colors={colors} rawColors={rawColors} onExit={() => setActiveGame('menu')} />
            </motion.div>
          )}

          {activeGame === 'passcode' && (
            <motion.div 
              key="passcode"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="h-full"
            >
              <PasscodeGame colors={colors} rawColors={rawColors} onExit={() => setActiveGame('menu')} />
            </motion.div>
          )}

          {activeGame === 'ping' && (
            <motion.div 
              key="ping"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="h-full"
            >
              <PingGame colors={colors} rawColors={rawColors} onExit={() => setActiveGame('menu')} />
            </motion.div>
          )}

          {activeGame === 'glide' && (
            <motion.div 
              key="glide"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="h-full"
            >
              <PulseGlideGame colors={colors} rawColors={rawColors} onExit={() => setActiveGame('menu')} />
            </motion.div>
          )}

          {activeGame === 'landing' && (
            <motion.div 
              key="landing"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="h-full"
            >
              <SignalLandingGame colors={colors} rawColors={rawColors} onExit={() => setActiveGame('menu')} />
            </motion.div>
          )}

          {activeGame === 'core' && (
            <motion.div 
              key="core"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="h-full"
            >
              <CoreDefenseGame colors={colors} rawColors={rawColors} onExit={() => setActiveGame('menu')} />
            </motion.div>
          )}

          {activeGame === 'breach' && (
            <motion.div 
              key="breach"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="h-full"
            >
              <FirewallBreachGame colors={colors} rawColors={rawColors} onExit={() => setActiveGame('menu')} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </AppShell>
  );
}
