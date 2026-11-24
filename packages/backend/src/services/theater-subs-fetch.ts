// The Theater — finding a night's subtitles on its own (OpenSubtitles).
//
// As she types a title (and a season and episode for a show) on the start
// form, the phone asks the house to search OpenSubtitles (free) and shows the
// best English match under the fields. Tapping Start downloads that match
// (the one download that counts) and loads it onto the night exactly as her
// own .srt/.vtt upload would (readSubtitleFile + setSubtitles). Her
// "Load .srt/.vtt" stays the fallback. The key never leaves the house.
//
// Searches are free; downloads are capped per day by OpenSubtitles, so:
//  - a night that already has subtitles is never downloaded for again,
//  - what the search found is kept on the night (best first), and every file
//    downloaded is remembered, so "Try another" takes the next untried one
//    without searching again,
//  - out of downloads (406/429) is said plainly and the night stays usable.
//
// The key is the `opensubtitles_api_key` secret, read at call time and never
// logged. fetch is passed in so tests never touch the network.

import { readSubtitleFile, SubtitleError } from './theater-subtitles.js';
import {
  TheaterError,
  getNight,
  noteSubtitleSearch,
  refuseComputerSubtitles,
  setSubtitles,
  theaterDir,
  untriedCandidates,
  type SubtitleCandidate,
  type TheaterNight,
} from './theater.js';
import { getSecret } from './secrets.js';

export const OPENSUBTITLES_API = 'https://api.opensubtitles.com/api/v1';
const USER_AGENT = 'BytelightTheater v1.0';
const TIMEOUT_MS = 20_000;
/** How many found files a night keeps to try. */
const KEEP_CANDIDATES = 20;
/** A search is kept this long, so the form's search and Start's ask OpenSubtitles once. */
const SEARCH_CACHE_MS = 10 * 60_000;

export const SUBS_MESSAGES = {
  noKey: 'Subtitle search is not set up yet (add an OpenSubtitles API key in Keys). Load a file instead.',
  badKey: 'OpenSubtitles refused the API key (check it in Keys). Load a file instead.',
  quota: 'Out of subtitle downloads for today — load a file instead.',
  unreachable: 'The subtitle search could not be reached just now. Try again, or load a file instead.',
  halfEpisode: 'To find subtitles for a show, give both the season and the episode. Or load a file instead.',
  noOthers: 'No other subtitles turned up for this one. Load a file instead.',
  unreadable: 'Those subtitles came down but would not read. Try another, or load a file instead.',
} as const;

export type SubsFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface SubsDeps {
  fetchImpl?: SubsFetch;
  /** The API key; defaults to the secrets store, read now. */
  apiKey?: () => string | undefined;
  root?: string;
}

class Unreachable extends Error {}

function headersFor(key: string, json = false): Record<string, string> {
  return {
    'Api-Key': key,
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

/** The search URL for a night. Params sorted and lower-cased, as OpenSubtitles asks (fewer redirects). */
export function searchUrl(night: Pick<TheaterNight, 'title' | 'season' | 'episode'>): string {
  const episodic = night.season !== null && night.episode !== null;
  const params: Array<[string, string]> = [
    ['languages', 'en'],
    ['query', night.title.trim().toLowerCase()],
    ['type', episodic ? 'episode' : 'movie'],
  ];
  if (episodic) {
    params.push(['episode_number', String(night.episode)], ['season_number', String(night.season)]);
  }
  params.sort(([a], [b]) => a.localeCompare(b));
  return `${OPENSUBTITLES_API}/subtitles?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

interface SearchAttributes {
  language?: unknown;
  download_count?: unknown;
  release?: unknown;
  foreign_parts_only?: unknown;
  feature_details?: { feature_type?: unknown; title?: unknown; parent_title?: unknown; season_number?: unknown; episode_number?: unknown } | null;
  files?: Array<{ file_id?: unknown; file_name?: unknown }> | null;
}

/**
 * Keep the results that are this night's: English, the exact season and
 * episode for a show (not an episode for a movie), one whole file (not a
 * CD1/CD2 split), not "foreign parts only". Most downloaded first.
 */
export function rankCandidates(data: unknown, night: Pick<TheaterNight, 'season' | 'episode'>): SubtitleCandidate[] {
  const rows = (data as { data?: Array<{ attributes?: SearchAttributes }> } | null)?.data;
  if (!Array.isArray(rows)) return [];
  const episodic = night.season !== null && night.episode !== null;
  const seen = new Set<number>();
  const out: SubtitleCandidate[] = [];
  for (const row of rows) {
    const a = row?.attributes;
    if (!a) continue;
    if (typeof a.language === 'string' && a.language.toLowerCase() !== 'en') continue;
    if (a.foreign_parts_only === true) continue;
    const fd = a.feature_details ?? {};
    if (episodic) {
      if (Number(fd.season_number) !== night.season || Number(fd.episode_number) !== night.episode) continue;
    } else if (typeof fd.feature_type === 'string' && fd.feature_type.toLowerCase() === 'episode') {
      continue;
    }
    const files = Array.isArray(a.files) ? a.files : [];
    if (files.length !== 1) continue;
    const fileId = Number(files[0]?.file_id);
    if (!Number.isInteger(fileId) || fileId <= 0 || seen.has(fileId)) continue;
    seen.add(fileId);
    const fileName = typeof files[0]?.file_name === 'string' ? files[0].file_name : null;
    const release = typeof a.release === 'string' && a.release.trim() ? a.release.trim() : fileName ?? `Subtitles ${fileId}`;
    const downloads = Number(a.download_count);
    const show = [fd.parent_title, fd.title].find((t): t is string => typeof t === 'string' && t.trim() !== '')?.trim() ?? '';
    const where = episodic ? `S${String(night.season).padStart(2, '0')}E${String(night.episode).padStart(2, '0')}` : '';
    const label = [[show, where].filter(Boolean).join(' '), release].filter(Boolean).join(' · ');
    out.push({ fileId, release, fileName, downloads: Number.isFinite(downloads) ? downloads : 0, label });
  }
  return out.sort((x, y) => y.downloads - x.downloads).slice(0, KEEP_CANDIDATES);
}

const searchCache = new Map<string, { at: number; candidates: SubtitleCandidate[] }>();

/** Forget kept searches (tests). */
export function clearSubtitleSearchCache(): void {
  searchCache.clear();
}

async function search(what: SubsQuery, key: string, fetchImpl: SubsFetch, now = Date.now()): Promise<SubtitleCandidate[]> {
  const url = searchUrl(what);
  const kept = searchCache.get(url);
  if (kept && now - kept.at < SEARCH_CACHE_MS) return kept.candidates;
  let res: Awaited<ReturnType<SubsFetch>>;
  try {
    res = await fetchImpl(url, { headers: headersFor(key), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new Unreachable();
  }
  if (res.status === 401 || res.status === 403) throw new TheaterError(503, SUBS_MESSAGES.badKey);
  if (!res.ok) throw new Unreachable();
  const candidates = rankCandidates(await res.json().catch(() => null), what);
  for (const [k, v] of searchCache) if (now - v.at >= SEARCH_CACHE_MS) searchCache.delete(k);
  searchCache.set(url, { at: now, candidates });
  return candidates;
}

export type SubsQuery = Pick<TheaterNight, 'title' | 'season' | 'episode'>;

function apiKeyOf(deps: SubsDeps): string {
  const key = (deps.apiKey ?? (() => getSecret('opensubtitles_api_key')))();
  if (!key) throw new TheaterError(503, SUBS_MESSAGES.noKey);
  return key;
}

function checkQuery(what: SubsQuery): void {
  if (!what.title.trim()) throw new TheaterError(400, 'What are we watching? A title is needed.');
  if ((what.season === null) !== (what.episode === null)) throw new TheaterError(400, SUBS_MESSAGES.halfEpisode);
}

/**
 * Search only (free, nothing downloaded): what the start form shows under
 * the fields as she types. Best first; empty when nothing matched.
 */
export async function searchSubtitles(what: SubsQuery, deps: SubsDeps = {}): Promise<SubtitleCandidate[]> {
  checkQuery(what);
  const key = apiKeyOf(deps);
  try {
    return await search(what, key, deps.fetchImpl ?? (fetch as unknown as SubsFetch));
  } catch (err) {
    if (err instanceof Unreachable) throw new TheaterError(502, SUBS_MESSAGES.unreachable);
    throw err;
  }
}

function isQuota(status: number, body: unknown): boolean {
  if (status === 406 || status === 429) return true;
  const b = body as { remaining?: unknown; message?: unknown } | null;
  if (typeof b?.remaining === 'number' && b.remaining < 0) return true;
  return false;
}

/** Ask for a file's download link. This is the call that spends one of the day's downloads. */
async function downloadLink(fileId: number, key: string, fetchImpl: SubsFetch): Promise<string> {
  let res: Awaited<ReturnType<SubsFetch>>;
  try {
    res = await fetchImpl(`${OPENSUBTITLES_API}/download`, {
      method: 'POST',
      headers: headersFor(key, true),
      body: JSON.stringify({ file_id: fileId }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Unreachable();
  }
  const body = await res.json().catch(() => null) as { link?: unknown } | null;
  if (isQuota(res.status, body)) throw new TheaterError(429, SUBS_MESSAGES.quota);
  if (res.status === 401 || res.status === 403) throw new TheaterError(503, SUBS_MESSAGES.badKey);
  if (!res.ok || typeof body?.link !== 'string') throw new Unreachable();
  return body.link;
}

/** The raw subtitle text behind a download link (free). */
async function fetchFile(link: string, fetchImpl: SubsFetch): Promise<string> {
  let file: Awaited<ReturnType<SubsFetch>>;
  try {
    file = await fetchImpl(link, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new Unreachable();
  }
  if (!file.ok) throw new Unreachable();
  return file.text();
}

function nothingFound(night: TheaterNight): string {
  const ep = night.season !== null && night.episode !== null ? ` S${night.season}·E${night.episode}` : '';
  return `No English subtitles turned up for ${night.title}${ep}. Check the title, or load a file instead.`;
}

async function find(id: string, another: boolean, preferFileId: number | null, deps: SubsDeps): Promise<TheaterNight> {
  const root = deps.root ?? theaterDir();
  const fetchImpl = deps.fetchImpl ?? (fetch as unknown as SubsFetch);
  let night = getNight(id, root);
  if (!night) throw new TheaterError(404, 'There is no theater night with that id.');
  if (night.status !== 'live') throw new TheaterError(409, 'That night is over; the credits already rolled.');
  // A computer night hears its lines through the Ear: never spend a download on it.
  refuseComputerSubtitles(night);

  // A night with subtitles is never downloaded for again, unless she asks for another.
  if (!another && night.cues.length > 0) return night;

  let key: string;
  try {
    checkQuery(night);
    key = apiKeyOf(deps);
  } catch (err) {
    noteSubtitleSearch(id, { searchedAt: new Date().toISOString() }, root);
    throw err;
  }

  try {
    let pool = untriedCandidates(night);
    if (!night.subtitleCandidates || night.subtitleCandidates.length === 0) {
      const found = await search(night, key, fetchImpl);
      night = noteSubtitleSearch(id, { candidates: found, searchedAt: new Date().toISOString() }, root);
      pool = untriedCandidates(night);
      if (found.length === 0) throw new TheaterError(404, nothingFound(night));
    } else {
      night = noteSubtitleSearch(id, { searchedAt: new Date().toISOString() }, root);
    }
    // The match she saw under the start form, when it's still untried; otherwise the best left.
    const next = pool?.find((c) => c.fileId === preferFileId) ?? pool?.[0];
    if (!next) throw new TheaterError(404, SUBS_MESSAGES.noOthers);

    const link = await downloadLink(next.fileId, key, fetchImpl);
    // The download is spent whatever the file turns out to be: never ask for it again.
    night = noteSubtitleSearch(id, { tried: [...(night.subtitleTried ?? []), next.fileId] }, root);
    const text = await fetchFile(link, fetchImpl);
    let cues;
    try {
      cues = readSubtitleFile(Buffer.from(text, 'utf8'));
    } catch (err) {
      if (err instanceof SubtitleError) throw new TheaterError(422, SUBS_MESSAGES.unreadable);
      throw err;
    }
    return setSubtitles(id, cues, next.release, root, 'opensubtitles');
  } catch (err) {
    if (err instanceof Unreachable) throw new TheaterError(502, SUBS_MESSAGES.unreachable);
    throw err;
  }
}

const inFlight = new Map<string, Promise<TheaterNight>>();

/**
 * Find and load subtitles for a live night. `another` swaps in the next
 * untried file (wrong cut, drifting timing); `fileId` picks the match she
 * saw on the start form. One look per night at a time:
 * a second ask while one is out waits for the same answer, so a double tap
 * never spends two downloads.
 */
export function findSubtitles(id: string, opts: { another?: boolean; fileId?: number | null } = {}, deps: SubsDeps = {}): Promise<TheaterNight> {
  const running = inFlight.get(id);
  if (running) return running;
  const job = find(id, Boolean(opts.another), opts.fileId ?? null, deps).finally(() => inFlight.delete(id));
  inFlight.set(id, job);
  return job;
}
