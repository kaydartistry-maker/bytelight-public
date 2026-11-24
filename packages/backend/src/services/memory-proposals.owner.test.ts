/**
 * The owner's window on the Archivist. The Archivist only proposes, and it
 * proposes to the companions. The owner can still file or drop any open row
 * herself, but an unclaimed one retires for her the same as it does for them.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { initDb, setConfig } from './db.js';
import {
  proposeEdit,
  markSurfaced,
  getProposal,
  listForOwnerReview,
  countForOwnerReview,
  listProposals,
  approveProposalForOwner,
  rejectProposalForOwner,
} from './memory-proposals.js';
import { getBlock, setBlock } from './memory-blocks.js';
import { archivistMode } from './memory-extraction.js';

test('the Archivist proposes by default; only the exact literal write opts out', () => {
  initDb(':memory:');
  assert.equal(archivistMode(), 'propose');
  for (const value of ['', 'Write', 'true', 'propose']) {
    setConfig('memext.mode', value);
    assert.equal(archivistMode(), 'propose', `memext.mode=${JSON.stringify(value)}`);
  }
  setConfig('memext.mode', 'write');
  assert.equal(archivistMode(), 'write');
});

test('approving writes the line and closes it as filed by the operator', () => {
  initDb(':memory:');
  setBlock('shared', 'lore', 'first line');
  const id = proposeEdit({ op: 'append', scope: 'shared', label: 'lore', content: 'second line' })!;
  assert.equal(getBlock('shared', 'lore')?.content, 'first line', 'a proposal alone writes nothing');

  const result = approveProposalForOwner(id, 'user');
  assert.equal(result.ok, true);
  assert.equal(getBlock('shared', 'lore')?.content, 'first line\nsecond line');
  assert.equal(getProposal(id)?.status, 'filed');
  assert.equal(getProposal(id)?.resolved_by, 'user');

  const again = approveProposalForOwner(id, 'user');
  assert.equal(again.ok, false);
  assert.equal(getBlock('shared', 'lore')?.content, 'first line\nsecond line', 'a second approve writes nothing');
});

test('rejecting drops it without touching the block', () => {
  initDb(':memory:');
  setBlock('companion-a', 'continuity', 'kept');
  const id = proposeEdit({ op: 'append', scope: 'companion-a', label: 'continuity', content: 'not this' })!;
  assert.equal(rejectProposalForOwner(id, 'user').ok, true);
  assert.equal(getProposal(id)?.status, 'dropped');
  assert.equal(getBlock('companion-a', 'continuity')?.content, 'kept');
  assert.equal(listForOwnerReview().some((p) => p.id === id), false);
});

test('a faded proposal leaves the owner\'s Review list but can still be filed by her', () => {
  initDb(':memory:');
  setBlock('companion-b', 'continuity', '');
  const live = proposeEdit({ op: 'append', scope: 'companion-b', label: 'continuity', content: 'still being offered' })!;
  const id = proposeEdit({ op: 'append', scope: 'companion-b', label: 'continuity', content: 'I kept my word' })!;
  markSurfaced([id]);
  markSurfaced([id]);
  markSurfaced([id]);
  assert.equal(getProposal(id)?.status, 'faded');

  assert.deepEqual(listForOwnerReview().map((p) => p.id), [live]);
  assert.equal(countForOwnerReview(), 1);
  assert.ok(listProposals('faded').some((p) => p.id === id), 'still listed under faded');

  assert.equal(approveProposalForOwner(id, 'user').ok, true);
  assert.match(getBlock('companion-b', 'continuity')?.content ?? '', /I kept my word/);
});

test('a replace whose old text is gone fails and leaves the proposal open', () => {
  initDb(':memory:');
  setBlock('shared', 'status', 'now');
  const id = proposeEdit({ op: 'replace', scope: 'shared', label: 'status', content: 'later', oldText: 'never there' })!;
  assert.throws(() => approveProposalForOwner(id, 'user'));
  assert.equal(getProposal(id)?.status, 'pending');
  assert.equal(getBlock('shared', 'status')?.content, 'now');
});
