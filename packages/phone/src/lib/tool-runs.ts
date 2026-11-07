// Tool runs — consecutive tool calls fold into ONE collapsible chip.
//
// A companion turn can fire a dozen tools back to back. Rendered one chip per
// call they ate the screen ("1 tool used" ×7); rendered as a single static
// count they could not be opened at all. A run is a maximal stretch of
// visible tool segments with nothing but hidden plumbing between them; any
// text, thinking or media segment ends the run, so a tool chip still sits
// where it happened in the turn.

import type { MessageSegment } from '../bytelight';

export type ToolSegment = MessageSegment & { type: 'tool' };

/**
 * Internal plumbing tools (outbox writes, companion-post acks) that never
 * render as chips, live or finalized.
 */
export function isHiddenTool(seg: ToolSegment): boolean {
  const inputLower = seg.input?.toLowerCase() || '';
  if (inputLower.includes('outbox')) return true;
  if (inputLower.includes('companion-post')) return true;
  if (seg.toolName === 'Bash') {
    if (/^(write\b|reply|acknowledge|ack\b|final reply|final outbox)/i.test(inputLower)) return true;
    if (/["']detail["']\s*:\s*["'](write\b|reply|acknowledge|ack\b)/i.test(inputLower)) return true;
  }
  return false;
}

export type SegmentItem =
  | { kind: 'segment'; segment: MessageSegment; index: number }
  | { kind: 'tools'; tools: ToolSegment[]; index: number };

/**
 * Group segments into display items. `isHidden` drops internal plumbing tools
 * entirely (they neither render nor break a run). `index` is the position of
 * the item's first segment in the input, a stable React key.
 */
export function groupToolRuns(
  segments: MessageSegment[],
  isHidden: (seg: ToolSegment) => boolean = () => false,
): SegmentItem[] {
  const items: SegmentItem[] = [];
  segments.forEach((segment, index) => {
    if (segment.type !== 'tool') {
      items.push({ kind: 'segment', segment, index });
      return;
    }
    if (isHidden(segment)) return;
    const last = items[items.length - 1];
    if (last && last.kind === 'tools') last.tools.push(segment);
    else items.push({ kind: 'tools', tools: [segment], index });
  });
  return items;
}

/** Pretty-print a tool's output: real newlines, indented JSON. Same as Svelte's formatToolOutput. */
export function formatToolOutput(raw: string): string {
  if (!raw) return '';
  const cleaned = raw.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  const trimmed = cleaned.trim();
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length > 2) {
    try { return JSON.stringify(JSON.parse(trimmed), null, 2); } catch { /* not JSON */ }
  }
  return cleaned;
}
