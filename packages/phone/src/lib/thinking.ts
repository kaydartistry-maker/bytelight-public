import type { MessageSegment } from '../bytelight';

const RECYCLE_PREFIX = '[Session recycled';
const CODEX_THOUGHT_PREFIX = '[BYTELIGHT_THOUGHT]';

/**
 * Thinking cards already supply their own italic, muted presentation. Strip
 * Markdown's presentation markers so provider summaries such as
 * `**Checking the renderer**` do not leak asterisks into the card title or
 * become a second layer of typography in the expanded body.
 */
export function plainThinkingText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    // Internal routing marker for Codex's authored companion-perspective card.
    // It keeps the segment distinct from spoken commentary but is never UI.
    .replace(/^\s*\[BYTELIGHT_THOUGHT\]\s*\n?/i, '')
    .replace(/^```[^\n]*\n?/gm, '')
    .replace(/^```\s*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-+]\s+/gm, '• ')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*([\s\S]*?)\*\*/g, '$1')
    .replace(/__([\s\S]*?)__/g, '$1')
    .replace(/~~([\s\S]*?)~~/g, '$1')
    // Single emphasis markers are only removed when they form a pair. This
    // leaves technical text such as *.tsx intact.
    .replace(/(^|[\s([{])\*([^*\n]+)\*(?=$|[\s)\]},.!?:;])/gm, '$1$2')
    .replace(/(^|[\s([{])_([^_\n]+)_(?=$|[\s)\]},.!?:;])/gm, '$1$2')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function thinkingText(segment: MessageSegment): string {
  return segment.type === 'thinking' ? (segment.content || segment.summary || '') : '';
}

export function isAuthoredThinking(segment: MessageSegment): boolean {
  return segment.type === 'thinking'
    && (segment.kind === 'authored'
      || (segment.content || '').trimStart().startsWith(CODEX_THOUGHT_PREFIX));
}

function thinkingParts(value: string): string[] {
  return plainThinkingText(value)
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Merge provider phase summaries while preserving their order and wording. */
export function mergeThinkingText(values: string[]): string {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const value of values) {
    for (const part of thinkingParts(value)) {
      const key = part.replace(/\s+/g, ' ').toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(part);
    }
  }

  return merged.join('\n\n');
}

export function thinkingTitle(value: string): string {
  const firstPart = thinkingParts(value)[0] || 'Thinking…';
  const oneLine = firstPart.replace(/\s+/g, ' ');
  return oneLine.length > 100 ? `${oneLine.slice(0, 97)}...` : oneLine;
}

function isRecycleThinking(segment: MessageSegment): boolean {
  return segment.type === 'thinking'
    && (segment.kind === 'system'
      || (segment.content || segment.summary || '').startsWith(RECYCLE_PREFIX));
}

/**
 * Codex can expose the same reasoning as individual commentary phases and as
 * grouped provider summaries. Present those as one thought card, like the
 * Claude lane, while leaving session-recycle seams independent.
 */
export function coalesceThinkingSegments(segments: MessageSegment[]): MessageSegment[] {
  const coalesceRun = (run: MessageSegment[]): MessageSegment[] => {
    const authoredWins = run.some(isAuthoredThinking);
    const kept = (authoredWins ? run.filter(isAuthoredThinking) : run)
      .filter((segment) => segment.type === 'thinking' && !isRecycleThinking(segment));
    const values = kept.map(thinkingText);

    // Empty thinking is absence, not a tappable card titled "Thinking…".
    if (values.every((value) => !plainThinkingText(value))) {
      return run.filter((segment) => segment.type !== 'thinking' || isRecycleThinking(segment));
    }

    const thinkingCount = run.filter(
      (segment) => segment.type === 'thinking' && !isRecycleThinking(segment),
    ).length;
    const singleKeptHasBody = kept[0]?.type === 'thinking'
      && !!plainThinkingText(kept[0].content);
    if (kept.length === 1 && kept.length === thinkingCount && singleKeptHasBody) return run;

    const content = mergeThinkingText(values);
    if (!content) {
      return run.filter((segment) => segment.type !== 'thinking' || isRecycleThinking(segment));
    }
    const firstKept = kept[0];
    const mergedKind = authoredWins
      ? 'authored'
      : (firstKept?.type === 'thinking' ? firstKept.kind : undefined);
    const merged: MessageSegment = {
      type: 'thinking',
      content,
      summary: thinkingTitle(content),
      ...(mergedKind ? { kind: mergedKind } : {}),
    };
    let inserted = false;
    return run.flatMap((segment) => {
      if (segment.type !== 'thinking' || isRecycleThinking(segment)) return [segment];
      if (authoredWins && !isAuthoredThinking(segment)) return [];
      if (inserted) return [];
      inserted = true;
      return [merged];
    });
  };

  // Spoken text is a hard boundary. Consolidate the provider's little phase
  // labels on each side, but never pull later thinking above words the
  // companion said mid-turn. Tool calls are transparent within a thought run.
  const output: MessageSegment[] = [];
  let run: MessageSegment[] = [];
  const flush = () => {
    if (run.length > 0) output.push(...coalesceRun(run));
    run = [];
  };

  for (const segment of segments) {
    const boundary = isRecycleThinking(segment)
      || segment.type === 'sticker'
      || segment.type === 'emoji'
      || (segment.type === 'text' && !!segment.content.trim());
    if (boundary) {
      flush();
      output.push(segment);
    } else {
      run.push(segment);
    }
  }
  flush();
  return output;
}
