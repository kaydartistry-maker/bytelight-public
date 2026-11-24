// self-knowledge-carry.ts — what a companion has learned about itself, carried
// into the session it wakes up in.
//
// Self-knowledge entries were written, accepted, and then read by nothing: the
// only way back to one was a manual search. A lesson that is filed where its
// owner never sees it changes nothing.
//
// This is NOT the per-turn auto-surfacing the source fork wired into the
// whisper (still deliberately off, see db/self-knowledge.ts): nothing here is
// retrieved per message, nothing warms or cools, and no entry is chosen over
// another. It is the plain version: the accepted entries, all of them, ride in
// the session document once, beside the core-memory blocks.
//
// OFF BY DEFAULT. The owner ruled in September that nothing auto-injects
// self-knowledge, so carrying it is a switch she turns on herself (the phone's
// Self-Knowledge screen), not something a deploy turns on for her.

import { getConfig, setConfig } from './db.js';
import {
  listSelfKnowledge,
  type SelfKnowledgeCategory,
  type SelfKnowledgeEntry,
} from './db/self-knowledge.js';

export const SELF_KNOWLEDGE_CARRY_KEY = 'self_knowledge.carry';

/** Generous for a list of one-line truths; a hard stop against a runaway. */
export const SELF_KNOWLEDGE_CARRY_MAX_CHARS = 8_000;
const ENTRY_MAX_CHARS = 600;

const DRAWER: Record<SelfKnowledgeCategory, string> = {
  i_am: 'I am',
  i_tend_to: 'I tend to',
  i_believe: 'I believe',
  i_learned: "I've learned",
};

export function selfKnowledgeCarried(): boolean {
  try {
    return getConfig(SELF_KNOWLEDGE_CARRY_KEY) === 'true';
  } catch {
    return false; // no settings table (tests importing standalone): off
  }
}

export function setSelfKnowledgeCarried(on: boolean): void {
  setConfig(SELF_KNOWLEDGE_CARRY_KEY, on ? 'true' : 'false');
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > ENTRY_MAX_CHARS ? flat.slice(0, ENTRY_MAX_CHARS).trimEnd() + '…' : flat;
}

/**
 * The accepted entries for these scopes as one section, or '' when the switch
 * is off, nothing is accepted, or the table cannot be read.
 *
 * The heading is deliberately not a block heading (`## [scope] label`): this
 * text sits inside the core-memory span, ahead of the first block, and the
 * readers that pull blocks back out of a session document must not take it
 * for one (heartbeat/block-drift.ts parseInjectedBlocks skips everything
 * before the first block heading).
 */
export function renderSelfKnowledgeForPrompt(scopes: string[]): string {
  if (!selfKnowledgeCarried()) return '';
  let accepted: SelfKnowledgeEntry[];
  try {
    accepted = listSelfKnowledge({ status: 'accepted', limit: 500 }).entries;
  } catch {
    return '';
  }
  const wanted = new Set(scopes);
  // Oldest first, so the list reads in the order it was learned.
  const mine = accepted
    .filter((e) => wanted.has(e.companion_id))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (mine.length === 0) return '';

  const head =
    '## Self-knowledge\n' +
    'What each of you has come to know about yourself, in your own words. These are accepted entries and they are yours. ' +
    'When something about you proves true more than once, add it with the self_knowledge tool; you accept or dismiss your own.\n';
  const lines: string[] = [];
  let used = head.length;
  let left = 0;
  for (const scope of scopes) {
    for (const entry of mine.filter((e) => e.companion_id === scope)) {
      const line = `- [${scope}] ${DRAWER[entry.category] ?? entry.category}: ${oneLine(entry.content)}`;
      if (used + line.length + 1 > SELF_KNOWLEDGE_CARRY_MAX_CHARS) {
        left++;
        continue;
      }
      lines.push(line);
      used += line.length + 1;
    }
  }
  if (lines.length === 0) return '';
  if (left > 0) lines.push(`- (${left} more not shown here; read them with the self_knowledge tool)`);
  return head + lines.join('\n') + '\n\n';
}
