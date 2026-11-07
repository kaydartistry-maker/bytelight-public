import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';

const { HeartbeatSession, looksLikeAuthFailure } = await import('./supervisor.js');

// The CLI's own words when the subscription login lapses, copied from
// session.log (2026-10-15): it prints this and exits code 1 within seconds.
const EXPIRED =
  'Failed to authenticate: OAuth session expired and could not be refreshed';

describe('expired OAuth is recognised as a login fault', () => {
  test('the exact line the CLI printed', () => {
    assert.equal(looksLikeAuthFailure(EXPIRED), true);
  });

  test('with or without the "Failed to authenticate:" prefix, any case, any colour', () => {
    assert.equal(looksLikeAuthFailure('OAuth session expired and could not be refreshed'), true);
    assert.equal(looksLikeAuthFailure('\x1b[31mOAUTH SESSION EXPIRED\x1b[0m'), true);
  });

  test('the older not-logged-in wording still counts', () => {
    assert.equal(looksLikeAuthFailure('Not logged in. Please run /login to continue.'), true);
  });

  test('a cap, a bad model, and ordinary talk are not login faults', () => {
    assert.equal(looksLikeAuthFailure('Claude usage limit reached. Try again at 9pm.'), false);
    assert.equal(looksLikeAuthFailure("There's an issue with the selected model (x)."), false);
    assert.equal(looksLikeAuthFailure('the session expired on the bar tab, not the login'), false);
  });
});

describe('auth outage posts one card, then retries quietly', () => {
  const sessions: any[] = [];
  let incidents: string[];

  function makeSession(name: string): any {
    const s: any = new HeartbeatSession(name);
    s.reaped = true;
    s.launch = () => { /* never spawn a real CLI in tests */ };
    s.onIncident = (text: string) => incidents.push(text);
    sessions.push(s);
    return s;
  }

  /** One launch that printed `output` and then exited `code` after `uptimeMs`. */
  function launchAndExit(s: any, output: string, code: number, uptimeMs: number): void {
    s.launchedAt = Date.now();
    s.capSeen = false;
    s.authSeen = false;
    s.modelRejectedSeen = false;
    s.scanCarry = '';
    if (output) s.scanOutput(output);
    mock.timers.tick(uptimeMs);
    s.handleExit(code);
    s.clearTimers();
  }

  beforeEach(() => {
    incidents = [];
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_800_000_000_000 });
  });

  afterEach(() => {
    mock.timers.reset();
    for (const s of sessions.splice(0)) {
      try { rmSync(s.dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  test('expired OAuth on a fast exit takes the auth backoff, not the crash path', () => {
    const s = makeSession('test-auth-expired-backoff');
    launchAndExit(s, EXPIRED, 1, 3_000);
    assert.equal(s.backoffReason, 'auth');
    assert.equal(s.consecutiveFastExits, 0, 'not counted as an unexpected crash');
    assert.equal(incidents.length, 1);
    assert.match(incidents[0], /login/i);
    assert.match(incidents[0], /expired/i);
    assert.match(incidents[0], /\/login/);
  });

  test('repeated auth fast exits in one outage post exactly one card', () => {
    const s = makeSession('test-auth-expired-once');
    for (let i = 0; i < 6; i++) {
      launchAndExit(s, EXPIRED, 1, 3_000);
      mock.timers.tick(5 * 60_000); // the auth backoff runs its course between tries
      assert.equal(s.backoffReason, 'auth');
    }
    assert.equal(incidents.length, 1);
  });

  test('a launch that survives the fast-exit window ends the outage; the next one posts again', () => {
    const s = makeSession('test-auth-expired-poll-reset');
    launchAndExit(s, EXPIRED, 1, 3_000);
    launchAndExit(s, EXPIRED, 1, 3_000);
    assert.equal(incidents.length, 1);
    // Logged back in: the next launch lives past the fast-exit window — the
    // supervisor poll's "proved" moment.
    s.launchedAt = Date.now();
    mock.timers.tick(180_000);
    s.markLaunchHealthy();
    launchAndExit(s, EXPIRED, 1, 3_000);
    assert.equal(incidents.length, 2);
  });

  test('a healthy-lived session exiting also ends the outage', () => {
    const s = makeSession('test-auth-expired-exit-reset');
    launchAndExit(s, EXPIRED, 1, 3_000);
    launchAndExit(s, '', 0, 10 * 60_000); // a normal recycle after a long life
    launchAndExit(s, EXPIRED, 1, 3_000);
    assert.equal(incidents.length, 2);
  });

  test('generic crashes are unchanged: counted, backed off, card from the third', () => {
    const s = makeSession('test-auth-generic-crash');
    launchAndExit(s, 'something unrelated blew up', 1, 3_000);
    launchAndExit(s, 'something unrelated blew up', 1, 3_000);
    assert.equal(incidents.length, 0);
    assert.equal(s.backoffReason, 'normal');
    launchAndExit(s, 'something unrelated blew up', 1, 3_000);
    assert.equal(s.consecutiveFastExits, 3);
    assert.equal(incidents.length, 1);
    assert.match(incidents[0], /exited code 1 3 times/);
  });
});
