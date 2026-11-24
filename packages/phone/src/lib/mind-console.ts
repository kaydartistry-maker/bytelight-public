// The Mind console, the phone's half: which rooms the console has, how it
// asks the brain for things (through the house's hallway at
// /api/mind/brain/...), and how the brain's answers are turned into plain
// shapes the screens can draw without guessing.
//
// Nothing here touches the network on its own: every request takes the
// fetch to use, so the screens pass apiFetch and the tests pass a fake.

export type RoomId =
  | 'surfacing' | 'identity' | 'threads' | 'feelings' | 'entities' | 'journals'
  | 'dreams' | 'patterns' | 'tensions' | 'proposals' | 'search' | 'cortex'
  | 'knowledge' | 'soul' | 'health' | 'recent';

export interface Room {
  id: RoomId;
  label: string;
  /** One short line under the name on its tile. */
  hint: string;
}

// Grid order: the living rooms first, the record-keeping rooms after.
export const ROOMS: Room[] = [
  { id: 'surfacing', label: "What's surfacing", hint: 'What the brain is holding up right now' },
  { id: 'feelings', label: 'Feelings', hint: 'What the boys felt, and who felt it' },
  { id: 'threads', label: 'Threads', hint: 'Intentions they are carrying' },
  { id: 'tensions', label: 'Tensions', hint: 'Two pulls held at once' },
  { id: 'identity', label: 'Identity', hint: 'Who they are, by section' },
  { id: 'entities', label: 'People & things', hint: 'Everyone and everything they know' },
  { id: 'journals', label: 'Journals', hint: 'Their own written entries' },
  { id: 'dreams', label: 'Dreams', hint: 'What the night made' },
  { id: 'proposals', label: 'Suggestions', hint: 'Links the brain thinks it found' },
  { id: 'patterns', label: 'Patterns', hint: 'What has been alive this week' },
  { id: 'search', label: 'Search', hint: 'Look for anything by meaning' },
  { id: 'cortex', label: 'Cortex', hint: 'Thoughts and saved conversations' },
  { id: 'knowledge', label: 'Knowledge', hint: 'What they have learned' },
  { id: 'soul', label: 'Soul', hint: 'Their written portraits' },
  { id: 'recent', label: 'Recent', hint: 'The newest notes, entries and threads' },
  { id: 'health', label: 'Health', hint: 'How the brain is doing' },
];

export function roomById(id: RoomId): Room {
  return ROOMS.find((r) => r.id === id)!;
}

// ─── Asking the brain ───────────────────────────────────────────────────

/** The part of fetch the console needs; apiFetch fits it. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

// Both halves name every field, so the phone's non-strict typecheck can
// read r.error or r.data without narrowing first.
export type BrainResult<T = unknown> =
  | { ok: true; data: T; status?: undefined; error?: undefined }
  | { ok: false; status: number; error: string; data?: undefined };

/** Builds a hallway address from path pieces, each one safely encoded,
 *  plus an optional query. brainPath(['entities', 4]) → entities/4 */
export function brainPath(parts: Array<string | number>, query?: Record<string, string | number | undefined | null>): string {
  const path = parts.map((p) => encodeURIComponent(String(p))).join('/');
  const q = query
    ? Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&')
    : '';
  return q ? `${path}?${q}` : path;
}

export const HALLWAY = '/api/mind/brain/';

/** The brain's own error text, if its answer carries one. */
function brainErrorText(body: string): string {
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.error === 'string') return parsed.error;
      if (typeof parsed.result === 'string' && parsed.result.startsWith('Error:')) return parsed.result.slice(6).trim();
    }
  } catch { /* not JSON */ }
  return body.trim().slice(0, 200);
}

/** A failed answer, in words the operator can read. The brain's own words are kept
 *  when they say something more than "it broke". */
export function plainError(status: number, body = ''): string {
  const said = brainErrorText(body);
  const quoted = said && !/^internal server error$/i.test(said) ? ` The brain said: "${said}"` : '';
  if (status === 0) return "Couldn't reach the house. Check the connection and try again.";
  if (status === 401) return 'The house wants you to sign in again.';
  if (status === 403) return "The console isn't allowed to do that.";
  if (status === 503) return "The brain isn't set up yet: its address or key is missing in Secrets.";
  if (status === 502 || status === 504) return `Couldn't reach the brain just now. Try again in a moment.${quoted}`;
  if (status === 404) return `The brain couldn't find that.${quoted}`;
  if (status === 400) return `The brain didn't accept that.${quoted}`;
  if (status >= 500) return `The brain hit a problem on its side.${quoted}`;
  return `Something went wrong (${status}).${quoted}`;
}

/** One request through the hallway. Never throws: a failure comes back as
 *  { ok: false, error } with plain words. Some brain doors answer 200 with
 *  { result: "Error: ..." }; those count as failures too. */
export async function brainRequest<T = unknown>(
  fetchFn: FetchFn,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<BrainResult<T>> {
  let res;
  try {
    res = await fetchFn(HALLWAY + path, {
      method,
      ...(method === 'GET' ? {} : {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }),
    });
  } catch {
    return { ok: false, status: 0, error: plainError(0) };
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) return { ok: false, status: res.status, error: plainError(res.status, text) };
  let data: unknown = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* plain text answer */ }
  if (data && typeof data === 'object' && typeof (data as any).result === 'string' && (data as any).result.startsWith('Error:')) {
    return { ok: false, status: 400, error: plainError(400, text) };
  }
  return { ok: true, data: data as T };
}

export const brainGet = <T = unknown>(fetchFn: FetchFn, path: string) => brainRequest<T>(fetchFn, 'GET', path);

// ─── Small readers ──────────────────────────────────────────────────────

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);

/** "2026-11-24 16:52:45" (the brain's UTC) or an ISO stamp → a Date. */
export function brainDate(v: unknown): Date | null {
  const s = str(v);
  if (!s) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A short day for a list row: "24 Nov". */
export function shortDay(v: unknown): string {
  const d = brainDate(v);
  return d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
}

// ─── Inner weather (the bar on top) ─────────────────────────────────────

export interface Weather {
  sky: string;
  timeOfDay: string;
  energy: string;
  moods: string[];
  activeThreads: number;
  highPriority: number;
  pressing: { content: string; type: string }[];
}

export function normWeather(raw: unknown): Weather | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as any;
  const c = r.conditions && typeof r.conditions === 'object' ? r.conditions : {};
  return {
    sky: str(c.weather),
    timeOfDay: str(c.time),
    energy: str(r.weather_energy || c.time_energy),
    moods: list(r.mood_palette).map(str).filter(Boolean),
    activeThreads: num(c.active_threads),
    highPriority: num(c.high_priority),
    pressing: list(r.pressing).map((p) => ({ content: str(p?.content), type: str(p?.type) })).filter((p) => p.content),
  };
}

// ─── What's surfacing ───────────────────────────────────────────────────

export interface SurfaceItem {
  /** The observation's id in the brain. */
  id: number;
  /** The marks line after the id: weight, charge, match, emotions. */
  marks: string;
  entity: string;
  entityType: string;
  content: string;
}

/** The brain hands surfacing back as formatted text; this reads its items
 *  out: "**#469** marks\n**Entity** (type): content". */
export function parseSurface(formatted: unknown): SurfaceItem[] {
  const text = str(formatted);
  const out: SurfaceItem[] = [];
  const blocks = text.split(/\n(?=\*\*#\d+\*\*)/);
  for (const block of blocks) {
    const head = block.match(/^\*\*#(\d+)\*\*([^\n]*)\n([\s\S]*)$/);
    if (!head) continue;
    const rest = head[3].trim();
    const who = rest.match(/^\*\*(.+?)\*\*\s*(?:\(([^)]*)\))?:\s*([\s\S]*)$/);
    out.push({
      id: Number(head[1]),
      marks: head[2].trim(),
      entity: who ? who[1] : '',
      entityType: who ? str(who[2]) : '',
      content: (who ? who[3] : rest).trim(),
    });
  }
  return out;
}

export function normSurface(raw: unknown): { mood: string; items: SurfaceItem[] } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as any;
  return { mood: str(r.mood?.dominant), items: parseSurface(r.formatted) };
}

// ─── The "Pressing" strip ───────────────────────────────────────────────

export interface Pressing {
  surfacing: number | null;
  tensions: number | null;
  proposals: number | null;
  /** True when a count hit the brain's list cap, so "100" means "100 or more". */
  proposalsCapped: boolean;
}

export function countTensions(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as any;
  return typeof r.active_count === 'number' ? r.active_count : list(r.active).length;
}

/** The brain lists at most 100 waiting suggestions. */
export const PROPOSAL_CAP = 100;

export function countLabel(n: number | null, capped = false): string {
  if (n === null) return '–';
  return capped ? `${n}+` : String(n);
}

// ─── Health ─────────────────────────────────────────────────────────────

export interface HealthScores {
  overall: number;
  parts: { label: string; score: number }[];
  checkedAt: string;
}

const SCORE_LABELS: [string, string][] = [
  ['db_score', 'Memory size'],
  ['thread_score', 'Threads'],
  ['journal_score', 'Journals'],
  ['identity_score', 'Identity'],
  ['activity_score', 'This week'],
  ['subconscious_score', 'Background work'],
];

export function normHealthScores(raw: unknown): HealthScores | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as any;
  return {
    overall: num(r.overall),
    parts: SCORE_LABELS.filter(([k]) => r[k] !== undefined).map(([k, label]) => ({ label, score: num(r[k]) })),
    checkedAt: str(r.daemon_processed_at),
  };
}

/** The brain's own health report is a block of text ({ output }). */
export function healthText(raw: unknown): string {
  if (raw && typeof raw === 'object' && typeof (raw as any).output === 'string') return (raw as any).output;
  return typeof raw === 'string' ? raw : '';
}

// ─── People & things ────────────────────────────────────────────────────

export interface EntityRow {
  id: number;
  name: string;
  type: string;
  context: string;
  count: number;
}

export function normEntities(raw: unknown): EntityRow[] {
  const rows = Array.isArray(raw) ? raw : list((raw as any)?.entities);
  return rows.map((e) => ({
    id: num(e?.id),
    name: str(e?.name) || `#${str(e?.id)}`,
    type: str(e?.entity_type),
    context: str(e?.primary_context),
    count: num(e?.observation_count),
  }));
}

export interface ObservationRow {
  id: number;
  content: string;
  emotion: string;
  weight: string;
  charge: string;
  entity: string;
  at: string;
}

export function normObservation(o: any): ObservationRow {
  return {
    id: num(o?.id),
    content: str(o?.content),
    emotion: str(o?.emotion),
    weight: str(o?.weight),
    charge: str(o?.charge),
    entity: str(o?.entity_name),
    at: str(o?.added_at || o?.created_at),
  };
}

export interface RelationRow {
  id: number;
  from: string;
  to: string;
  type: string;
}

export function normRelation(r: any): RelationRow {
  return { id: num(r?.id), from: str(r?.from_entity), to: str(r?.to_entity), type: str(r?.relation_type) };
}

export interface EntityDetail extends EntityRow {
  salience: string;
  observations: ObservationRow[];
  relations: RelationRow[];
}

export function normEntityDetail(raw: unknown): EntityDetail | null {
  if (!raw || typeof raw !== 'object' || (raw as any).error) return null;
  const r = raw as any;
  const observations = list(r.observations).map(normObservation);
  return {
    id: num(r.id),
    name: str(r.name),
    type: str(r.entity_type),
    context: str(r.primary_context),
    count: observations.length,
    salience: str(r.salience),
    observations,
    relations: list(r.relations).map(normRelation),
  };
}

// ─── Recent ─────────────────────────────────────────────────────────────

export interface RecentThread {
  id: string;
  content: string;
  status: string;
  priority: string;
  at: string;
}

export interface RecentJournal {
  id: number;
  content: string;
  emotion: string;
  day: string;
}

export interface Recent {
  observations: ObservationRow[];
  journals: RecentJournal[];
  threads: RecentThread[];
}

export function normRecent(raw: unknown): Recent {
  const r = (raw && typeof raw === 'object' ? raw : {}) as any;
  // The old /api/mind/recent answered with a bare list of observations.
  const obs = Array.isArray(raw) ? raw : list(r.observations);
  return {
    observations: obs.map(normObservation),
    journals: list(r.journals).map((j) => ({ id: num(j?.id), content: str(j?.content), emotion: str(j?.emotion), day: str(j?.entry_date || j?.created_at) })),
    threads: list(r.threads).map((t) => ({ id: str(t?.id), content: str(t?.content), status: str(t?.status), priority: str(t?.priority), at: str(t?.resolved_at || t?.updated_at || t?.created_at) })),
  };
}

// ─── Identity ───────────────────────────────────────────────────────────

export interface IdentityEntry {
  id: number;
  content: string;
  weight: number;
  connections: string;
  at: string;
}

export interface IdentitySection {
  section: string;
  entries: IdentityEntry[];
}

/** Rows grouped under their section, sections in the brain's order. */
export function normIdentity(raw: unknown): IdentitySection[] {
  const rows = Array.isArray(raw) ? raw : list((raw as any)?.entries);
  const out: IdentitySection[] = [];
  for (const r of rows) {
    const section = str(r?.section) || 'other';
    let s = out.find((x) => x.section === section);
    if (!s) { s = { section, entries: [] }; out.push(s); }
    s.entries.push({ id: num(r?.id), content: str(r?.content), weight: num(r?.weight), connections: str(r?.connections), at: str(r?.timestamp) });
  }
  return out;
}

/** "core_identity" → "Core identity". */
export function sectionName(section: string): string {
  const s = section.replace(/[._]/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : section;
}

// ─── Threads ────────────────────────────────────────────────────────────

export interface ThreadRow {
  id: string;
  type: string;
  content: string;
  context: string;
  priority: string;
  status: string;
  resolution: string;
  at: string;
}

export function normThreads(raw: unknown): ThreadRow[] {
  return list(raw).map((t) => ({
    id: str(t?.id),
    type: str(t?.thread_type),
    content: str(t?.content),
    context: str(t?.context),
    priority: str(t?.priority),
    status: str(t?.status) || 'active',
    resolution: str(t?.resolution),
    at: str(t?.resolved_at || t?.updated_at || t?.created_at),
  }));
}

// ─── Feelings ───────────────────────────────────────────────────────────

export type Who = 'all' | 'companion-a' | 'companion-b' | 'shared';
export const WHO_FILTERS: { id: Who; label: string }[] = [
  { id: 'all', label: 'Everyone' },
  { id: 'companion-a', label: 'Companion A' },
  { id: 'companion-b', label: 'Companion B' },
  { id: 'shared', label: 'Shared' },
];

export function whoName(who: string): string {
  return WHO_FILTERS.find((w) => w.id === who)?.label ?? (who || 'Unsigned');
}

export interface FeelingRow {
  id: number;
  content: string;
  emotion: string;
  who: string;
  intensity: string;
  weight: string;
  charge: string;
  entity: string;
  context: string;
  note: string;
  at: string;
}

export function normFeelings(raw: unknown): FeelingRow[] {
  return list(raw).map((f) => ({
    id: num(f?.id),
    content: str(f?.content),
    emotion: str(f?.emotion),
    who: str(f?.who),
    intensity: str(f?.intensity),
    weight: str(f?.weight),
    charge: str(f?.charge),
    entity: str(f?.linked_entity),
    context: str(f?.context),
    note: str(f?.resolution_note),
    at: str(f?.created_at),
  }));
}

export interface FeelingsWeek {
  total: number;
  open: number;
  heavyOpen: number;
  emotions: { emotion: string; count: number }[];
}

export function normFeelingsWeek(raw: unknown): FeelingsWeek | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as any;
  return {
    total: num(r.total),
    open: num(r.unmetabolized),
    heavyOpen: num(r.heavy_open),
    emotions: list(r.emotions).map((e) => ({ emotion: str(e?.emotion), count: num(e?.count) })).filter((e) => e.emotion),
  };
}

/** Feelings filtered by who: '' for everyone, so the brain leaves it off. */
export function whoQuery(who: Who): string | undefined {
  return who === 'all' ? undefined : who;
}

// ─── Journals and dreams ────────────────────────────────────────────────

export interface JournalRow {
  id: number;
  day: string;
  content: string;
  tags: string;
  emotion: string;
  companion: string;
}

export function normJournals(raw: unknown): JournalRow[] {
  return list(raw).map((j) => ({
    id: num(j?.id),
    day: str(j?.entry_date || j?.created_at),
    content: str(j?.content),
    tags: str(j?.tags),
    emotion: str(j?.emotion),
    companion: str(j?.companion),
  }));
}

export interface DreamRow {
  id: number;
  day: string;
  content: string;
  /** How vivid it is now (it fades unless it is recalled or anchored), 0-100. */
  vividness: number | null;
  anchored: boolean;
  companion: string;
  question: string;
}

export function normDreams(raw: unknown): DreamRow[] {
  return list(raw).map(normDream);
}

export function normDream(d: any): DreamRow {
  const v = d?.effective_vividness ?? d?.vividness;
  return {
    id: num(d?.id),
    day: str(d?.dream_date || d?.created_at),
    content: str(d?.content),
    vividness: v === null || v === undefined ? null : num(v),
    anchored: !!d?.anchored_at,
    companion: str(d?.companion),
    question: str(d?.emerged_question),
  };
}

// ─── Tensions and suggestions ───────────────────────────────────────────

export interface TensionRow {
  id: string;
  a: string;
  b: string;
  context: string;
  visits: number;
  resolution: string;
  resolved: boolean;
  at: string;
}

export function normTensions(raw: unknown): { open: TensionRow[]; resolved: TensionRow[] } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as any;
  const row = (t: any): TensionRow => ({
    id: str(t?.id), a: str(t?.pole_a), b: str(t?.pole_b), context: str(t?.context),
    visits: num(t?.visits), resolution: str(t?.resolution), resolved: !!t?.resolved_at, at: str(t?.resolved_at || t?.last_visited || t?.created_at),
  });
  return { open: list(r.active).map(row), resolved: list(r.resolved).map(row) };
}

export interface ProposalRow {
  id: number;
  reason: string;
  confidence: number;
  fromEntity: string;
  toEntity: string;
  fromContent: string;
  toContent: string;
  at: string;
}

export function normProposals(raw: unknown): ProposalRow[] {
  return list(raw).map((p) => ({
    id: num(p?.id),
    reason: str(p?.reason),
    confidence: num(p?.confidence),
    fromEntity: str(p?.from_entity_name),
    toEntity: str(p?.to_entity_name),
    fromContent: str(p?.from_content),
    toContent: str(p?.to_content),
    at: str(p?.proposed_at),
  }));
}

// ─── Patterns and personality ───────────────────────────────────────────

type Tally = { label: string; count: number };
const tally = (rows: unknown, key: string): Tally[] =>
  list(rows).map((r) => ({ label: str(r?.[key]) || 'unmarked', count: num(r?.count) }));

export interface Patterns {
  days: number;
  alive: { name: string; type: string; count: number }[];
  weights: Tally[];
  charges: Tally[];
  salience: Tally[];
  foundational: string[];
}

export function normPatterns(raw: unknown): Patterns {
  const r = (raw && typeof raw === 'object' ? raw : {}) as any;
  return {
    days: num(r.period_days) || 7,
    alive: list(r.alive).map((a) => ({ name: str(a?.name), type: str(a?.entity_type), count: num(a?.obs_count) })),
    weights: tally(r.weights, 'weight'),
    charges: tally(r.charges, 'charge'),
    salience: tally(r.salience, 'salience'),
    foundational: list(r.foundational).map((f) => str(f?.name)).filter(Boolean),
  };
}

export interface Ledger {
  who: string;
  type: string;
  confidence: number;
  signals: number;
}

export function normPersonality(raw: unknown): { ledgers: Ledger[]; words: Tally[] } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as any;
  return {
    ledgers: list(r.ledgers).map((l) => ({ who: str(l?.who), type: str(l?.type), confidence: num(l?.confidence), signals: num(l?.signals) })),
    words: list(r.vocabulary_top).map((v) => ({ label: str(v?.emotion_word), count: num(v?.times_used) })),
  };
}

// ─── Search ─────────────────────────────────────────────────────────────

export interface SearchHit {
  id: string;
  kind: string;
  score: number;
  content: string;
  /** Who or what it's about, when the brain says. */
  about: string;
  at: string;
}

const KINDS: [string, string][] = [
  ['obs-', 'Note'], ['feel-', 'Feeling'], ['journal-', 'Journal'], ['ctx-', 'Cortex thought'],
  ['img-', 'Picture'], ['dream-', 'Dream'], ['know-', 'Knowledge'], ['conv-', 'Conversation'],
];

export function hitKind(id: string, type?: string): string {
  const k = KINDS.find(([p]) => id.startsWith(p));
  if (k) return k[1];
  return type ? sectionName(type) : 'Memory';
}

export function normSearch(raw: unknown): SearchHit[] {
  const r = (raw && typeof raw === 'object' ? raw : {}) as any;
  return list(r.results).map((h) => ({
    id: str(h?.id),
    kind: hitKind(str(h?.id), str(h?.type)),
    score: num(h?.score),
    content: str(h?.content || h?.description),
    about: str(h?.entity || h?.domain),
    at: str(h?.added_at),
  }));
}

/** Cortex answers with written text in { result }. */
export function resultText(raw: unknown): string {
  if (raw && typeof raw === 'object' && typeof (raw as any).result === 'string') return (raw as any).result;
  return typeof raw === 'string' ? raw : '';
}

// ─── Knowledge and soul ─────────────────────────────────────────────────

export interface KnowItem {
  id: number;
  content: string;
  category: string;
  who: string;
  status: string;
  heat: number;
}

const knowItem = (k: any): KnowItem => ({
  id: num(k?.id), content: str(k?.content), category: str(k?.category), who: str(k?.who),
  status: str(k?.status), heat: num(k?.heat_score),
});

export interface Knowledge {
  tracks: { track: string; title: string; goal: string; sessions: number }[];
  hottest: KnowItem[];
  cooling: KnowItem[];
  candidates: KnowItem[];
}

export function normKnowledge(raw: unknown): Knowledge {
  const r = (raw && typeof raw === 'object' ? raw : {}) as any;
  return {
    tracks: list(r.tracks).map((t) => ({ track: str(t?.track), title: str(t?.title || t?.track), goal: str(t?.goal), sessions: num(t?.sessions) })),
    hottest: list(r.hottest).map(knowItem),
    cooling: list(r.cooling).map(knowItem),
    candidates: list(r.candidates).map(knowItem),
  };
}

export const normKnowItems = (raw: unknown): KnowItem[] => list(raw).map(knowItem);

export interface SoulVersion {
  id: number;
  status: string;
  content: string;
  words: number;
  at: string;
}

export interface SoulPortrait {
  who: string;
  active: SoulVersion | null;
  pending: SoulVersion | null;
  history: SoulVersion[];
}

const soulVersion = (v: any): SoulVersion | null => (v && typeof v === 'object' ? {
  id: num(v.id), status: str(v.status), content: str(v.content), words: num(v.word_count),
  at: str(v.validated_at || v.generated_at),
} : null);

export function normSoul(raw: unknown): SoulPortrait[] {
  const r = (raw && typeof raw === 'object' ? raw : {}) as any;
  const one = (s: any): SoulPortrait => ({
    who: str(s?.who), active: soulVersion(s?.active), pending: soulVersion(s?.pending),
    history: list(s?.history).map(soulVersion).filter((v): v is SoulVersion => !!v),
  });
  return r.who ? [one(r)] : ['companion-a', 'companion-b'].filter((w) => r[w]).map((w) => one(r[w]));
}

// ─── Health's back rooms ────────────────────────────────────────────────

export function normStats(raw: unknown): { version: string; counts: Tally[] } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as any;
  const c = r.counts && typeof r.counts === 'object' ? r.counts : {};
  const names: Record<string, string> = { entities: 'People & things', observations: 'Notes', journals: 'Journal entries', unprocessed: 'Notes not yet settled' };
  return { version: str(r.version), counts: Object.keys(c).map((k) => ({ label: names[k] ?? sectionName(k), count: num(c[k]) })) };
}

export interface DormantRow {
  /** The note's own id: the brain's surface/archive doors take this one. */
  observationId: number;
  content: string;
  entity: string;
  weight: string;
  days: number;
}

export function normDormant(raw: unknown): DormantRow[] {
  return list(raw).map((d) => ({
    observationId: num(d?.observation_id), content: str(d?.content), entity: str(d?.entity_name),
    weight: str(d?.weight), days: num(d?.days_old),
  }));
}

export interface IsolatedRow {
  id: number;
  name: string;
  type: string;
  count: number;
}

export function normIsolated(raw: unknown): IsolatedRow[] {
  return list(raw).map((e) => ({ id: num(e?.id), name: str(e?.name), type: str(e?.entity_type), count: num(e?.obs_count) }));
}

export function normArchive(raw: unknown): { items: ObservationRow[]; total: number } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as any;
  const rows = Array.isArray(raw) ? raw : list(r.observations);
  return { items: rows.map(normObservation), total: Array.isArray(raw) ? rows.length : num(r.total) };
}

// ─── Console buttons: what each write sends ─────────────────────────────
//
// Built from the brain's own handlers. Several of its doors overwrite every
// field they name, so an edit always sends the fields it didn't change too,
// exactly as they were.

/** The brain's seven homes for a note or an entity. */
export const CONTEXTS = ['bond', 'owner-world', 'build', 'constellation', 'self', 'play', 'craft'] as const;

const clean = (s: string) => s.trim();

/** PUT observations/:id sets content, weight and emotion together. */
export function editNoteBody(note: Pick<ObservationRow, 'content' | 'weight' | 'emotion'>, content: string) {
  return { content: clean(content), weight: note.weight || 'medium', emotion: note.emotion || null };
}

/** POST observations/:id/resolve: the note is settled ("metabolized"). */
export function settleNoteBody(note: string) {
  return { resolution_note: clean(note) };
}

/** PUT entities/:id changes only the fields it is given. An unknown home
 *  is left out rather than sent, since the brain would refuse it. */
export function editEntityBody(before: Pick<EntityDetail, 'name' | 'type' | 'context'>, after: { name: string; type: string; context: string }) {
  const body: Record<string, string> = {};
  if (clean(after.name) && clean(after.name) !== before.name) body.name = clean(after.name);
  if (clean(after.type) && clean(after.type) !== before.type) body.entity_type = clean(after.type);
  if (after.context !== before.context && (CONTEXTS as readonly string[]).includes(after.context)) body.context = after.context;
  return body;
}

/** PUT relations/:id: only the kind of link can change. */
export function editRelationBody(type: string) {
  return { relation_type: clean(type).replace(/\s+/g, '_') };
}

/** PUT journals/:id sets content, tags and emotion together. */
export function editJournalBody(j: Pick<JournalRow, 'tags' | 'emotion'>, content: string) {
  return { content: clean(content), tags: j.tags || null, emotion: j.emotion || null };
}

/** PUT dreams/:id takes only the words. */
export function editDreamBody(content: string) {
  return { content: clean(content) };
}

/** PUT identity/:section rewrites every entry in that section at once, so
 *  the console only edits a section that holds a single entry. */
export function canEditSection(section: IdentitySection): boolean {
  return section.entries.length === 1;
}

export function editIdentityBody(entry: IdentityEntry, content: string) {
  return { content: clean(content), weight: entry.weight || 0.7, connections: entry.connections || null };
}

export function settleTensionBody(resolution: string) {
  return { resolution: clean(resolution) || null };
}

export function acceptSuggestionBody(type = '') {
  return { relation_type: clean(type).replace(/\s+/g, '_') || 'related_to' };
}

/** What the brain said back after a button, in a short plain line. */
export function describeAnswer(data: unknown): string {
  const d = (data && typeof data === 'object' ? data : {}) as any;
  if (d.deleted) return 'Deleted.';
  if (d.relation_created) return 'Linked.';
  if (d.charge === 'metabolized') return 'Settled.';
  if (d.status === 'resolved') return 'Marked done.';
  if (typeof d.effective_vividness === 'number') return d.anchored_at ? 'Kept: this dream will stop fading.' : `Recalled: now ${d.effective_vividness}% vivid.`;
  if (d.success) return 'Done.';
  return 'Saved.';
}

// ─── Sending into the house (not the brain) ─────────────────────────────

export type ShareKind = 'feeling' | 'note' | 'journal';

/** A brain thread as a Command Center task: its own words. */
export function taskBody(thread: Pick<ThreadRow, 'content'>) {
  return { text: thread.content.trim() };
}

/** A feeling, note or journal entry as a card for the home chat. The house
 *  writes the heading; these are the pieces it needs. */
export function shareBody(kind: ShareKind, item: { id: string | number; content: string; who?: string; emotion?: string; about?: string; day?: string }) {
  const body: Record<string, string> = { kind, text: item.content, brainId: `${kind}-${item.id}` };
  if (item.who) body.who = item.who;
  if (item.emotion) body.emotion = item.emotion;
  if (item.about) body.about = item.about;
  const day = shortDay(item.day);
  if (day) body.day = day;
  return body;
}

/** One press of a house button (POST /api/mind/share/...). Never throws. */
export async function housePost(fetchFn: FetchFn, path: 'task' | 'chat', body: unknown): Promise<BrainResult<any>> {
  let res;
  try {
    res = await fetchFn(`/api/mind/share/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, error: plainError(0) };
  }
  const text = await res.text().catch(() => '');
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* plain text */ }
  if (res.ok) return { ok: true, data };
  if (res.status === 401) return { ok: false, status: 401, error: plainError(401) };
  const said = data && typeof data.error === 'string' ? data.error : '';
  return { ok: false, status: res.status, error: said ? `The house said: ${said}.` : `Something went wrong (${res.status}).` };
}
