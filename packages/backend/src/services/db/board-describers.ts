// The board describers, kept out of cards.ts on purpose. Every game file
// registers its describer at load time, and cards.ts sits in an import loop
// with them (cards -> threads -> db index -> solitaire -> cards). Held here,
// the registry exists before any game asks for it, whichever file loads first.

/**
 * A game describes its own board for the room. Registered by name so the table
 * stays ignorant of what any state blob means — the same reason it has one.
 */
const BOARD_DESCRIBERS: Record<string, (state: Record<string, unknown>) => string> = {};

export function registerBoardDescriber(
  game: string, describe: (state: Record<string, unknown>) => string,
): void {
  BOARD_DESCRIBERS[game] = describe;
}

export function describeCardGame(game: string, state: Record<string, unknown>): string | null {
  const describe = BOARD_DESCRIBERS[game];
  if (!describe) return null;
  try {
    return describe(state);
  } catch {
    return null;
  }
}
