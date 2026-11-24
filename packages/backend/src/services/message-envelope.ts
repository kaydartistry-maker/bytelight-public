import type { ClientMessage, Message } from '@bytelight/shared';
/** Native send identity must not depend on a remote transcript or adapter. */
function canonicalPayload(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === 'object') return Object.fromEntries(
      Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sort(item)]),
    );
    return input;
  };
  return JSON.stringify(sort(value));
}
export function sameMessageEnvelope(existing: Message, msg: Extract<ClientMessage, { type: 'message' }>): boolean {
  return existing.role === 'user' && existing.thread_id === msg.threadId &&
    existing.content === msg.content && existing.content_type === (msg.contentType || 'text') &&
    (existing.reply_to_id || null) === (msg.replyToId || null) &&
    canonicalPayload(existing.metadata || {}) === canonicalPayload(msg.metadata || {});
}
