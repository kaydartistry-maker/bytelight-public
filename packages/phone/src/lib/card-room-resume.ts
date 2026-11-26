// Which game the Card Room reopens onto when it loads.

export type RoomTab = 'klondike' | 'ratscrew' | 'golf' | 'eights' | 'president' | 'hearts' | 'spades' | 'euchre';

export interface ResumableTable {
  game: string;
  status: string;
  updatedAt?: string | null;
}

/** Which game tab to reopen onto, or null for the bare table. No table, an
 *  old game, a finished one or an unknown game name all open on the bare
 *  table; only a game somebody touched in the last 12 hours is picked back
 *  up (an old table left 'playing' would drag the owner into a game they
 *  had already walked away from). */
export function resumeTab(table: ResumableTable | null | undefined, now = Date.now()): RoomTab | null {
  if (!table || table.status !== 'playing') return null;
  // The table stores 'rat-screw'; this room's tab is 'ratscrew'. Map
  // explicitly — an unknown game name stays on the bare table.
  const tab: RoomTab | null = table.game === 'rat-screw' ? 'ratscrew'
    : table.game === 'golf' ? 'golf'
    : table.game === 'eights' ? 'eights'
    : table.game === 'president' ? 'president'
    : table.game === 'hearts' ? 'hearts'
    : table.game === 'spades' ? 'spades'
    : table.game === 'euchre' ? 'euchre'
    : table.game === 'klondike' ? 'klondike'
    : null;
  if (!tab) return null;
  const touched = Date.parse(table.updatedAt ?? '');
  const recent = Number.isFinite(touched) && now - touched < 12 * 60 * 60 * 1000;
  return recent ? tab : null;
}
