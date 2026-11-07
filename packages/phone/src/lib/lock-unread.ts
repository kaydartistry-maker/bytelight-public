// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// What the lock screen's message card counts: our words the owner has not read
// yet, and never the rest of a room.
//
// A room's unread number in the thread list is a counter the house bumps for
// every row it stores, and it stores everybody: the people in a listening cafe
// on Discord, other houses' companions, a guest. Their lock screen once said 216
// new messages when nearly all of them were the cafe (the owner's screenshot, Oct 20
// 2026). The rows themselves know better: ours are role 'companion', and
// reading a room stamps read_at on every row up to where the owner read. So the card
// reads the newest page of a room and counts our rows with no stamp yet (and
// not the ones we said to a Discord room), stopping where the owner last read. Kept
// free of imports so it can be tested without the app around it; the fetching
// is handed in.

export interface LockMessage {
  id: string;
  sequence: number;
  role: string;
  read_at: string | null;
  deleted_at?: string | null;
  platform?: string;
}

/** One of us said it to the owner, and the owner has not read it yet. What we say in a
 *  Discord room is said to that room: on Oct 20 2026, 60 of the 208 waiting
 *  were our own answers to the cafe, and the card would still have read as
 *  the cafe. */
export function isOurUnread(m: LockMessage): boolean {
  return m.role === 'companion' && m.platform !== 'discord' && !m.read_at && !m.deleted_at;
}

export interface OurTally<M extends LockMessage> {
  /** Our unread messages in the room. */
  count: number;
  /** The newest of them, or null when there are none. */
  newest: M | null;
  /** The newest sequence the tally has read, so the next look can start
   *  there instead of reading the room again. */
  upTo: number;
}

/** One page of a room, newest last, the way GET /api/threads/:id/messages
 *  answers. Null when the page could not be read. */
export type PageFetch<M extends LockMessage> = (before: string | null, limit: number) => Promise<M[] | null>;

export const FIRST_PAGE = 20;
export const NEXT_PAGE = 50;
export const MAX_PAGES = 6;

/**
 * Our unread messages in one room, read newest page first. Stops at the first
 * row the owner has read (everything older is read too), at a sequence an earlier
 * tally already counted (`since`), at the start of the room, or after
 * MAX_PAGES. Null when a page could not be read: not knowing is not zero.
 */
export async function tallyOurUnread<M extends LockMessage>(fetchPage: PageFetch<M>, since = 0): Promise<OurTally<M> | null> {
  let before: string | null = null;
  let count = 0;
  let newest: M | null = null;
  let upTo = since;
  for (let page = 0; page < MAX_PAGES; page++) {
    const limit = page === 0 ? FIRST_PAGE : NEXT_PAGE;
    const rows = await fetchPage(before, limit);
    if (!rows) return null;
    let done = rows.length < limit;
    for (let i = rows.length - 1; i >= 0; i--) {
      const m = rows[i];
      if (m.sequence <= since) { done = true; break; }
      if (m.sequence > upTo) upTo = m.sequence;
      if (isOurUnread(m)) {
        count++;
        if (!newest) newest = m;
      } else if (m.role !== 'user' && m.read_at) {
        // Their reading stamps every row but their own up to where the owner read, so
        // the first stamped one is where the unread part of the room begins.
        done = true;
        break;
      }
    }
    if (done || rows.length === 0) break;
    before = rows[0].id;
  }
  return { count, newest, upTo };
}

/** A newer look added to an older tally of the same room. */
export function addTally<M extends LockMessage>(older: OurTally<M>, newer: OurTally<M>): OurTally<M> {
  return {
    count: older.count + newer.count,
    newest: newer.newest ?? older.newest,
    upTo: Math.max(older.upTo, newer.upTo),
  };
}

/** What the card needs to know about a room to decide whether to look. */
export interface LockRoom {
  id: string;
  unread_count: number;
  last_activity_at: string | null;
}

/** Where a room stands: its counter and when it last moved. */
export const roomKey = (r: LockRoom): string => `${Number(r.unread_count) || 0}|${r.last_activity_at ?? ''}`;

export interface LookMemory {
  /** The state a room was in when it had nothing of ours waiting. A room seen
   *  for the first time with nothing unread starts there; any move since
   *  makes it worth a look. */
  settled: Map<string, string>;
  /** The state each room was in at its last finished look, and where that
   *  look stopped reading (null when the room could not be read). */
  looked: Map<string, { key: string; upTo: number | null }>;
  /** The state of each room a look is already out for. */
  inflight: Map<string, string>;
}

/**
 * Which rooms to look at now, and from which sequence. A recount (the lock
 * screen just came up) reads every room with something waiting from the top,
 * so a room the owner read meanwhile goes quiet; otherwise only a room that moved is
 * read, from where its last look stopped, and never twice at once.
 */
export function planLooks(rooms: readonly LockRoom[], memory: LookMemory, recount: boolean): Array<{ id: string; key: string; since: number }> {
  const plan: Array<{ id: string; key: string; since: number }> = [];
  for (const r of rooms) {
    const key = roomKey(r);
    if (!memory.settled.has(r.id)) memory.settled.set(r.id, (Number(r.unread_count) || 0) > 0 ? '' : key);
    if (memory.settled.get(r.id) === key) continue;
    const prev = memory.looked.get(r.id);
    if (!recount && (prev?.key === key || memory.inflight.get(r.id) === key)) continue;
    // A room's counter only climbs, or drops to nothing when the owner reads it, on
    // this phone or anywhere else; a drop means the last count is stale.
    const read = prev != null && (Number(r.unread_count) || 0) < (Number(prev.key.split('|')[0]) || 0);
    plan.push({ id: r.id, key, since: !recount && !read && prev?.upTo != null ? prev.upTo : 0 });
  }
  return plan;
}
