// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import React, { useState, useEffect, useCallback } from 'react';
import { motion } from 'motion/react';
import { RotateCcw } from 'lucide-react';
import { cn } from '../../lib/utils';

const WORDS = [
  'RADAR', 'PROXY', 'CACHE', 'LOGIC', 'BOARD', 'PANEL', 'DRIVE', 'PIXEL', 
  'FRAME', 'MACRO', 'MICRO', 'CLOUD', 'TOKEN', 'VIRUS', 'DEBUG', 'CRASH', 
  'RESET', 'POWER', 'INPUT', 'STACK', 'QUEUE', 'ARRAY', 'BYTES', 'QUERY',
  'SHELL', 'LINUX', 'ADMIN', 'ROOTS', 'NODES', 'PORTS', 'GATES', 'CHIPS'
];

const KEYBOARD = [
  ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
  ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
  ['ENTER', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', 'DEL']
];

export function PasscodeGame({ colors, rawColors, onExit }: { colors: any, rawColors: any, onExit: () => void }) {
  const [targetWord, setTargetWord] = useState('');
  const [guesses, setGuesses] = useState<string[]>([]);
  const [currentGuess, setCurrentGuess] = useState('');
  const [gameOver, setGameOver] = useState(false);
  const [win, setWin] = useState(false);
  const [gameId, setGameId] = useState(0);

  const initGame = () => {
    setTargetWord(WORDS[Math.floor(Math.random() * WORDS.length)]);
    setGuesses([]);
    setCurrentGuess('');
    setGameOver(false);
    setWin(false);
    setGameId(id => id + 1);
  };

  useEffect(() => { initGame(); }, []);

  const onKeyPress = useCallback((key: string) => {
    if (gameOver || win) return;

    if (key === 'ENTER') {
      if (currentGuess.length === 5) {
        const newGuesses = [...guesses, currentGuess];
        setGuesses(newGuesses);
        setCurrentGuess('');
        if (currentGuess === targetWord) {
          setWin(true);
          setGameOver(true);
        } else if (newGuesses.length >= 6) {
          setGameOver(true);
        }
      }
    } else if (key === 'DEL' || key === 'BACKSPACE') {
      setCurrentGuess(prev => prev.slice(0, -1));
    } else if (/^[A-Z]$/.test(key) && currentGuess.length < 5) {
      setCurrentGuess(prev => prev + key);
    }
  }, [currentGuess, guesses, gameOver, win, targetWord]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toUpperCase();
      if (key === 'ENTER' || key === 'BACKSPACE' || /^[A-Z]$/.test(key)) {
        onKeyPress(key === 'BACKSPACE' ? 'DEL' : key);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onKeyPress]);

  const getLetterStatus = (letter: string, index: number, guess: string) => {
    if (targetWord[index] === letter) return 'correct';
    if (targetWord.includes(letter)) {
      // Handle multiple same letters (simplified)
      const letterCountInTarget = targetWord.split('').filter(l => l === letter).length;
      const letterCountInGuessSoFar = guess.slice(0, index + 1).split('').filter(l => l === letter).length;
      if (letterCountInGuessSoFar <= letterCountInTarget) return 'present';
    }
    return 'absent';
  };

  const getKeyStatus = (key: string) => {
    let status = 'unused';
    for (const guess of guesses) {
      for (let i = 0; i < 5; i++) {
        if (guess[i] === key) {
          const letterStatus = getLetterStatus(key, i, guess);
          if (letterStatus === 'correct') return 'correct';
          if (letterStatus === 'present' && status !== 'correct') status = 'present';
          if (letterStatus === 'absent' && status === 'unused') status = 'absent';
        }
      }
    }
    return status;
  };

  return (
    <div key={gameId} className="flex flex-col h-full items-center justify-between p-4 pb-8">
      <div className="w-full max-w-[320px] flex justify-between items-end mb-4 rounded-2xl border px-4 py-3 backdrop-blur-md" style={{ backgroundColor: rawColors.panelBg, borderColor: rawColors.panelBorder }}>
        <div className="flex-1">
          <div className="text-[10px] uppercase tracking-widest opacity-60">Attempts</div>
          <div className="text-xl font-light leading-none mt-1">{guesses.length} / 6</div>
        </div>
        <div className="flex-1 text-right">
          <div className="text-[10px] uppercase tracking-widest opacity-60">Status</div>
          <div className="text-xl font-light leading-none mt-1 opacity-80">{win ? 'Access Granted' : gameOver ? 'Locked Out' : 'Decrypting'}</div>
        </div>
      </div>

      <div className="grid grid-rows-6 gap-2 w-full max-w-[280px] mb-6 rounded-2xl border p-2 backdrop-blur-md" style={{ backgroundColor: rawColors.panelBg, borderColor: rawColors.panelBorder }}>
        {Array(6).fill(0).map((_, rowIndex) => {
          const guess = guesses[rowIndex];
          const isCurrentRow = rowIndex === guesses.length;
          const displayWord = guess || (isCurrentRow ? currentGuess.padEnd(5, ' ') : '     ');

          return (
            <div key={rowIndex} className="grid grid-cols-5 gap-2">
              {displayWord.split('').map((letter, colIndex) => {
                const isSpace = letter === ' ';
                let bgColor = `${rawColors.accent}26`;
                let borderColor = `${rawColors.accent}50`;
                let textColor = rawColors.textMain;

                if (guess) {
                  const status = getLetterStatus(letter, colIndex, guess);
                  if (status === 'correct') {
                    bgColor = rawColors.accent;
                    borderColor = rawColors.accent;
                    textColor = '#fff';
                  } else if (status === 'present') {
                    bgColor = '#eab308'; // Yellow
                    borderColor = '#eab308';
                    textColor = '#fff';
                  } else {
                    bgColor = rawColors.panelBg;
                    borderColor = rawColors.panelBg;
                    textColor = rawColors.textMain;
                    // opacity = 0.5
                  }
                } else if (isCurrentRow && !isSpace) {
                  borderColor = rawColors.accent;
                }

                return (
                  <div
                    key={colIndex}
                    className={cn(
                      "aspect-square flex items-center justify-center text-2xl font-bold border-2 rounded-lg transition-all",
                      guess && getLetterStatus(letter, colIndex, guess) === 'absent' && "opacity-40"
                    )}
                    style={{ backgroundColor: bgColor, borderColor, color: textColor }}
                  >
                    {letter}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {gameOver && (
        <div className="mb-4 text-center">
          {!win && <div className="text-sm opacity-60 mb-2">Target: {targetWord}</div>}
          <motion.button 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            onClick={initGame}
            className={cn("px-6 py-3 rounded-[var(--shape-control)] font-medium text-sm flex items-center gap-2 hover:scale-105 transition-transform mx-auto", "text-white")}
            style={{ backgroundColor: rawColors.accent, color: rawColors.accentText }}
          >
            <RotateCcw size={16} /> New Passcode
          </motion.button>
        </div>
      )}

      <div className="w-full max-w-[360px] flex flex-col gap-2">
        {KEYBOARD.map((row, i) => (
          <div key={i} className="flex justify-center gap-1.5">
            {row.map((key) => {
              const status = getKeyStatus(key);
              let bgColor = rawColors.panelBg;
              let textColor = rawColors.textMain;
              let opacity = 1;

              if (status === 'correct') {
                bgColor = rawColors.accent;
                textColor = '#fff';
              } else if (status === 'present') {
                bgColor = '#eab308';
                textColor = '#fff';
              } else if (status === 'absent') {
                opacity = 0.3;
              }

              return (
                <button
                  key={key}
                  onClick={() => onKeyPress(key)}
                  className={cn(
                    "h-12 rounded-lg font-bold text-sm flex items-center justify-center transition-all active:scale-95 border",
                    key === 'ENTER' || key === 'DEL' ? "px-3 text-xs" : "flex-1 max-w-[40px]"
                  )}
                  style={{ backgroundColor: bgColor, color: textColor, opacity, borderColor: rawColors.panelBorder }}
                >
                  {key}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
