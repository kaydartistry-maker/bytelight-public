// The whole of one thread, for Chat Export. The chat screen only holds the
// pages scrolled into view (50 at a time), so exporting from it saved a
// fragment. This walks the thread's message pages backwards with the same
// `before` cursor "load older" uses until the start of the thread.
import { apiFetch } from './api';
import type { Message } from './protocol';

export type FetchPage = (threadId: string, before: string | null, limit: number) => Promise<Message[]>;

const fetchPage: FetchPage = async (threadId, before, limit) => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before) params.set('before', before);
  const res = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/messages?${params}`);
  if (!res.ok) throw new Error(`Could not load the conversation (${res.status}).`);
  const body = await res.json().catch(() => null) as { messages?: Message[] } | null;
  if (!body || !Array.isArray(body.messages)) throw new Error('Could not load the conversation.');
  return body.messages;
};

/** Every stored message in the thread, oldest first. Throws rather than
 *  returning part of it, so an export is never silently short. */
export async function fetchWholeThread(threadId: string, page: FetchPage = fetchPage, pageSize = 200): Promise<Message[]> {
  const seen = new Set<string>();
  let all: Message[] = [];
  let before: string | null = null;
  for (;;) {
    const batch = await page(threadId, before, pageSize);
    const fresh = batch.filter((m) => !seen.has(m.id));
    if (fresh.length === 0) break;
    for (const m of fresh) seen.add(m.id);
    all = [...fresh, ...all];
    if (batch.length < pageSize) break;
    before = batch[0].id;
  }
  return all;
}
