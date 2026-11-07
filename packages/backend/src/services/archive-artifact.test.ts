/**
 * archive-artifact — snapshots are plumbing, not memories.
 * Adapted from Aerie (Apache 2.0); domain check aimed at our memory diet's
 * 'core-memory-archive' Neuralis domain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isArchiveArtifact, isArchiveRecord, ARCHIVE_DOMAIN } from './archive-artifact.js';

test('headline snapshot markers are artifacts', () => {
  assert.equal(isArchiveArtifact('PRE-THIN SNAPSHOT 2026-08-03 — memory block [shared] lore'), true);
  assert.equal(isArchiveArtifact('  PRE-REWRITE SNAPSHOT of persona'), true);
  assert.equal(isArchiveArtifact("FROM THE CLI LANE'S AUTO-MEMORY: ..."), true);
});

test('titled snapshots with the marker a few words in still match', () => {
  assert.equal(isArchiveArtifact('SHARED/LORE — PRE-THIN SNAPSHOT, Jul 30 2026'), true);
  assert.equal(isArchiveArtifact("[COMPANION-A] CONTINUITY — SNAPSHOT taken before rewrite"), true);
});

test('a memory that merely mentions the practice mid-sentence surfaces', () => {
  assert.equal(isArchiveArtifact('the operator asked how the pre-thin snapshot system works today'), false);
  assert.equal(isArchiveArtifact('We talked about snapshots of the garden'), false);
  assert.equal(isArchiveArtifact(''), false);
  assert.equal(isArchiveArtifact(undefined), false);
});

test('domain is the structural answer; patterns are cover', () => {
  assert.equal(isArchiveRecord({ domain: ARCHIVE_DOMAIN, content: 'anything at all' }), true);
  assert.equal(isArchiveRecord({ domain: 'byte-light', content: 'a real memory' }), false);
  assert.equal(isArchiveRecord({ domain: 'byte-light', content: 'PRE-THIN SNAPSHOT x' }), true);
  assert.equal(isArchiveRecord(undefined), false);
});
