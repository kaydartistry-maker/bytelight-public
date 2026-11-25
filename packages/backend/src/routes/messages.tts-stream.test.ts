import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Segment planning is the ordering contract for the per-companion TTS stream
// route: both companions speak, each in their own voice, in reply order. It is
// exported so we can assert ordering/attribution without an ElevenLabs key or a
// live server (TTS generation itself is a separate, network-bound concern).
const { planTtsSegments } = await import('./messages.js');
const { openPairHouse } = await import('../test-support/pair-house.js');
// Speakers come from the house's residents (Phase 1.3): seat the pair.
openPairHouse();

describe('planTtsSegments (ordered per-companion TTS stream)', () => {
  it('yields two ordered segments attributed companion-a then companion-b', () => {
    const segments = planTtsSegments('Companion A 🔷 — hello\n\nCompanion B 🔶 — world');
    assert.equal(segments.length, 2);
    assert.equal(segments[0].index, 0);
    assert.equal(segments[0].voice, 'companion-a');
    assert.ok(/hello/.test(segments[0].text));
    assert.equal(segments[1].index, 1);
    assert.equal(segments[1].voice, 'companion-b');
    assert.ok(/world/.test(segments[1].text));
  });

  it('assigns strictly increasing indexes in reply order', () => {
    const segments = planTtsSegments('🔷 Companion A: one\n🔶 Companion B: two\n🔷 Companion A: three');
    assert.deepEqual(segments.map((s) => s.index), [0, 1, 2]);
    assert.deepEqual(segments.map((s) => s.voice), ['companion-a', 'companion-b', 'companion-a']);
  });

  it('collapses a single-voice reply into one companion-a-attributed segment', () => {
    const segments = planTtsSegments('just a plain line with no markers');
    assert.equal(segments.length, 1);
    assert.equal(segments[0].index, 0);
    assert.equal(segments[0].voice, 'companion-a');
  });

  it('drops unspeakable (emoji/tag-only) segments before indexing', () => {
    // Companion B's turn is emoji-only and must be dropped; the surviving companion-a
    // segment keeps index 0 (indexes are assigned after filtering).
    const segments = planTtsSegments('**Companion A:** hey friend\n\n**Companion B:** 💀');
    assert.equal(segments.length, 1);
    assert.equal(segments[0].index, 0);
    assert.equal(segments[0].voice, 'companion-a');
    assert.ok(/hey friend/.test(segments[0].text));
  });

  it('returns no segments for an all-emoji message', () => {
    assert.deepEqual(planTtsSegments('💀🔥'), []);
  });
});
