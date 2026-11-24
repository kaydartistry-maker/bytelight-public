// The Mind console's hallway rules: which requests the phone's Mind app may
// pass through to the brain's own web API (Neuralis /api/*).
//
// Every read of a known room goes through. Writes go through only when they
// are on WRITES by name: the console can resolve a thread or sit with a
// feeling, but it cannot fire the brain's crons, rerun its processing, or
// bulk-load observations. Anything not named here is refused.

export const READ_ROOMS = new Set<string>([
  'entities', 'observations', 'journals', 'dreams', 'threads', 'identity',
  'relations', 'images', 'context', 'search', 'surface', 'orient', 'ground',
  'health', 'health-scores', 'stats', 'heat', 'recent', 'inner-weather',
  'patterns', 'personality', 'tensions', 'proposals', 'dormant', 'isolated',
  'archive', 'emergence', 'taxonomy', 'know', 'soul', 'feelings', 'cortex',
]);

// ':id' stands for any one plain segment (an id, a name, a section).
type WriteRule = { method: string; path: string[] };

export const WRITES: WriteRule[] = [
  // threads
  { method: 'POST', path: ['threads'] },
  { method: 'POST', path: ['threads', ':id', 'resolve'] },
  { method: 'PUT', path: ['threads', ':id'] },
  { method: 'DELETE', path: ['threads', ':id'] },
  // observations (feelings and notes)
  { method: 'POST', path: ['observations', ':id', 'sit'] },
  { method: 'POST', path: ['observations', ':id', 'resolve'] },
  { method: 'PUT', path: ['observations', ':id'] },
  { method: 'DELETE', path: ['observations', ':id'] },
  // entities and how they connect
  { method: 'PUT', path: ['entities', ':id'] },
  { method: 'POST', path: ['entities', 'merge'] },
  { method: 'DELETE', path: ['entities', ':id'] },
  { method: 'PUT', path: ['relations', ':id'] },
  { method: 'DELETE', path: ['relations', ':id'] },
  // journals and dreams
  { method: 'PUT', path: ['journals', ':id'] },
  { method: 'DELETE', path: ['journals', ':id'] },
  { method: 'PUT', path: ['dreams', ':id'] },
  { method: 'POST', path: ['dreams', ':id', 'recall'] },
  { method: 'POST', path: ['dreams', ':id', 'anchor'] },
  { method: 'DELETE', path: ['dreams', ':id'] },
  // identity can be edited, never deleted from here
  { method: 'PUT', path: ['identity', ':id'] },
  // tensions
  { method: 'POST', path: ['tensions', ':id', 'resolve'] },
  { method: 'POST', path: ['tensions', ':id', 'visit'] },
  { method: 'DELETE', path: ['tensions', ':id'] },
  // proposals the brain makes about itself
  { method: 'POST', path: ['proposals', ':id', 'accept'] },
  { method: 'POST', path: ['proposals', ':id', 'reject'] },
  // what has gone quiet, been archived, or sits alone
  { method: 'POST', path: ['dormant', ':id', 'surface'] },
  { method: 'POST', path: ['dormant', ':id', 'archive'] },
  { method: 'POST', path: ['archive', ':id', 'rescue'] },
  // the brain takes the name in the body here, not in the path
  { method: 'POST', path: ['isolated', 'connect'] },
  { method: 'POST', path: ['isolated', 'ignore'] },
];

const SEGMENT = /^[A-Za-z0-9_.:@-]+$/;

/** Splits a console path into plain segments, or null if any segment is unsafe. */
export function consoleSegments(path: string): string[] | null {
  const parts = path.split('/').filter((p) => p.length > 0);
  if (parts.length === 0 || parts.length > 5) return null;
  const out: string[] = [];
  for (const raw of parts) {
    let seg: string;
    try { seg = decodeURIComponent(raw); } catch { return null; }
    if (!SEGMENT.test(seg) || seg === '.' || seg === '..') return null;
    out.push(seg);
  }
  return out;
}

function matches(rule: string[], segs: string[]): boolean {
  if (rule.length !== segs.length) return false;
  return rule.every((r, i) => r === ':id' || r === segs[i]);
}

/** May the console send this request on to the brain? */
export function consoleAllows(method: string, segs: string[]): boolean {
  const m = method.toUpperCase();
  if (!READ_ROOMS.has(segs[0])) return false;
  if (m === 'GET') return true;
  return WRITES.some((w) => w.method === m && matches(w.path, segs));
}
