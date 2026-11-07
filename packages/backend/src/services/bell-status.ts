// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
/**
 * The word under the faces (Oct 20 2026; and then "Maybe it could update? Like if you're out on a date? Idk .. I don't want to make it too personal in the kit and levels").
 *
 * A bell may carry a status word, as a setting: `cron.<wakeType>.status_word`.
 * While that bell's turn is running, its word is up, and the phone shows it
 * beside the one dot under the faces at the top of a conversation and on the
 * contact cards of the companions the bell belongs to (every companion's,
 * for a bell that belongs to the house). With no bell's word up the phone
 * says Home. The words are theirs, as data; nothing here names one, so the kit
 * and Levels ship the mechanism and Home only.
 *
 * Bells can overlap (a spontaneous wake while a date bell is out), so every
 * bell that is running is kept, and the word up is the newest one that has a
 * word. Every change is said to every phone at once, and a phone that
 * connects is told the word as it stands (services/ws.ts).
 */
import type { ServerMessage } from '@bytelight/shared';
import { getConfig } from './db.js';
import { registry } from './registry.js';

/** The longest status word kept, in letters: it sits on one line under three faces. */
export const STATUS_WORD_LONGEST = 24;

/** The setting a bell's status word lives in. */
export function statusWordKey(wakeType: string): string {
  return `cron.${wakeType}.status_word`;
}

/** A status word as the owner would see it: one line, spaces tidied, never past the longest; null for none. */
export function statusWordOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const word = raw.replace(/\s+/g, ' ').trim();
  if (!word) return null;
  return [...word].slice(0, STATUS_WORD_LONGEST).join('').trim();
}

export interface StatusWordNow {
  /** The word up now, or null (the phone says Home). */
  word: string | null;
  /** Whose contact cards it shows on: the bell's owners' slugs, or empty for every companion's. */
  companions: string[];
}

export interface BellStatusDeps {
  /** A bell's word, as set. */
  readWord?: (wakeType: string) => string | null;
  /** Says the word to every phone. */
  broadcast?: (message: ServerMessage) => void;
}

export function createBellStatus(deps: BellStatusDeps = {}) {
  const readWord = deps.readWord ?? ((wakeType: string) => {
    try {
      return getConfig(statusWordKey(wakeType));
    } catch {
      return null;
    }
  });
  const broadcast = deps.broadcast ?? ((message: ServerMessage) => registry.broadcast(message));
  const running: Array<{ id: number; word: string | null; companions: string[] }> = [];
  let next = 0;
  let said = '';

  const now = (): StatusWordNow => {
    for (let i = running.length - 1; i >= 0; i--) {
      const bell = running[i];
      if (bell.word) return { word: bell.word, companions: [...bell.companions] };
    }
    return { word: null, companions: [] };
  };
  const tell = () => {
    const current = now();
    const key = JSON.stringify(current);
    if (key === said) return;
    said = key;
    try {
      broadcast({ type: 'status_word', ...current });
    } catch {
      // A phone that cannot be told now is told the word when it next connects.
    }
  };

  return {
    now,
    /**
     * A bell's turn is starting: its word (if it has one) goes up for the
     * bell's owners. Answers how to take it down, once, when the turn is over.
     */
    begin(wakeType: string, owners: string[] = []): () => void {
      const id = ++next;
      running.push({ id, word: statusWordOf(readWord(wakeType)), companions: [...new Set(owners)] });
      tell();
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const at = running.findIndex((bell) => bell.id === id);
        if (at >= 0) running.splice(at, 1);
        tell();
      };
    },
  };
}

export type BellStatus = ReturnType<typeof createBellStatus>;

let house: BellStatus | null = null;

/** The house's own, made on first use. */
export function bellStatus(): BellStatus {
  if (!house) house = createBellStatus();
  return house;
}
