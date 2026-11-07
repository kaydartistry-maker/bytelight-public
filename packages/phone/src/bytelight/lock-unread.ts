// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The lock screen's message card, read off the rows instead of the thread
// list's counter, which counts everybody a room stores (lib/lock-unread.ts says
// why). Only looks while the lock screen is up.

import { useEffect, useMemo, useRef, useState } from 'react';
import { messagePreviewText } from '@bytelight/shared';
import { apiFetch } from './api';
import type { Message, ThreadSummary } from './protocol';
import { addTally, planLooks, roomKey, tallyOurUnread, type LookMemory, type OurTally } from '../lib/lock-unread';
import { unreadSummary, type UnreadSummary } from '../lib/lock-clock';

type Tally = OurTally<Message>;

/** One page of a room. Null when it could not be read, including an older
 *  house whose unknown address answers the app's own page instead of rows. */
async function pageOf(threadId: string, before: string | null, limit: number): Promise<Message[] | null> {
  try {
    const q = new URLSearchParams({ limit: String(limit) });
    if (before) q.set('before', before);
    const res = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/messages?${q}`);
    if (!res.ok) return null;
    const rows = ((await res.json()) as { messages?: unknown } | null)?.messages;
    return Array.isArray(rows) ? (rows as Message[]) : null;
  } catch {
    return null;
  }
}

interface Look {
  key: string;
  /** Null when the room could not be read: the card falls back to the
   *  room's own counter for it, because not knowing is not zero. */
  tally: Tally | null;
}

/** The summary the cards draw, plus each looked-at room's own count of us,
 *  for the thread list (a room missing from it has not been looked at yet). */
export interface OurUnread extends UnreadSummary {
  byRoom: Readonly<Record<string, number>>;
}

export function useLockUnread(threads: readonly ThreadSummary[], showing: boolean): OurUnread {
  const memory = useRef<LookMemory>({ settled: new Map(), looked: new Map(), inflight: new Map() });
  const latest = useRef(new Map<string, number>());
  const requests = useRef(0);
  const fresh = useRef(true);
  const [looks, setLooks] = useState<Record<string, Look>>({});
  const looksRef = useRef(looks);
  looksRef.current = looks;

  useEffect(() => {
    if (!showing) fresh.current = true;
  }, [showing]);

  useEffect(() => {
    if (!showing) return;
    // The recount is taken when the look runs, not when it is planned, so a
    // room that moves in the same moment cannot cancel it.
    const timer = setTimeout(() => {
      const recount = fresh.current;
      fresh.current = false;
      for (const { id: threadId, key, since } of planLooks(threads, memory.current, recount)) {
        const prev = looksRef.current[threadId]?.tally ?? null;
        const id = ++requests.current;
        latest.current.set(threadId, id);
        memory.current.inflight.set(threadId, key);
        void tallyOurUnread((before, limit) => pageOf(threadId, before, limit), since).then((tally) => {
          if (latest.current.get(threadId) !== id) return;
          memory.current.inflight.delete(threadId);
          // A later look that fails keeps the earlier count; the next move
          // looks again.
          if (!tally && prev && since > 0) return;
          const total = tally && since > 0 && prev ? addTally(prev, tally) : tally;
          memory.current.looked.set(threadId, { key, upTo: total ? total.upTo : null });
          if (total && total.count === 0) memory.current.settled.set(threadId, key);
          setLooks((all) => ({ ...all, [threadId]: { key, tally: total } }));
        });
      }
    }, fresh.current ? 0 : 800);
    return () => clearTimeout(timer);
  }, [showing, threads]);

  return useMemo(() => {
    const rooms: Array<Pick<ThreadSummary, 'unread_count' | 'last_activity_at' | 'last_message_preview'>> = [];
    const byRoom: Record<string, number> = {};
    for (const t of threads) {
      if (memory.current.settled.get(t.id) === roomKey(t)) {
        byRoom[t.id] = 0;
        continue;
      }
      const look = looks[t.id];
      if (!look) continue;
      if (!look.tally) {
        rooms.push(t);
        continue;
      }
      byRoom[t.id] = look.tally.count;
      const newest = look.tally.newest;
      rooms.push({
        unread_count: look.tally.count,
        last_activity_at: newest?.created_at ?? null,
        last_message_preview: newest ? messagePreviewText(newest.content, newest.metadata) : null,
      });
    }
    return { ...unreadSummary(rooms), byRoom };
  }, [threads, looks]);
}
