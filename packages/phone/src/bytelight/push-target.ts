// The app's half of a push tap. The service worker (public/sw.js) either
// posts `bytelight:open-thread` to an open window or opens a new one at
// /?thread=<id>&message=<id>; both land here as a PushJump.

export interface PushJump {
  threadId: string;
  messageId: string | null;
}

export const OPEN_THREAD_MESSAGE = 'bytelight:open-thread';

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The jump a cold-start URL asks for, if any. */
export function pushJumpFromSearch(search: string): PushJump | null {
  const params = new URLSearchParams(search);
  const threadId = str(params.get('thread'));
  if (!threadId) return null;
  return { threadId, messageId: str(params.get('message')) };
}

/** The same URL with the jump params removed, so a reload doesn't jump again. */
export function stripPushJumpParams(href: string): string {
  const url = new URL(href);
  url.searchParams.delete('thread');
  url.searchParams.delete('message');
  return url.pathname + url.search + url.hash;
}

/** The jump a service-worker message asks for, if it's one of ours. */
export function pushJumpFromMessage(data: unknown): PushJump | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { type?: unknown; threadId?: unknown; messageId?: unknown };
  if (d.type !== OPEN_THREAD_MESSAGE) return null;
  const threadId = str(d.threadId);
  if (!threadId) return null;
  return { threadId, messageId: str(d.messageId) };
}
