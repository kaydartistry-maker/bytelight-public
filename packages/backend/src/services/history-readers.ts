// history-readers.ts — reading a chat export, one conversation at a time.
//
// An export can be hundreds of megabytes, so it is never read whole: the zip
// is inflated as a stream, the conversations.json inside it is split into its
// top-level elements as the bytes arrive, and each conversation is handed on
// and let go before the next is read.
//
// One reader per app. Each turns that app's conversation into the messages
// the person actually kept, in order: Claude, ChatGPT, Gemini (Google
// Takeout activity) and Letta agent files today. An export from anywhere else
// is named and refused, never guessed at.

import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
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

/**
 * The files in an export zip that hold conversations: conversations.json, or
 * the numbered parts a large export is split into (conversations-000.json, …),
 * or, in a Google Takeout, the Gemini Apps activity (MyActivity.json).
 */
const EXPORT_ENTRY = /(^|\/)conversations(-\d+)?\.json$|(^|\/)Gemini Apps\/MyActivity\.json$/i;
/** A file read whole rather than streamed (a Letta agent file is one JSON object). */
const MAX_WHOLE_BYTES = 300 * 1024 * 1024;

const TRUNCATED = 'That export ends partway through. It may not have finished downloading.';

/** One JSON array arriving in pieces, decoded and split as it comes. */
function arrayReader(onElement: (raw: unknown) => void) {
  const splitter = new JsonArraySplitter();
  const decoder = new TextDecoder('utf-8');
  return {
    feed(bytes: Uint8Array, final: boolean) {
      const text = decoder.decode(bytes, { stream: !final });
      for (const el of splitter.push(text)) onElement(JSON.parse(el));
      if (final && !splitter.done) throw new Error(TRUNCATED);
    },
  };
}

const firstChar = (b: Buffer) => b.toString('utf-8', 0, Math.min(b.length, 64)).replace(/^\uFEFF/, '').trimStart()[0];

/** A file that is one object: a Letta agent file holds its agents in `agents`. */
function emitObject(obj: unknown, onElement: (raw: unknown) => void): void {
  const agents = (obj as { agents?: unknown })?.agents;
  if (!Array.isArray(agents)) throw new Error('That file is not a chat export this house can read.');
  for (const a of agents) onElement({ ...(a as object), __letta: true });
}

/**
 * Hand every element of the export's conversations array to `onElement`,
 * one at a time. Takes a zip (the download as emailed; every conversations
 * file inside it is read, in the order the zip holds them) or a
 * conversations.json on its own.
 */
export async function readExportElements(path: string, onElement: (raw: unknown) => void): Promise<void> {
  const stream = createReadStream(path, { highWaterMark: 1 << 20 });
  let zip: Unzip | null = null;
  let plain: ReturnType<typeof arrayReader> | null = null;
  let whole: Buffer[] | null = null;
  let wholeBytes = 0;
  let found = 0;
  let finished = 0;
  let failure: Error | null = null;
  let first = true;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    if (first) {
      first = false;
      if (chunk[0] === 0x50 && chunk[1] === 0x4b) {
        zip = new Unzip((file) => {
          if (failure || !EXPORT_ENTRY.test(file.name)) return;
          found++;
          const reader = arrayReader(onElement);
          file.ondata = (err, data, final) => {
            if (failure) return;
            if (err) { failure = err; return; }
            try {
              reader.feed(data, final);
              if (final) finished++;
            } catch (e) { failure = e as Error; }
          };
          file.start();
        });
        zip.register(UnzipInflate);
      } else if (firstChar(chunk) === '{') {
        whole = [];
      } else {
        plain = arrayReader(onElement);
      }
    }
    try {
      if (zip) zip.push(chunk);
      else if (whole) {
        wholeBytes += chunk.length;
        if (wholeBytes > MAX_WHOLE_BYTES) throw new Error('That file is too large to read in one piece.');
        whole.push(chunk);
      } else plain!.feed(chunk, false);
    } catch (e) { failure = failure ?? (e as Error); }
    if (failure) break;
  }
  if (!failure) {
    try {
      if (zip) zip.push(new Uint8Array(0), true);
      else if (whole) emitObject(JSON.parse(Buffer.concat(whole).toString('utf-8')), onElement);
      else if (plain) plain.feed(new Uint8Array(0), true);
      else throw new Error('That file is empty.');
    } catch (e) { failure = failure ?? (e as Error); }
  }
  if (failure) {
    stream.destroy();
    const f = failure as Error;
    throw f instanceof SyntaxError ? new Error(`That export could not be read: ${f.message}`) : f;
  }
  if (zip && !found) throw new Error('There is no conversations.json in that zip. Pick the export zip as it was emailed, or the conversations.json inside it.');
  if (zip && finished < found) throw new Error(TRUNCATED);
}

// ── Which app made it ────────────────────────────────────────────────────────

export type ExportSource = 'claude' | 'chatgpt' | 'gemini' | 'letta' | 'unknown';

export function detectSource(raw: unknown): ExportSource {
  if (!raw || typeof raw !== 'object') return 'unknown';
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.chat_messages)) return 'claude';
  if (r.mapping && typeof r.mapping === 'object') return 'chatgpt';
  if (r.__letta === true && Array.isArray(r.messages)) return 'letta';
  if (isGeminiActivity(r)) return 'gemini';
  return 'unknown';
}

export const SOURCE_LABEL: Record<ExportSource, string> = {
  claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini', letta: 'Letta', unknown: 'an app this house cannot read yet',
};

/** Sources this house can read today. */
export const READABLE: ReadonlySet<ExportSource> = new Set(['claude', 'chatgpt', 'gemini', 'letta']);

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

// ── ChatGPT ──────────────────────────────────────────────────────────────────
//
// Each conversation is a tree (`mapping`) of nodes, one per message, every
// edit and regeneration a branch of its own. The conversation as it was left
// is the branch ending at `current_node`, walked back through `parent`.
// Along that branch only what was said between the person and the assistant
// is kept: system and tool messages, the assistant's calls out to tools,
// hidden context (custom instructions, memory) and reasoning summaries are
// not anything either of them said in the chat.

interface GptMessage {
  id?: unknown;
  author?: { role?: unknown } | null;
  create_time?: unknown;
  content?: { content_type?: unknown; parts?: unknown; text?: unknown } | null;
  recipient?: unknown;
  metadata?: { is_visually_hidden_from_conversation?: unknown } | null;
}
interface GptNode { id?: unknown; parent?: unknown; message?: GptMessage | null }

const GPT_SPOKEN = new Set(['text', 'multimodal_text']);
// Inline citation markers ChatGPT writes into answers that used search
// (private-use characters around a reference, or 【12†source】).
const GPT_CITATION = /\ue200[^\ue201]*\ue201|【[^】]*†[^】]*】/g;

const gptTime = (v: unknown): string | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? new Date(v < 1e12 ? v * 1000 : v).toISOString() : null;

/** What the person or the assistant said in this message, or '' when it was not said in the chat. */
function gptSpoken(m: GptMessage | null | undefined): { role: 'user' | 'assistant'; text: string } | null {
  if (!m) return null;
  const role = m.author?.role;
  if (role !== 'user' && role !== 'assistant') return null;
  if (m.metadata?.is_visually_hidden_from_conversation === true) return null;
  if (role === 'assistant' && m.recipient !== undefined && m.recipient !== 'all') return null;
  const type = m.content?.content_type;
  if (!GPT_SPOKEN.has(String(type))) return null;
  const parts = Array.isArray(m.content?.parts) ? (m.content!.parts as unknown[]) : [];
  const text = parts.filter((x): x is string => typeof x === 'string').join('\n').replace(GPT_CITATION, '').trim();
  return text ? { role, text } : null;
}

export function readChatGptChat(raw: unknown): ReadChat | null {
  const c = raw as { id?: unknown; conversation_id?: unknown; title?: unknown; create_time?: unknown; mapping?: Record<string, GptNode>; current_node?: unknown };
  if (!c || !c.mapping || typeof c.mapping !== 'object') return null;
  const chatId = typeof c.conversation_id === 'string' ? c.conversation_id : typeof c.id === 'string' ? c.id : null;
  if (!chatId || !ID.test(chatId)) return null;
  const mapping = c.mapping;

  // Walk back from where the conversation was left.
  const onPath = new Set<string>();
  const chain: GptNode[] = [];
  let at = typeof c.current_node === 'string' ? c.current_node : null;
  while (at && mapping[at] && !onPath.has(at)) {
    onPath.add(at);
    chain.push(mapping[at]);
    at = typeof mapping[at].parent === 'string' ? (mapping[at].parent as string) : null;
  }
  chain.reverse();

  const lines: PassageIn[] = [];
  for (const node of chain) {
    const spoken = gptSpoken(node.message);
    const id = typeof node.message?.id === 'string' ? node.message.id : typeof node.id === 'string' ? node.id : null;
    if (!spoken || !id || !ID.test(id)) continue;
    lines.push({
      id,
      prev: lines.length ? lines[lines.length - 1].id : null,
      pos: lines.length,
      role: spoken.role,
      at: gptTime(node.message?.create_time),
      text: spoken.text,
    });
  }
  if (!lines.length) return null;

  // Messages someone could have read that are not on the kept branch: the abandoned drafts.
  let dropped = 0;
  for (const [key, node] of Object.entries(mapping)) if (!onPath.has(key) && gptSpoken(node?.message)) dropped++;

  const title = (typeof c.title === 'string' ? c.title.trim() : '').slice(0, 300) || 'Untitled conversation';
  return { chat: chatId, title, startedAt: gptTime(c.create_time) ?? lines[0].at, lines, dropped };
}

// ── Gemini ───────────────────────────────────────────────────────────────────
//
// Google keeps no conversations for Gemini, only activity: Takeout's My
// Activity → Gemini Apps → MyActivity.json is a flat list, newest first, one
// row per prompt: { header: 'Gemini Apps', title: 'Prompted <the words>',
// time, safeHtmlItem: [{ html: <the answer> }], subtitles: [...] }, with a
// link to the chat it belonged to when Google kept one. Rows are gathered
// back into their chats by that link; rows without one become one chat per
// day. (Layout as documented by the sibling fork that shipped a Gemini reader
// first; the code here is this house's own.) Rows are matched on Google's
// English wording, so a Takeout in another language is not recognised.

export function isGeminiActivity(r: Record<string, unknown>): boolean {
  return r.header === 'Gemini Apps' || (Array.isArray(r.products) && r.products.includes('Gemini Apps'));
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** An answer's HTML as plain text: line breaks where the page had them, no tags, entities decoded. */
export function htmlToText(html: string): string {
  let t = html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h[1-6]|tr|pre|blockquote)\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '- ');
  // Strip until none are left, so a tag hidden inside another cannot survive one pass.
  for (let prev = ''; prev !== t;) { prev = t; t = t.replace(/<[^<>]*>/g, ''); }
  t = t.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const shortHash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);

interface GeminiRow { t: number; order: number; at: string | null; prompt: string; answer: string }

function geminiRow(r: Record<string, unknown>, order: number): { key: string; row: GeminiRow } | null {
  const title = typeof r.title === 'string' ? r.title : '';
  if (!title.startsWith('Prompted ')) return null;
  const links = [
    typeof r.titleUrl === 'string' ? r.titleUrl : '',
    ...(Array.isArray(r.details) ? r.details : []).map((d) => (d && typeof (d as { url?: unknown }).url === 'string' ? (d as { url: string }).url : '')),
  ];
  const link = links.find((u) => /\/app\/[0-9a-f]+/i.test(u));
  const appId = link ? link.replace(/^.*\/app\//, '').replace(/[?#/].*$/, '') : '';
  const at = typeof r.time === 'string' && Number.isFinite(Date.parse(r.time)) ? new Date(r.time).toISOString() : null;
  const notes = (Array.isArray(r.subtitles) ? r.subtitles : [])
    .map((x) => String((x as { name?: unknown })?.name ?? '').trim().replace(/\.$/, ''))
    .filter((n) => /^Attached \d+ files?$|^\d+ generated images?$/i.test(n));
  const prompt = [title.slice('Prompted '.length).trim(), ...notes.filter((n) => /^Attached/i.test(n)).map((n) => `[${n}]`)].filter(Boolean).join('\n');
  const html = (Array.isArray(r.safeHtmlItem) ? r.safeHtmlItem : []).map((h) => String((h as { html?: unknown })?.html ?? '')).join('\n');
  const answer = [htmlToText(html), ...notes.filter((n) => /generated/i.test(n)).map((n) => `[${n}]`)].filter(Boolean).join('\n');
  const key = appId && /^[0-9a-f]{1,64}$/i.test(appId) ? `app-${appId}` : `day-${(at ?? 'undated').slice(0, 10)}`;
  return { key, row: { t: at ? Date.parse(at) : 0, order, at, prompt, answer } };
}

function geminiChats(groups: Map<string, GeminiRow[]>): ReadChat[] {
  const out: ReadChat[] = [];
  for (const [key, rows] of groups) {
    // Oldest first; the export lists newest first, so among equal times the later row came first.
    rows.sort((a, b) => (a.t - b.t) || (b.order - a.order));
    const lines: PassageIn[] = [];
    for (const row of rows) {
      const base = shortHash(`${row.at}|${row.prompt}`);
      for (const [role, text, suffix] of [['user', row.prompt, 'u'], ['assistant', row.answer, 'a']] as const) {
        if (!text) continue;
        const id = `${base}${suffix}`;
        lines.push({ id, prev: lines.length ? lines[lines.length - 1].id : null, pos: lines.length, role, at: row.at, text });
      }
    }
    if (!lines.length) continue;
    const first = rows[0].prompt.split('\n')[0].replace(/\s+/g, ' ').trim();
    out.push({
      chat: key,
      title: first.length > 60 ? `${first.slice(0, 57)}…` : first || 'Untitled conversation',
      startedAt: rows[0].at,
      lines,
      dropped: 0,
    });
  }
  return out;
}

// ── Letta ────────────────────────────────────────────────────────────────────
//
// A Letta agent file (.af) holds whole agents, each with its message history
// as one long line: no branches, no drafts. It is cut into one chat per day
// so a month can be chosen and an old window can say which day it was.
//
// What was said: the person's messages (older agents wrap them as JSON,
// {"type": "user_message", "message": ...}; heartbeats, logins and system
// alerts wrapped the same way are not anything anyone said), and the agent's
// replies. An agent that speaks through the send_message tool said what that
// call carried, and its plain text was inner monologue; an agent without it
// says its text directly. Reasoning, tool calls and tool results stay out.

interface LettaMessage { id?: unknown; role?: unknown; content?: unknown; tool_calls?: unknown; created_at?: unknown }

function lettaText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && typeof c === 'object' && (c as { type?: unknown }).type === 'text' && typeof (c as { text?: unknown }).text === 'string')
    .map((c) => (c as { text: string }).text)
    .join('\n')
    .trim();
}

function lettaSentMessages(m: LettaMessage): string[] {
  const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
  const out: string[] = [];
  for (const call of calls) {
    const fn = (call as { function?: { name?: unknown; arguments?: unknown } })?.function;
    if (fn?.name !== 'send_message' || typeof fn.arguments !== 'string') continue;
    try {
      const msg = (JSON.parse(fn.arguments) as { message?: unknown }).message;
      if (typeof msg === 'string' && msg.trim()) out.push(msg.trim());
    } catch { /* a call that never parsed was never sent */ }
  }
  return out;
}

/** The person's words, unwrapped; '' for a heartbeat, login or system alert. */
function lettaUserWords(text: string): string {
  if (!text.startsWith('{')) return text;
  try {
    const o = JSON.parse(text) as { type?: unknown; message?: unknown };
    if (o && typeof o === 'object' && 'type' in o) return o.type === 'user_message' && typeof o.message === 'string' ? o.message.trim() : '';
  } catch { /* plain text that happens to start with a brace */ }
  return text;
}

export function readLettaAgent(raw: unknown): ReadChat[] {
  const a = raw as { id?: unknown; name?: unknown; messages?: unknown };
  const messages = (Array.isArray(a?.messages) ? a.messages : []) as LettaMessage[];
  const agentId = typeof a.id === 'string' && ID.test(a.id) ? a.id : `agent-${shortHash(String(a.name ?? ''))}`;
  const name = (typeof a.name === 'string' && a.name.trim()) || 'Letta agent';
  const speaksByTool = messages.some((m) => lettaSentMessages(m).length > 0);

  const byDay = new Map<string, PassageIn[]>();
  messages.forEach((m, i) => {
    const at = typeof m.created_at === 'string' && Number.isFinite(Date.parse(m.created_at)) ? new Date(m.created_at).toISOString() : null;
    let said: { role: 'user' | 'assistant'; text: string }[] = [];
    if (m.role === 'user') {
      const text = lettaUserWords(lettaText(m.content));
      if (text) said = [{ role: 'user', text }];
    } else if (m.role === 'assistant') {
      said = (speaksByTool ? lettaSentMessages(m) : [lettaText(m.content)].filter(Boolean)).map((text) => ({ role: 'assistant' as const, text }));
    }
    const baseId = typeof m.id === 'string' && ID.test(m.id) ? m.id : `m${i}`;
    said.forEach((x, k) => {
      const day = at ? at.slice(0, 10) : 'undated';
      const lines = byDay.get(day) ?? [];
      const id = k ? `${baseId}-${k}` : baseId;
      lines.push({ id, prev: lines.length ? lines[lines.length - 1].id : null, pos: lines.length, role: x.role, at, text: x.text });
      byDay.set(day, lines);
    });
  });

  const out: ReadChat[] = [];
  for (const [day, lines] of byDay) {
    const label = day === 'undated' ? 'undated' : new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    out.push({ chat: `${agentId}-${day}`, title: `${name} · ${label}`, startedAt: lines[0].at, lines, dropped: 0 });
  }
  return out;
}

// ── One reader per export ────────────────────────────────────────────────────

/**
 * Turns an export's elements into chats. Most apps give one conversation per
 * element; Gemini's chats are gathered across all its rows, so they come out
 * of finish() once the whole export has been read.
 */
export interface ChatReader {
  take(raw: unknown): ReadChat[];
  finish(): ReadChat[];
}

export function chatReader(source: ExportSource): ChatReader {
  if (source === 'gemini') {
    const groups = new Map<string, GeminiRow[]>();
    let order = 0;
    return {
      take(raw) {
        if (!raw || typeof raw !== 'object' || !isGeminiActivity(raw as Record<string, unknown>)) return [];
        const r = geminiRow(raw as Record<string, unknown>, order++);
        if (r) {
          const rows = groups.get(r.key) ?? [];
          rows.push(r.row);
          groups.set(r.key, rows);
        }
        return [];
      },
      finish: () => geminiChats(groups),
    };
  }
  const one = (raw: unknown): ReadChat[] => {
    if (source === 'claude') { const c = readClaudeChat(raw); return c ? [c] : []; }
    if (source === 'chatgpt') { const c = readChatGptChat(raw); return c ? [c] : []; }
    if (source === 'letta') return readLettaAgent(raw);
    return [];
  };
  return { take: one, finish: () => [] };
}
