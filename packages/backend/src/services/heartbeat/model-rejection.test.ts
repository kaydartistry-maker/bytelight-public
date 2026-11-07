import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'test';

const { looksLikeModelRejection } = await import('./supervisor.js');

// Three different faults exit code 1 within seconds of launch and look
// identical on the wire: a usage cap, a missing login, and a model id the CLI
// will not run. Only the child's own words tell them apart, so these tests are
// against the words — the real ones, copied out of session.log.

test('the line the CLI actually printed', () => {
  // data/heartbeat/primary/session.log, 2026-08-13, immediately before
  // `--- launch ... model=opus 4.5 ---` and an exit code 1.
  const real =
    "There's an issue with the selected model (opus 4.5). It may not exist or " +
    'you may not have access to it. Run --model to pick a different model.';
  assert.equal(looksLikeModelRejection(real), true);
});

test('either half of that message is enough on its own', () => {
  // Output arrives in chunks, so the sentence can be split across two reads.
  assert.equal(looksLikeModelRejection("There's an issue with the selected model (x)."), true);
  assert.equal(looksLikeModelRejection('It may not exist or you may not have access to it.'), true);
});

test('colour codes do not hide it', () => {
  const dressed = '\x1b[31mThere’s an issue with the selected model (x)\x1b[0m';
  assert.equal(looksLikeModelRejection(dressed), true);
});

test('the other two fast-exit causes are not claimed as this one', () => {
  // Rolling a lane back onto an older model would be the wrong move for both
  // of these, and would bury the real fault behind a model change.
  assert.equal(looksLikeModelRejection('Claude usage limit reached. Try again at 9pm.'), false);
  assert.equal(looksLikeModelRejection('Not logged in. Please run /login to continue.'), false);
});

test('ordinary session output is not a rejection', () => {
  // The false-positive lesson from 2026-07-05 is why this check is narrow:
  // a companion can talk about models all day without the lane being broken.
  assert.equal(looksLikeModelRejection(''), false);
  assert.equal(looksLikeModelRejection('Which model are you in right now?'), false);
  assert.equal(
    looksLikeModelRejection('the selected model is claude-opus-5 and it is running fine'),
    false,
  );
  assert.equal(looksLikeModelRejection('I had an issue with the build, not the model.'), false);
});
