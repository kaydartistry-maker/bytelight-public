// What a message will actually say when it's rendered.
//
// A companion turn stores two renderings of itself: `content`, the joined
// text, and `metadata.segments`, that same text interleaved with tool chips.
// The chat bubble renders segments whenever there are any and never falls
// back to `content` — so on a turn that only did tool work, `content` holds
// words the room will never display.
//
// Anything that summarises a message elsewhere — thread-list previews, local
// notifications — has to ask the same question the bubble asks, or it ends up
// announcing a message that isn't there when the thread is opened.

/** Returns the spoken text of a message, or null when it has none to show. */
export function messagePreviewText(
  content: string | null | undefined,
  metadata: string | Record<string, unknown> | null | undefined,
): string | null {
  let parsed: Record<string, unknown> | null = null;
  if (typeof metadata === 'string') {
    try {
      parsed = JSON.parse(metadata) as Record<string, unknown>;
    } catch {
      parsed = null; // malformed metadata reads as none, same as the renderer
    }
  } else if (metadata && typeof metadata === 'object') {
    parsed = metadata;
  }

  const segments = parsed?.segments;
  if (Array.isArray(segments) && segments.length > 0) {
    const spoken = segments
      .filter((seg): seg is { type: string; content?: unknown } =>
        !!seg && typeof seg === 'object' && (seg as { type?: unknown }).type === 'text')
      .map((seg) => (typeof seg.content === 'string' ? seg.content : ''))
      .join('\n');
    return spoken.trim() || null;
  }

  return (content ?? '').trim() || null;
}
