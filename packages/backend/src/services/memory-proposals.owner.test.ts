/**
 * The operator's gate on the Archivist. The Archivist only proposes; a line reaches a
 * block when the operator approves it, and a rejected one never surfaces again.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { initDb, setConfig } from './db.js';
import {
  proposeEdit,
  markSurfaced,
  getProposal,
  listForOwnerReview,
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

test('a faded proposal is still in the operator\'s queue and can still be approved', () => {
  initDb(':memory:');
  setBlock('companion-b', 'continuity', '');
  const id = proposeEdit({ op: 'append', scope: 'companion-b', label: 'continuity', content: 'I kept my word' })!;
  markSurfaced([id]);
  markSurfaced([id]);
  markSurfaced([id]);
  assert.equal(getProposal(id)?.status, 'faded');
  assert.ok(listForOwnerReview().some((p) => p.id === id));
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
