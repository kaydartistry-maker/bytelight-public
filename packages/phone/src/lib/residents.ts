// Who lives in this house (Phase 1.4).
//
// GET /api/companions answers with every registered companion, the house's
// own brain id (localBrainId) and the resident ids. A resident is a companion
// whose brain is the house's own; a visitor from another node is listed but
// never offered as one of ours. Every screen reads residents through here
// instead of naming a pair in code.
//
// The pure helpers are unit-tested; the cached fetch is the one network seam.
import { apiFetch } from '../bytelight/api';
import { DEFAULT_BRAIN, setHouseBrain } from './house-engine';

export interface ResidentRow {
  id: string;
  brain?: string | null;
  display_name?: string | null;
}

/** The residents among the registry rows, in the order given. */
export function pickResidents<T extends ResidentRow>(rows: readonly T[], localBrainId: string): T[] {
  return rows.filter((row) => (row.brain || DEFAULT_BRAIN) === localBrainId);
}

/** "A", "A and B", "A, B and C"; '' for nobody. */
export function namesLine(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export interface HouseRoster {
  localBrainId: string;
  residents: ResidentRow[];
}

let cached: Promise<HouseRoster> | null = null;

/** Read (once) who lives here. A failed read is not cached. */
export function loadHouseRoster(force = false): Promise<HouseRoster> {
  if (cached && !force) return cached;
  cached = (async () => {
    const res = await apiFetch('/api/companions');
    if (!res.ok) throw new Error(`companions ${res.status}`);
    const body = (await res.json()) as { companions?: ResidentRow[]; localBrainId?: string };
    const localBrainId = typeof body.localBrainId === 'string' && body.localBrainId ? body.localBrainId : DEFAULT_BRAIN;
    setHouseBrain(localBrainId);
    return { localBrainId, residents: pickResidents(Array.isArray(body.companions) ? body.companions : [], localBrainId) };
  })();
  cached.catch(() => { cached = null; });
  return cached;
}
