// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { RotateCcw, Flag, Bomb } from 'lucide-react';
import { cn } from '../../lib/utils';

const ROWS = 8;
const COLS = 8;
const MINES = 10;

interface Cell {
  row: number;
  col: number;
  isMine: boolean;
  isRevealed: boolean;
  isFlagged: boolean;
  neighborMines: number;
}

export function SystemSweeper({ colors, rawColors, onExit }: { colors: any, rawColors: any, onExit: () => void }) {
  const [board, setBoard] = useState<Cell[][]>([]);
  const [gameOver, setGameOver] = useState(false);
  const [win, setWin] = useState(false);
  const [flags, setFlags] = useState(MINES);
  const [flagMode, setFlagMode] = useState(false);
  const [armed, setArmed] = useState(false);

  // Mines are laid on the FIRST tap, not at setup — and never under it or the
  // ring around it. Seeding at setup meant tap one could end the run before the
  // board had told you anything.
  const layMines = (source: Cell[][], safeR: number, safeC: number) => {
    const newBoard = source.map(row => row.map(cell => ({ ...cell })));
    const isSafe = (r: number, c: number) =>
      Math.abs(r - safeR) <= 1 && Math.abs(c - safeC) <= 1;

    let minesPlaced = 0;
    while (minesPlaced < MINES) {
      const r = Math.floor(Math.random() * ROWS);
      const c = Math.floor(Math.random() * COLS);
      if (!newBoard[r][c].isMine && !isSafe(r, c)) {
        newBoard[r][c].isMine = true;
        minesPlaced++;
      }
    }

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (!newBoard[r][c].isMine) {
          let count = 0;
          for (let i = -1; i <= 1; i++) {
            for (let j = -1; j <= 1; j++) {
              if (r + i >= 0 && r + i < ROWS && c + j >= 0 && c + j < COLS) {
                if (newBoard[r + i][c + j].isMine) count++;
              }
            }
          }
          newBoard[r][c].neighborMines = count;
        }
      }
    }
    return newBoard;
  };

  const initBoard = () => {
    const newBoard: Cell[][] = Array(ROWS).fill(null).map((_, r) =>
      Array(COLS).fill(null).map((_, c) => ({
        row: r, col: c, isMine: false, isRevealed: false, isFlagged: false, neighborMines: 0
      }))
    );

    setBoard(newBoard);
    setArmed(false);
    setGameOver(false);
    setWin(false);
    setFlags(MINES);
  };

  useEffect(() => { initBoard(); }, []);

  const revealCell = (r: number, c: number) => {
    if (gameOver || win || board[r][c].isRevealed || board[r][c].isFlagged) return;

    let newBoard = board.map(row => row.map(cell => ({ ...cell })));

    if (!armed) {
      newBoard = layMines(newBoard, r, c);
      setArmed(true);
    }

    if (newBoard[r][c].isMine) {
      newBoard[r][c].isRevealed = true;
      setBoard(newBoard);
      setGameOver(true);
      return;
    }

    const stack = [[r, c]];
    while (stack.length > 0) {
      const [currR, currC] = stack.pop()!;
      if (!newBoard[currR][currC].isRevealed && !newBoard[currR][currC].isFlagged) {
        newBoard[currR][currC].isRevealed = true;
        if (newBoard[currR][currC].neighborMines === 0) {
          for (let i = -1; i <= 1; i++) {
            for (let j = -1; j <= 1; j++) {
              const nr = currR + i;
              const nc = currC + j;
              if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) {
                stack.push([nr, nc]);
              }
            }
          }
        }
      }
    }

    setBoard(newBoard);

    // Check win
    let unrevealedSafe = 0;
    newBoard.forEach(row => row.forEach(cell => {
      if (!cell.isMine && !cell.isRevealed) unrevealedSafe++;
    }));
    if (unrevealedSafe === 0) setWin(true);
  };

  const toggleFlag = (e: React.MouseEvent, r: number, c: number) => {
    e.preventDefault();
    if (gameOver || win || board[r][c].isRevealed) return;
    const newBoard = [...board.map(row => [...row])];
    const cell = newBoard[r][c];
    if (!cell.isFlagged && flags > 0) {
      cell.isFlagged = true;
      setFlags(f => f - 1);
    } else if (cell.isFlagged) {
      cell.isFlagged = false;
      setFlags(f => f + 1);
    }
    setBoard(newBoard);
  };

  return (
    <div className="flex flex-col h-full items-center justify-center p-4">
      <div className="w-full max-w-[320px] flex justify-between items-end mb-4 rounded-2xl border px-4 py-3 backdrop-blur-md" style={{ backgroundColor: rawColors.panelBg, borderColor: rawColors.panelBorder }}>
        <div className="flex-1">
          <div className="text-[10px] uppercase tracking-widest opacity-60">Status</div>
          <div className="text-xl font-light leading-none mt-1">{win ? 'Cleared' : gameOver ? 'Breach' : 'Active'}</div>
        </div>
        <div className="flex-1 text-right">
          <div className="text-[10px] uppercase tracking-widest opacity-60">Flags</div>
          <div className="text-xl font-light leading-none mt-1 opacity-80 flex items-center justify-end gap-1"><Flag size={14}/> {flags}</div>
        </div>
      </div>

      <div className="flex justify-center gap-2 mb-4 w-full max-w-[320px]">
        <button 
          onClick={() => setFlagMode(false)} 
          className={cn("flex-1 py-2 rounded-lg border flex items-center justify-center gap-2 transition-all", !flagMode ? "opacity-100" : "opacity-40")}
          style={{ backgroundColor: rawColors.panelBg, backgroundImage: !flagMode ? `linear-gradient(0deg, ${rawColors.accent}33, ${rawColors.accent}33)` : undefined, borderColor: !flagMode ? rawColors.accent : rawColors.panelBorder }}
        >
          <Bomb size={16} style={{ color: !flagMode ? rawColors.accent : rawColors.textMain }} />
          <span className="text-xs font-medium">Reveal</span>
        </button>
        <button 
          onClick={() => setFlagMode(true)} 
          className={cn("flex-1 py-2 rounded-lg border flex items-center justify-center gap-2 transition-all", flagMode ? "opacity-100" : "opacity-40")}
          style={{ backgroundColor: rawColors.panelBg, backgroundImage: flagMode ? `linear-gradient(0deg, ${rawColors.accent}33, ${rawColors.accent}33)` : undefined, borderColor: flagMode ? rawColors.accent : rawColors.panelBorder }}
        >
          <Flag size={16} style={{ color: flagMode ? rawColors.accent : rawColors.textMain }} />
          <span className="text-xs font-medium">Flag</span>
        </button>
      </div>

      <div className="grid grid-cols-8 gap-1 w-full max-w-[320px] mb-6 rounded-2xl border p-2 backdrop-blur-md" style={{ backgroundColor: rawColors.panelBg, borderColor: rawColors.panelBorder }}>
        {board.map((row, r) => row.map((cell, c) => (
          <button
            key={`${r}-${c}`}
            onClick={(e) => {
              if (flagMode) toggleFlag(e, r, c);
              else revealCell(r, c);
            }}
            onContextMenu={(e) => toggleFlag(e, r, c)}
            className={cn(
              "w-full aspect-square rounded-sm flex items-center justify-center text-xs font-bold transition-colors",
              cell.isRevealed ? (cell.isMine ? colors.userBubbleText : "bg-transparent") : "hover:opacity-80",
              !cell.isRevealed && "border"
            )}
            style={{ 
              backgroundColor: !cell.isRevealed ? `${rawColors.accent}26` : (cell.isRevealed && cell.isMine ? rawColors.accent : undefined),
              borderColor: !cell.isRevealed ? `${rawColors.accent}50` : undefined,
              color: cell.isRevealed && !cell.isMine && cell.neighborMines > 0 ? rawColors.accent : undefined,
              opacity: cell.isRevealed && !cell.isMine && cell.neighborMines === 0 ? 0.2 : 1
            }}
          >
            {cell.isRevealed ? (
              cell.isMine ? <Bomb size={16} /> : (cell.neighborMines > 0 ? cell.neighborMines : '')
            ) : (
              cell.isFlagged ? <Flag size={14} style={{ color: rawColors.accent }} /> : ''
            )}
          </button>
        )))}
      </div>

      <div className="h-12">
        {(gameOver || win) && (
          <motion.button 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            onClick={initBoard}
            className={cn("px-6 py-3 rounded-[var(--shape-control)] font-medium text-sm flex items-center gap-2 hover:scale-105 transition-transform", "text-white")}
            style={{ backgroundColor: rawColors.accent, color: rawColors.accentText }}
          >
            <RotateCcw size={16} /> Restart Scan
          </motion.button>
        )}
      </div>
    </div>
  );
}
