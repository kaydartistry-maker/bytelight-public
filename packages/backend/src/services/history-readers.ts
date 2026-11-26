// history-readers.ts — reading a chat export, one conversation at a time.
//
// An export can be hundreds of megabytes, so it is never read whole: the zip
// is inflated as a stream, the conversations.json inside it is split into its
// top-level elements as the bytes arrive, and each conversation is handed on
// and let go before the next is read.
//
// One reader per app. Each turns that app's conversation into the messages
// the person actually kept, in order. This slice reads Claude; an export from
// anywhere else is named and refused, never guessed at.

import { createReadStream } from 'node:fs';
import { Unzip, UnzipInflate } from 'fflate';
import type { PassageIn } from './history-passages.js';

// ── Splitting a JSON array as it streams ─────────────────────────────────────

/**
 * Feed text in pieces; get back each complete top-level element of the array
 * as its own string. Holds only the element being read.
 */
export class JsonArraySplitter {
  private started = false;
  private ended = false;
  private depth = 0;
  private inString = false;
  private escaped = false;
  private parts: string[] = [];
  private partStart = -1;

  push(text: string): string[] {
    const out: string[] = [];
    let i = 0;
    if (!this.started) {
      const open = text.indexOf('[');
      if (open < 0) {
        if (text.trim()) throw new Error('not a JSON array');
        return out;
      }
      if (text.slice(0, open).trim()) throw new Error('not a JSON array');
      this.started = true;
      i = open + 1;
    }
    if (this.depth > 0) this.partStart = i;
    for (; i < text.length && !this.ended; i++) {
      const ch = text[i];
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (ch === '\\') this.escaped = true;
        else if (ch === '"') this.inString = false;
        continue;
      }
      if (this.depth === 0) {
        if (ch === '{' || ch === '[') { this.depth = 1; this.partStart = i; this.parts = []; }
        else if (ch === ']') this.ended = true;
        else if (ch === '"') throw new Error('expected objects in the array');
        continue;
      }
      if (ch === '"') this.inString = true;
      else if (ch === '{' || ch === '[') this.depth++;
      else if (ch === '}' || ch === ']') {
        this.depth--;
        if (this.depth === 0) {
          this.parts.push(text.slice(this.partStart, i + 1));
          out.push(this.parts.join(''));
          this.parts = [];
          this.partStart = -1;
        }
      }
    }
    if (this.depth > 0 && this.partStart >= 0) this.parts.push(text.slice(this.partStart));
    return out;
  }

  /** True once the closing bracket was seen. */
  get done(): boolean { return this.ended; }
}

const EXPORT_ENTRY = /(^|\/)conversations\.json$/i;

/**
 * Hand every element of the export's conversations array to `onElement`,
 * one at a time. Takes a zip (the download as emailed) or the
 * conversations.json inside it.
 */
export async function readExportElements(path: string, onElement: (raw: unknown) => void): Promise<void> {
  const splitter = new JsonArraySplitter();
  const decoder = new TextDecoder('utf-8');
  const feed = (bytes: Uint8Array, final: boolean) => {
    const text = decoder.decode(bytes, { stream: !final });
    for (const el of splitter.push(text)) onElement(JSON.parse(el));
  };

  const stream = createReadStream(path, { highWaterMark: 1 << 20 });
  let zip: Unzip | null = null;
  let found = false;
  let failure: Error | null = null;
  let first = true;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    if (first) {
      first = false;
      if (chunk[0] === 0x50 && chunk[1] === 0x4b) {
        zip = new Unzip((file) => {
          if (found || !EXPORT_ENTRY.test(file.name)) return;
          found = true;
          file.ondata = (err, data, final) => {
            if (failure) return;
            if (err) { failure = err; return; }
            try { feed(data, final); } catch (e) { failure = e as Error; }
          };
          file.start();
        });
        zip.register(UnzipInflate);
      }
    }
    if (zip) zip.push(chunk);
    else {
      try { feed(chunk, false); } catch (e) { failure = e as Error; }
    }
    if (failure) break;
  }
  if (zip && !failure) zip.push(new Uint8Array(0), true);
  if (!zip && !failure) feed(new Uint8Array(0), true);
  if (failure) {
    stream.destroy();
    const f = failure as Error;
    throw f instanceof SyntaxError ? new Error(`That export could not be read: ${f.message}`) : f;
  }
  if (zip && !found) throw new Error('There is no conversations.json in that zip. Pick the export zip as it was emailed, or the conversations.json inside it.');
  if (!splitter.done) throw new Error('That export ends partway through. It may not have finished downloading.');
}

// ── Which app made it ────────────────────────────────────────────────────────

export type ExportSource = 'claude' | 'chatgpt' | 'unknown';

export function detectSource(raw: unknown): ExportSource {
  if (!raw || typeof raw !== 'object') return 'unknown';
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.chat_messages)) return 'claude';
  if (r.mapping && typeof r.mapping === 'object') return 'chatgpt';
  return 'unknown';
}

export const SOURCE_LABEL: Record<ExportSource, string> = { claude: 'Claude', chatgpt: 'ChatGPT', unknown: 'an app this house cannot read yet' };

/** Sources this house can read today. */
export const READABLE: ReadonlySet<ExportSource> = new Set(['claude']);

// ── One conversation, as kept ───────────────────────────────────────────────

export interface ReadChat {
  chat: string;
  title: string;
  /** When the chat started, ISO, or null. */
  startedAt: string | null;
  lines: PassageIn[];
  /** Messages left out because they were abandoned edits or regenerations. */
  dropped: number;
}

const ID = /^[\w-]{1,128}$/;

/** The words a person could see: text blocks only (thinking, tool calls and files are skipped). */
function claudeText(m: Record<string, unknown>): string {
  const content = m.content;
  if (Array.isArray(content) && content.length) {
    return content
      .filter((b): b is { type: string; text?: unknown } => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text')
      .map((b) => (typeof b.text === 'string' ? b.text : ''))
      .join('\n')
      .trim();
  }
  return typeof m.text === 'string' ? m.text.trim() : '';
}

/**
 * The messages on the path that was kept, in order. The export holds every
 * version of an edited or regenerated turn; the kept path ends at the newest
 * message and runs back through parent_message_uuid. When the links are
 * missing, export order is used rather than a guess.
 */
export function claudeKeptPath(messages: Record<string, unknown>[]): { path: Record<string, unknown>[]; dropped: number } {
  const byId = new Map<string, Record<string, unknown>>();
  for (const m of messages) if (typeof m.uuid === 'string') byId.set(m.uuid, m);
  if (!byId.size || !messages.every((m) => 'parent_message_uuid' in m)) return { path: messages, dropped: 0 };
  let leaf = messages[0];
  messages.forEach((m) => {
    if (String(m.created_at ?? '') >= String(leaf.created_at ?? '')) leaf = m;
  });
  const path: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let cur: Record<string, unknown> | undefined = leaf;
  while (cur && !seen.has(String(cur.uuid))) {
    seen.add(String(cur.uuid));
    path.push(cur);
    cur = byId.get(String(cur.parent_message_uuid));
  }
  path.reverse();
  return { path, dropped: messages.length - path.length };
}

export function readClaudeChat(raw: unknown): ReadChat | null {
  const c = raw as Record<string, unknown>;
  if (!c || typeof c.uuid !== 'string' || !ID.test(c.uuid)) return null;
  const messages = Array.isArray(c.chat_messages) ? (c.chat_messages as Record<string, unknown>[]).filter((m) => m && typeof m === 'object') : [];
  const { path, dropped } = claudeKeptPath(messages);
  const lines: PassageIn[] = [];
  for (const m of path) {
    const role = m.sender === 'human' ? 'user' : m.sender === 'assistant' ? 'assistant' : null;
    const text = claudeText(m);
    if (!role || !text || typeof m.uuid !== 'string' || !ID.test(m.uuid)) continue;
    lines.push({
      id: m.uuid,
      prev: lines.length ? lines[lines.length - 1].id : null,
      pos: lines.length,
      role,
      at: typeof m.created_at === 'string' ? m.created_at : null,
      text,
    });
  }
  if (!lines.length) return null;
  const title = (typeof c.name === 'string' ? c.name.trim() : '').slice(0, 300) || 'Untitled conversation';
  return { chat: c.uuid, title, startedAt: typeof c.created_at === 'string' ? c.created_at : lines[0].at, lines, dropped };
}

export function readChat(source: ExportSource, raw: unknown): ReadChat | null {
  return source === 'claude' ? readClaudeChat(raw) : null;
}
