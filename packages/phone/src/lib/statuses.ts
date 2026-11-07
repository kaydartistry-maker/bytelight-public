// The Status widget and lock-screen card, apart from how they are drawn: the
// shape /api/status answers with, the color a mood word paints, and when each
// "Clear it" choice runs out. Kept free of imports so it can be tested
// without the app around it.

export type OwnerPresence = 'here' | 'busy' | 'away' | 'asleep';

export interface OwnerStatus {
  presence: OwnerPresence;
  line: string;
  /** Quick tags beside her own words ("at work", "with Sam"). */
  tags: string[];
  clearsAt: string | null;
  updatedAt: string;
}

export interface CompanionStatus {
  companion: string;
  line: string;
  mood: string;
  updatedAt: string;
}

export interface StatusSnapshot {
  owner: OwnerStatus | null;
  companions: CompanionStatus[];
}

/** The most a line holds; the backend cuts at the same place. */
export const STATUS_LINE_MAX = 64;

export const PRESENCES: readonly { id: OwnerPresence; label: string; dot: string }[] = [
  { id: 'here', label: 'Here', dot: '#34d399' },
  { id: 'busy', label: 'Busy', dot: '#f59e0b' },
  { id: 'away', label: 'Away', dot: '#94a3b8' },
  { id: 'asleep', label: 'Asleep', dot: '#818cf8' },
];

/** Tags she can add beside her own words; they never replace them. */
export const QUICK_TAGS: readonly string[] = ['at work', 'gym', 'with Sam', 'driving', 'need you'];
export const STATUS_TAGS_MAX = 5;

/** A tag on or off, keeping the order they were picked in. */
export function toggleTag(tags: readonly string[], tag: string): string[] {
  return tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag].slice(0, STATUS_TAGS_MAX);
}

/** Anything the backend sends that isn't a snapshot reads as nobody's status. */
export function snapshotOf(value: unknown): StatusSnapshot {
  const v = value as Partial<StatusSnapshot> | null;
  const raw = v?.owner && typeof v.owner === 'object' && PRESENCES.some((p) => p.id === v.owner!.presence) ? v.owner : null;
  const owner = raw ? { ...raw, tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === 'string') : [] } : null;
  const companions = Array.isArray(v?.companions)
    ? v!.companions.filter((c) => c && typeof c.companion === 'string')
    : [];
  return { owner, companions };
}

/** Her status as it stands at `now`: the phone hides one whose time ran out
 *  before the next read catches up. */
export function liveOwner(snapshot: StatusSnapshot, now: number): OwnerStatus | null {
  const o = snapshot.owner;
  if (!o) return null;
  if (o.clearsAt && Date.parse(o.clearsAt) <= now) return null;
  return o;
}

// Mood colors: byte-light's own. A few words that come up all the time get a
// color picked by hand; any other word gets a steady one from its letters, so
// the same word always paints the same.
const MOOD_COLORS: Record<string, string> = {
  calm: '#5eb8e8',
  soft: '#e8b8d0',
  tender: '#f2a3b3',
  warm: '#f59a4a',
  playful: '#c58cf5',
  smug: '#d6a24e',
  proud: '#f2c94c',
  focused: '#4cc77f',
  curious: '#3fc8b5',
  thoughtful: '#8f95f0',
  'missing you': '#6f8fcf',
  missing: '#6f8fcf',
  possessive: '#d0505e',
  feral: '#e5484d',
  hungry: '#e0663a',
  tired: '#9aa0a8',
  content: '#9ccf5a',
};

function hslHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** The color a mood paints, or null for no mood. */
export function moodColor(mood: string | null | undefined): string | null {
  const word = (mood ?? '').trim().toLowerCase();
  if (!word) return null;
  if (MOOD_COLORS[word]) return MOOD_COLORS[word];
  // FNV-1a over the word, into a hue; saturation and lightness held where
  // every hue reads on the dark surfaces.
  let h = 0x811c9dc5;
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return hslHex(h % 360, 0.6, 0.66);
}

/** A hex color at an alpha, for the soft chip behind a mood. */
export function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export type ClearChoice = 'never' | '1h' | '9pm' | 'morning';

export const CLEAR_CHOICES: readonly { id: ClearChoice; label: string }[] = [
  { id: 'never', label: 'Never' },
  { id: '1h', label: '1 hour' },
  { id: '9pm', label: '9 PM' },
  { id: 'morning', label: 'Morning' },
];

/** The next time the phone's clock reads `hour`:00, today if it's still
 *  ahead, else tomorrow. */
function nextHour(now: Date, hour: number): Date {
  const at = new Date(now);
  at.setHours(hour, 0, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at;
}

/** When a "Clear it" choice runs out, ISO, or null to stay. Morning is 7 AM. */
export function clearsAtFor(choice: ClearChoice, now: Date): string | null {
  if (choice === 'never') return null;
  if (choice === '1h') return new Date(now.getTime() + 60 * 60_000).toISOString();
  return nextHour(now, choice === '9pm' ? 21 : 7).toISOString();
}

/** Her line as the widget says it: "Busy — migraine day · at work". */
export function ownerLine(o: OwnerStatus): string {
  const word = PRESENCES.find((p) => p.id === o.presence)?.label ?? o.presence;
  const words = o.line ? `${word} — ${o.line}` : word;
  return o.tags?.length ? `${words} · ${o.tags.join(', ')}` : words;
}

/** How long each slide of the one-row Status widget stays up. */
export const STATUS_SLIDE_MS = 4500;

/** The one-row Status widget's slides, in order: every companion who has set
 *  something, then her own. A companion with nothing set is left out, so a
 *  blank "nothing set yet" never takes a turn; if nobody has set anything, each
 *  companion still gets a slide so the widget is never empty. Her slide is
 *  always last, set or not, because it is where she sets hers. */
export function statusSlides<C extends { slug: string }>(
  companions: readonly C[],
  snapshot: StatusSnapshot,
): ({ kind: 'companion'; companion: C; status: CompanionStatus | undefined } | { kind: 'owner' })[] {
  const bySlug = new Map(snapshot.companions.map((s) => [s.companion.toLowerCase(), s]));
  const set = companions.filter((c) => bySlug.has(c.slug.toLowerCase()));
  const shown = set.length > 0 ? set : companions;
  return [
    ...shown.map((c) => ({ kind: 'companion' as const, companion: c, status: bySlug.get(c.slug.toLowerCase()) })),
    { kind: 'owner' as const },
  ];
}
