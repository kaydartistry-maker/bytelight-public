// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
//
// What the Compactions page decides, kept apart from the page so it can be
// checked without a browser: how it reads the house's answer, how it drains a
// long list for the page numbers, and where a full summary comes from.
//
// Two houses answer this page. Since Oct 21 2026 the house serves it from its
// shelf: each row has an id, says whose head the squash came from, and
// previews the part of the summary that changes, and the full text has its own
// address. The house from before that (running until the owner restart) answers the
// same address with every row carrying the first four hundred characters of
// its summary, and opens one by sending them all in full. Both are read here,
// and every answer is checked for its shape before it is believed: an older
// house answers an address it does not have with the app's own page, not JSON.

export type PreviewSource = 'current-work' | 'next-step' | 'pending-tasks' | 'tail';

export interface CompactionRow {
  /** Unique on the page: the id, or the session and stamp for an older house. */
  key: string;
  /** The shelf's id; null from an older house, which has none. */
  id: string | null;
  sessionId: string;
  project: string;
  at: string;
  chars: number;
  /** Whose head the squash came from, ready to show. */
  whose: string;
  /** What to show before it is opened. */
  preview: string;
  /** Which part of the summary the preview is; null when it is just the top (an older house). */
  previewFrom: PreviewSource | null;
  /** True when the preview is the top of a longer summary that has to be fetched to be read whole. */
  cut: boolean;
}

export interface CompactionList {
  rows: CompactionRow[];
  hasMore: boolean;
  /** The house was still reading transcripts when it answered. */
  reading: boolean;
}

export type Fetcher = (url: string) => Promise<Response>;

/** Rows asked for at a time. The rows are light (no summaries), so a few asks cover a long history. */
export const FETCH_SIZE = 200;
/** A house that keeps saying there is more is stopped here. */
export const MAX_FETCHES = 10;

const PREVIEW_SOURCES: readonly PreviewSource[] = ['current-work', 'next-step', 'pending-tasks', 'tail'];

/**
 * A lane folder's project name, read as a room. The project is the lane's
 * path with every other character turned into a dash, so the lane is whatever
 * follows data-heartbeat-. Only an older house needs this; a new one says
 * whose head it was itself.
 */
export function laneName(project: string): string {
  const m = /-data-heartbeat-(.+)$/.exec(project);
  if (!m) return 'Lane';
  const lane = m[1];
  if (lane === 'primary') return 'Shared room';
  if (/^[0-9a-f]{8}-/.test(lane)) return `Lane ${lane.slice(0, 8)}`;
  return `Lane ${lane.replace(/-/g, ' ')}`;
}

/** Only a house lane's project folder; an older house also listed strays such as the system tmp folder. */
function isLaneProject(project: string): boolean {
  return /-data-heartbeat-[A-Za-z0-9]/.test(project);
}

/** What the page says the preview is, in their words. */
export function previewLabel(from: PreviewSource | null): string | null {
  switch (from) {
    case 'current-work': return 'In the middle of';
    case 'next-step': return 'Next up';
    case 'pending-tasks': return 'Still to do';
    case 'tail': return 'Where it ended';
    default: return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rowOf(raw: unknown): CompactionRow | null {
  if (!isRecord(raw)) return null;
  const { sessionId, project, at, chars } = raw;
  if (typeof sessionId !== 'string' || typeof project !== 'string' || typeof at !== 'string') return null;
  if (typeof chars !== 'number' || !Number.isFinite(chars)) return null;
  // The house of today: an id, whose head, and a preview of what was changing.
  if (typeof raw.id === 'string' && raw.id && typeof raw.preview === 'string') {
    const from = PREVIEW_SOURCES.find((s) => s === raw.previewFrom) ?? null;
    return {
      key: raw.id,
      id: raw.id,
      sessionId,
      project,
      at,
      chars,
      whose: typeof raw.whose === 'string' && raw.whose ? raw.whose : laneName(project),
      preview: raw.preview,
      previewFrom: from,
      cut: false,
    };
  }
  // The house from before the owner restart: the top of the summary, and no strays.
  if (typeof raw.summary !== 'string' || !isLaneProject(project)) return null;
  return {
    key: `${sessionId}|${at}`,
    id: null,
    sessionId,
    project,
    at,
    chars,
    whose: laneName(project),
    preview: raw.summary,
    previewFrom: null,
    cut: raw.truncated === true,
  };
}

/** The house's list, or null when the answer is not one (an older house's app page, an error). */
export function rowsFrom(data: unknown): CompactionList | null {
  if (!isRecord(data) || !Array.isArray(data.compactions)) return null;
  const rows: CompactionRow[] = [];
  for (const raw of data.compactions) {
    const row = rowOf(raw);
    if (row) rows.push(row);
  }
  return { rows, hasMore: data.hasMore === true, reading: data.reading === true };
}

async function jsonFrom(fetcher: Fetcher, url: string): Promise<unknown> {
  try {
    const res = await fetcher(url);
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

export interface LoadedCompactions {
  rows: CompactionRow[];
  reading: boolean;
}

/**
 * Every squash on the shelf, newest first, a page of the house's at a time,
 * so the page numbers count all of them. An older house never says there is
 * more, so it is asked once. Null only when the first answer is not the
 * house's list; a later page that fails keeps what came before it.
 */
export async function loadCompactionList(fetcher: Fetcher): Promise<LoadedCompactions | null> {
  const rows: CompactionRow[] = [];
  const keys = new Set<string>();
  let reading = false;
  let offset = 0;
  for (let ask = 0; ask < MAX_FETCHES; ask++) {
    const data = await jsonFrom(fetcher, `/api/compactions?limit=${FETCH_SIZE}&offset=${offset}`);
    const page = rowsFrom(data);
    if (!page) return ask === 0 ? null : { rows, reading };
    if (ask === 0) reading = page.reading;
    for (const row of page.rows) {
      // A squash shelved between two asks moves the rest down by one.
      if (keys.has(row.key)) continue;
      keys.add(row.key);
      rows.push(row);
    }
    const served = isRecord(data) && Array.isArray(data.compactions) ? data.compactions.length : 0;
    if (!page.hasMore || served === 0) break;
    offset += served;
  }
  return { rows, reading };
}

/** The rows alone, for a caller that has nothing to say about a read still going. */
export async function loadCompactions(fetcher: Fetcher): Promise<CompactionRow[] | null> {
  return (await loadCompactionList(fetcher))?.rows ?? null;
}

/**
 * One summary in full, for when the owner opens it: from its own address on the
 * house of today, or the old way (every summary in full, matched by session
 * and stamp) on the house from before the owner restart. Null when it cannot be had;
 * the preview is still on the row.
 */
export async function loadSummary(fetcher: Fetcher, row: CompactionRow): Promise<string | null> {
  if (row.id) {
    const data = await jsonFrom(fetcher, `/api/compactions/${encodeURIComponent(row.id)}`);
    if (isRecord(data) && isRecord(data.compaction) && typeof data.compaction.summary === 'string') {
      return data.compaction.summary;
    }
    return null;
  }
  // An older house sent the whole of a short summary in the list already.
  if (!row.cut) return row.preview;
  const data = await jsonFrom(fetcher, '/api/compactions?limit=200&full=1');
  if (!isRecord(data) || !Array.isArray(data.compactions)) return null;
  for (const raw of data.compactions) {
    if (isRecord(raw) && raw.sessionId === row.sessionId && raw.at === row.at && typeof raw.summary === 'string') {
      return raw.summary;
    }
  }
  return null;
}

/** When it happened, in their phone's own time. */
export function whenLabel(at: string): string {
  if (!at) return 'undated';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  return d.toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}
