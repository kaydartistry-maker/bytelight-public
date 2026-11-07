/**
 * The fallback a refused lane reaches for.
 *
 * These pin the SHAPE the 2026-08-13 incident had, not just the rule: a junk
 * model id was picked, the lane died at the door, and the failsafe built two
 * nights earlier had nothing to substitute — because the id it had banked as
 * "proven" was the junk one, banked by a still-living session one tick before
 * it was asked to recycle. The setting had already moved; the child had not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { proveFallbackModel, readBankedModel, writeBankedModel } from './supervisor.js';

const WINDOW = 180_000;

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'bl-bank-'));
}

test('a session past the fast-exit window proves the model it launched on', () => {
  assert.equal(
    proveFallbackModel({ lastGood: null, launchedModel: 'claude-opus-5', uptimeMs: WINDOW + 1, fastExitWindowMs: WINDOW }),
    'claude-opus-5',
  );
});

test('nothing is proven while the session is still inside the window a bad id dies in', () => {
  assert.equal(
    proveFallbackModel({ lastGood: null, launchedModel: 'claude-opus-5', uptimeMs: WINDOW, fastExitWindowMs: WINDOW }),
    null,
  );
  assert.equal(
    proveFallbackModel({ lastGood: null, launchedModel: 'claude-opus-5', uptimeMs: 2_000, fastExitWindowMs: WINDOW }),
    null,
  );
});

test('an already-banked model is not banked again', () => {
  assert.equal(
    proveFallbackModel({ lastGood: 'claude-opus-5', launchedModel: 'claude-opus-5', uptimeMs: WINDOW * 10, fastExitWindowMs: WINDOW }),
    null,
  );
});

test('a lane that has never launched proves nothing, however long it has sat there', () => {
  assert.equal(
    proveFallbackModel({ lastGood: null, launchedModel: '', uptimeMs: WINDOW * 100, fastExitWindowMs: WINDOW }),
    null,
  );
});

test('the id she just picked cannot become its own fallback', () => {
  // The incident, in the only terms this function can see it. The lane had been
  // up on 4.5 for twenty minutes when a junk id was selected; the setting moved
  // to the junk id immediately and the recycle was requested a tick later. The
  // only id passed in here is the one the CHILD was spawned on, so the freshly
  // picked one is not reachable from this function at all — which is the whole
  // point. Bank 4.5, then refuse the junk id, and there is something to reach.
  const proven = proveFallbackModel({
    lastGood: null,
    launchedModel: 'claude-opus-4-5',
    uptimeMs: 20 * 60_000,
    fastExitWindowMs: WINDOW,
  });
  assert.equal(proven, 'claude-opus-4-5');
  assert.notEqual(proven, 'not-a-model');
});

test('a lane that keeps running re-proves the same model without churn', () => {
  const first = proveFallbackModel({ lastGood: null, launchedModel: 'claude-opus-5', uptimeMs: WINDOW + 1, fastExitWindowMs: WINDOW });
  assert.equal(first, 'claude-opus-5');
  // Next poll, two seconds later: already banked, so no write.
  assert.equal(
    proveFallbackModel({ lastGood: first, launchedModel: 'claude-opus-5', uptimeMs: WINDOW + 3_000, fastExitWindowMs: WINDOW }),
    null,
  );
});

/**
 * The bank has to outlive the process that filled it. These pin the SHAPE of
 * the 2026-08-14 retest: the backend was restarted to make the failsafe live,
 * the lane's very first launch was the junk id, and the bank was empty because
 * a restart had just cleared it. The guard sentence fired and was telling the
 * truth. What follows is the same incident with the file in place.
 */
test('a model banked by one process is in hand for the next one', () => {
  const dir = scratch();
  try {
    const path = join(dir, '.last-good-model');
    writeBankedModel(path, 'claude-opus-5');
    assert.equal(readBankedModel(path), 'claude-opus-5');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the restart shape: a fresh lane whose first launch is a junk id still has somewhere to go', () => {
  const dir = scratch();
  try {
    const path = join(dir, '.last-good-model');
    // Process one: up on a real id long enough to prove it, and it banks.
    const proven = proveFallbackModel({ lastGood: null, launchedModel: 'claude-opus-5', uptimeMs: WINDOW + 1, fastExitWindowMs: WINDOW });
    assert.equal(proven, 'claude-opus-5');
    writeBankedModel(path, proven!);
    // Process two, born from a restart: nothing launched yet, nothing in
    // memory. Before this file existed the answer here was null and the lane
    // slept five minutes twice over.
    assert.equal(readBankedModel(path), 'claude-opus-5');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('absent means unknown, never false', () => {
  const dir = scratch();
  try {
    // No file at all — a house that has genuinely never proved a model. The
    // lane must fall through to sleeping and saying so, not assert an id.
    assert.equal(readBankedModel(join(dir, '.last-good-model')), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an empty or torn file reads as unknown rather than as a model', () => {
  const dir = scratch();
  try {
    const path = join(dir, '.last-good-model');
    for (const junk of ['', '   \n', 'claude opus 5', 'x'.repeat(201)]) {
      writeFileSync(path, junk);
      assert.equal(readBankedModel(path), null, `should not have trusted ${JSON.stringify(junk.slice(0, 20))}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a write leaves no half-written file behind it', () => {
  const dir = scratch();
  try {
    const path = join(dir, '.last-good-model');
    writeBankedModel(path, 'claude-opus-5');
    // tmp+rename, so the visible file is never the empty one — and the scratch
    // file does not survive to be mistaken for the real one later.
    assert.equal(existsSync(`${path}.tmp`), false);
    assert.equal(readBankedModel(path), 'claude-opus-5');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an empty id is never banked over a good one', () => {
  const dir = scratch();
  try {
    const path = join(dir, '.last-good-model');
    writeBankedModel(path, 'claude-opus-5');
    writeBankedModel(path, '');
    assert.equal(readBankedModel(path), 'claude-opus-5');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
