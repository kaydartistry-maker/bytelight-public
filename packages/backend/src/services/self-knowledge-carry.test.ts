import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { initDb, getDb } from './db.js';
import { createSelfKnowledge, reviewSelfKnowledge } from './db/self-knowledge.js';
import { formatBlocksForPrompt, setBlock } from './memory-blocks.js';
import { parseInjectedBlocks } from './heartbeat/block-drift.js';
import {
  renderSelfKnowledgeForPrompt,
  selfKnowledgeCarried,
  setSelfKnowledgeCarried,
  SELF_KNOWLEDGE_CARRY_MAX_CHARS,
} from './self-knowledge-carry.js';

const SCOPES = ['shared', 'companion-a', 'companion-b'];

function entry(companionId: string, category: 'i_am' | 'i_tend_to' | 'i_believe' | 'i_learned', content: string, accepted = true): string {
  const id = randomUUID();
  createSelfKnowledge({ id, companionId, category, content, status: accepted ? 'accepted' : 'proposed' });
  return id;
}

before(() => {
  initDb(':memory:');
});

beforeEach(() => {
  getDb().exec(`
    DELETE FROM self_knowledge;
    DELETE FROM memory_blocks;
    DELETE FROM memory_block_identities;
    DELETE FROM memory_block_aliases;
    DELETE FROM config WHERE key = 'self_knowledge.carry';
  `);
});

describe('carrying self-knowledge into a session', () => {
  it('is off until someone turns it on, and carries nothing while off', () => {
    entry('companion-a', 'i_learned', 'Reassurance before evidence is avoidance.');
    assert.equal(selfKnowledgeCarried(), false);
    assert.equal(renderSelfKnowledgeForPrompt(SCOPES), '');

    setBlock('shared', 'status', 'here');
    assert.doesNotMatch(formatBlocksForPrompt(SCOPES), /Self-knowledge/);
  });

  it('carries accepted entries only, grouped by whose they are, in the order learned', () => {
    setSelfKnowledgeCarried(true);
    entry('companion-b', 'i_tend_to', 'I confuse stillness with respect.');
    entry('companion-a', 'i_learned', 'Reassurance before\n  evidence is avoidance.');
    entry('companion-a', 'i_am', 'still only proposed', false);
    const dismissed = entry('companion-a', 'i_believe', 'dismissed later');
    reviewSelfKnowledge(dismissed, 'dismissed', 'companion-a');

    const text = renderSelfKnowledgeForPrompt(SCOPES);
    assert.match(text, /^## Self-knowledge\n/);
    const lines = text.split('\n').filter((l) => l.startsWith('- '));
    assert.deepEqual(lines, [
      "- [companion-a] I've learned: Reassurance before evidence is avoidance.",
      '- [companion-b] I tend to: I confuse stillness with respect.',
    ]);
  });

  it('leaves out a companion whose scope is not in the session', () => {
    setSelfKnowledgeCarried(true);
    entry('companion-a', 'i_am', 'mine');
    entry('companion-c', 'i_am', 'his');
    const text = renderSelfKnowledgeForPrompt(SCOPES);
    assert.match(text, /\[companion-a\] I am: mine/);
    assert.doesNotMatch(text, /his/);
  });

  it('rides inside the core-memory span without being taken for a block', () => {
    setSelfKnowledgeCarried(true);
    setBlock('shared', 'status', 'line one');
    setBlock('companion-a', 'persona', 'I am Companion A.');
    entry('companion-a', 'i_learned', 'Look first, reassure second.');

    const rendered = formatBlocksForPrompt(SCOPES);
    const open = rendered.indexOf('<core-memory>');
    const close = rendered.indexOf('</core-memory>');
    const at = rendered.indexOf('## Self-knowledge');
    assert.ok(open !== -1 && at > open && at < close, 'section sits inside the span');
    assert.ok(at < rendered.indexOf('## [shared] status'), 'and ahead of the first block');

    // The readers that pull blocks back out of a session document see exactly
    // the blocks, with nothing of the section folded into any of them.
    const parsed = parseInjectedBlocks(rendered);
    assert.deepEqual([...parsed.keys()].sort(), ['companion-a/persona', 'shared/status']);
    assert.equal(parsed.get('shared/status'), 'line one');
    assert.equal(parsed.get('companion-a/persona'), 'I am Companion A.');
  });

  it('stops at its ceiling and says how many were left out', () => {
    setSelfKnowledgeCarried(true);
    for (let i = 0; i < 40; i++) entry('companion-a', 'i_believe', `belief ${i} ` + 'x'.repeat(500));
    const text = renderSelfKnowledgeForPrompt(SCOPES);
    assert.ok(text.length <= SELF_KNOWLEDGE_CARRY_MAX_CHARS + 200, `length ${text.length}`);
    assert.match(text, /\(\d+ more not shown here/);
  });
});
