/**
 * The other-lane net, shared by every warm lane that keeps its own session
 * across turns (the Claude CLI heartbeat lane and the Codex daemon lane).
 *
 * A warm lane only hears what is handed to it. When another lane (a different
 * engine after a model swap, a wake, the other companion's own lane, a Living
 * Room relay) replies in the same thread, the reply lands in the thread and
 * the database and this lane never hears it. Both runtimes call these, so the
 * rule (own rows by lane tag, skip untagged/empty/[No response], cap, mark =
 * newest row read, failed or guest turn keeps the mark) lives in one place.
 */

/** How many other-lane replies one turn is handed — the newest few. */
export const OTHER_LANE_REPLY_CAP = 8;

/**
 * The second half of the same net. selectMissedInbound hands a warm lane HER
 * messages it never saw; this hands it the COMPANION replies it never saw —
 * ones written in the same thread by a different lane since this lane last
 * finished a turn there (another engine after a model swap, a wake, the other
 * companion's own lane, a Living Room relay). Without it the lane is deaf to
 * its own room: 2026-10-26 the Codex lane posted a full surgery map and the
 * Claude lane only found it by reading the messages table.
 *
 * Its OWN rows are told apart by lane tag (metadata.lane, laneTagFor), never
 * by timestamp: a lane's reply row is persisted after its turn ends, and its
 * idle-watcher deliveries land between turns, so a time mark alone would hand
 * a lane its own words back. `since` only bounds how far back to look. No
 * mark means nothing — a fresh or never-here lane is primed by the recycle
 * seed. Untagged rows, empty rows and `[No response]` corpses are not speech.
 */
export function selectOtherLaneReplies<T extends { role: string; content: string; createdAt: string; lane?: string }>(
  messages: readonly T[],
  since: string | undefined,
  ownLane: string,
): T[] {
  if (!since) return [];
  const spoken = messages.filter(m =>
    m.role === 'assistant'
    // Only rows a lane SPOKE carry a tag. Untagged companion rows are tool
    // posts (voice notes, shared files, image placeholders, reminders) —
    // possibly this lane's own — or predate the tag; neither is speech.
    && !!m.lane
    && m.lane !== ownLane
    && m.createdAt > since
    && m.content.trim() !== ''
    && m.content.trim() !== '[No response]',
  );
  spoken.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return spoken.slice(-OTHER_LANE_REPLY_CAP);
}

/**
 * Where the other-lane net starts looking next turn. The newest row this turn
 * actually READ, not the turn's start time: history is snapshotted before the
 * turn starts, so a reply another lane writes in that gap is in neither the
 * snapshot nor (with a start-time mark) the next turn. A turn that failed
 * before delivering, or a guest's turn, leaves the mark where it was, so what
 * it carried is offered again. Never moves backwards. An empty read falls
 * back to the turn start so a lane's first turn in a thread still arms it.
 */
export function nextOtherLaneMark(opts: {
  prev: string | undefined;
  read: readonly { createdAt: string }[];
  completed: boolean;
  guest: boolean;
  fallback: string;
}): string | undefined {
  const { prev, read, completed, guest, fallback } = opts;
  if (guest || !completed) return prev;
  let newest = '';
  for (const m of read) if (m.createdAt && m.createdAt > newest) newest = m.createdAt;
  const next = newest || fallback;
  return prev && prev > next ? prev : next;
}

/** Keep one oversized reply deliverable: head and tail, middle cut. */
export function clampForDelivery(content: string, cap: number): string {
  if (content.length <= cap) return content;
  const head = content.slice(0, Math.floor(cap * 0.85));
  const tail = content.slice(content.length - Math.floor(cap * 0.1));
  const cutKb = Math.round((content.length - head.length - tail.length) / 1024);
  return `${head}\n[…${cutKb}KB truncated to keep this message deliverable]\n${tail}`;
}

/**
 * Who spoke a companion row. `house` names the shared Companion A + Companion B voice
 * (companion_id 'companion-a-b' or unset); anyone else goes by their own id
 * ('companion-c' → 'Companion C'), so a visitor's words never read as this lane's own.
 */
export function speakerName(companionId: string | undefined, house: string): string {
  if (!companionId || companionId === 'companion-a-b') return house;
  return companionId.charAt(0).toUpperCase() + companionId.slice(1);
}

/**
 * Render the other-lane replies as the block a turn is handed, labelled by who
 * actually spoke. '' when there is nothing. `house` names the shared
 * Companion A + Companion B voice (companion_id 'companion-a-b' or unset).
 */
export function renderOtherLaneBlock(
  theirs: readonly { content: string; createdAt: string; companionId?: string }[],
  house = 'Companion',
): string {
  if (theirs.length === 0) return '';
  const who = (m: { companionId?: string }): string => speakerName(m.companionId, house);
  return [
    '',
    '[Said in this thread since your last turn here, in a lane you were not running (another engine, a wake, the other companion, a relay). She has read these. Carry them; do not repeat them:]',
    ...theirs.map(m => `${who(m)} (${m.createdAt}): ${clampForDelivery(m.content, 4_000)}`),
    '[End of other-lane replies.]',
    '',
  ].join('\n');
}
