import crypto from 'crypto';
import { Router } from 'express';
import { addTask } from '../services/cc.js';
import { createMessage, resolveRoutingThread, updateThreadActivity } from '../services/db.js';
import { registry } from '../services/registry.js';

// The brain sends into the house, by hand only. From the Mind console the operator
// can turn a brain thread into a Command Center task, or share a feeling,
// note or journal entry into her home chat as a quoted card. Nothing here
// runs on its own, pings anyone, or wakes the boys: a card in the chat is a
// system line, not a message from her and not a turn for them.

const TASK_MAX = 2000;
const SHARE_MAX = 8000;

export type ShareKind = 'feeling' | 'note' | 'journal';
const KINDS: ShareKind[] = ['feeling', 'note', 'journal'];

export interface ShareInput {
  kind: ShareKind;
  text: string;
  /** Whose it is: companion-a, companion-b or shared. */
  who?: string;
  /** The feeling word, if it has one. */
  emotion?: string;
  /** Who or what it's about. */
  about?: string;
  /** The day it was written, as the brain gave it. */
  day?: string;
}

const WHO: Record<string, string> = { 'companion-a': 'Companion A', 'companion-b': 'Companion B', shared: 'Companion A & Companion B' };

/** The card's words: a plain heading saying where it came from, then the
 *  brain's own text, quoted line by line. */
export function shareCard(input: ShareInput): string {
  const whose = input.who ? WHO[input.who.toLowerCase()] ?? '' : '';
  const what = input.kind === 'journal' ? 'journal entry' : input.kind;
  const head = [
    `From the brain · ${whose ? `${whose}'s ${what}` : `a ${what}`}`,
    input.emotion ? `(${input.emotion})` : '',
    input.about ? `about ${input.about}` : '',
    input.day ? `· ${input.day}` : '',
  ].filter(Boolean).join(' ');
  const quoted = input.text.trim().split('\n').map((l) => `> ${l}`).join('\n');
  return `${head}\n\n${quoted}`;
}

const short = (v: unknown, max = 80): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;

/** Reads a share request, or says what's wrong with it. */
export function readShare(body: unknown): ShareInput | string {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (!KINDS.includes(b.kind as ShareKind)) return 'kind must be feeling, note or journal';
  if (typeof b.text !== 'string' || !b.text.trim()) return 'text is required';
  if (b.text.length > SHARE_MAX) return 'too long to share';
  return {
    kind: b.kind as ShareKind,
    text: b.text,
    who: short(b.who, 20),
    emotion: short(b.emotion, 40),
    about: short(b.about),
    day: short(b.day, 30),
  };
}

export interface PostedCard { threadId: string; threadName: string; messageId: string }

export interface MindShareDeps {
  addTask?: (p: { text: string; created_by?: string }) => { id: string; text: string };
  postToHome?: (content: string, metadata: Record<string, unknown>) => PostedCard;
}

/** The house's own way of putting a system line in the home thread: the
 *  same createMessage + broadcast the image and Telegram lanes use. */
function postToHomeThread(content: string, metadata: Record<string, unknown>): PostedCard {
  const thread = resolveRoutingThread(registry);
  const now = new Date().toISOString();
  const message = createMessage({
    id: crypto.randomUUID(),
    threadId: thread.id,
    role: 'system',
    content,
    platform: 'api',
    metadata,
    createdAt: now,
  });
  updateThreadActivity(thread.id, now);
  registry.broadcast({ type: 'message', message });
  return { threadId: thread.id, threadName: thread.name, messageId: message.id };
}

export function createMindShareRoutes(deps: MindShareDeps = {}): Router {
  const router = Router();
  const makeTask = deps.addTask ?? addTask;
  const post = deps.postToHome ?? postToHomeThread;

  // A brain thread becomes a Command Center task, in its own words.
  router.post('/mind/share/task', (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) { res.status(400).json({ error: 'text is required' }); return; }
    if (text.length > TASK_MAX) { res.status(400).json({ error: 'too long for a task' }); return; }
    try {
      const task = makeTask({ text, created_by: 'user' });
      res.status(201).json({ ok: true, task: { id: task.id, text: task.text } });
    } catch (e) {
      console.warn('[mind-share] task failed:', e instanceof Error ? e.message : e);
      res.status(500).json({ error: 'the task could not be made' });
    }
  });

  // A feeling, note or journal entry, shared into the home chat as a card.
  router.post('/mind/share/chat', (req, res) => {
    const input = readShare(req.body);
    if (typeof input === 'string') { res.status(400).json({ error: input }); return; }
    const brainId = short(req.body?.brainId, 60);
    try {
      const posted = post(shareCard(input), { source: 'mind-console', kind: input.kind, ...(brainId ? { brainId } : {}) });
      res.status(201).json({ ok: true, ...posted });
    } catch (e) {
      console.warn('[mind-share] share failed:', e instanceof Error ? e.message : e);
      res.status(500).json({ error: 'it could not be shared' });
    }
  });

  return router;
}
