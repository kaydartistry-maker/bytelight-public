// One sign-in: a house with no login of its own borrows the Codex CLI's
// (`codex login`). It never refreshes that token itself; when it is stale it
// asks the CLI to refresh its own login. These tests pin that contract.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getCodexAccessToken,
  getCodexAuthSnapshot,
  isCodexLoggedIn,
  CodexAuthRequiredError,
  __setCodexCliRefresherForTests,
  __TEST_PROVIDERS__,
  _resetForTests,
  getLoginSession,
  startCodexLogin,
} from './codex-oauth.js';

function fakeJwt(expSecondsFromNow: number, tag = 'a'): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow, tag })}.sig`;
}

let dir: string;
let housePath: string;
let cliPath: string;
const writeCli = (access: string) =>
  writeFileSync(cliPath, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: access, refresh_token: 'r', id_token: 'i', account_id: 'acct' } }));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-cli-fallback-'));
  housePath = join(dir, 'codex-auth.json');
  cliPath = join(dir, 'cli-auth.json');
  process.env.CODEX_AUTH_PATH = housePath;
  process.env.CODEX_CLI_AUTH_PATH = cliPath;
  __setCodexCliRefresherForTests(null);
});

afterEach(() => {
  delete process.env.CODEX_AUTH_PATH;
  delete process.env.CODEX_CLI_AUTH_PATH;
  __setCodexCliRefresherForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

test('no house login and no CLI login reads as logged out', async () => {
  __setCodexCliRefresherForTests(async () => { throw new Error('must not be asked'); });
  assert.equal(isCodexLoggedIn(), false);
  const snap = await getCodexAuthSnapshot();
  assert.equal(snap.loggedIn, false);
  assert.equal(snap.source, null);
  await assert.rejects(getCodexAccessToken(), CodexAuthRequiredError);
});

test('a live CLI token is borrowed as-is, without asking the CLI', async () => {
  const tok = fakeJwt(3600);
  writeCli(tok);
  __setCodexCliRefresherForTests(async () => { throw new Error('must not be asked'); });
  assert.equal(isCodexLoggedIn(), true);
  assert.equal(await getCodexAccessToken(), tok);
  const snap = await getCodexAuthSnapshot();
  assert.equal(snap.source, 'cli');
  assert.equal(snap.refreshable, false);
  assert.ok(!JSON.stringify(snap).includes(tok), 'snapshot never carries the token');
});

test('a stale CLI token is refreshed by the CLI, not by the house', async () => {
  writeCli(fakeJwt(-60, 'old'));
  const fresh = fakeJwt(3600, 'new');
  const asks: boolean[] = [];
  __setCodexCliRefresherForTests(async (refresh) => { asks.push(refresh); return fresh; });
  assert.equal(isCodexLoggedIn(), true, 'a stale CLI login still counts: the CLI can refresh it');
  assert.equal(await getCodexAccessToken(), fresh);
  assert.deepEqual(asks, [true]);
});

test('if the CLI cannot refresh, the caller gets a clear auth error', async () => {
  writeCli(fakeJwt(-60));
  __setCodexCliRefresherForTests(async () => null);
  await assert.rejects(getCodexAccessToken(), (err: unknown) =>
    err instanceof CodexAuthRequiredError && /codex login/.test((err as Error).message));
});

test('the house login wins when both exist', async () => {
  writeCli(fakeJwt(3600, 'cli'));
  writeFileSync(housePath, JSON.stringify({ access: 'house-token', refresh: 'house-refresh', expires: Date.now() + 3_600_000 }));
  __setCodexCliRefresherForTests(async () => { throw new Error('must not be asked'); });
  assert.equal(await getCodexAccessToken(), 'house-token');
  const snap = await getCodexAuthSnapshot();
  assert.equal(snap.source, 'house');
});

test('while borrowing the CLI login, the house can still sign in on its own, and its login wins', async () => {
  writeCli(fakeJwt(3600, 'cli'));
  _resetForTests();
  const houseExpires = Date.now() + 3_600_000;
  let resolveLogin: (c: { access: string; refresh: string; expires: number }) => void = () => {};
  __TEST_PROVIDERS__.loginOpenAICodex = (async (opts: { onAuth: (a: { url: string }) => void }) => {
    opts.onAuth({ url: 'https://auth.example/authorize' });
    return new Promise((r) => { resolveLogin = r; });
  }) as unknown as typeof __TEST_PROVIDERS__.loginOpenAICodex;
  try {
    assert.equal((await getCodexAuthSnapshot()).source, 'cli');
    const started = await startCodexLogin();
    assert.equal(started.status, 'awaiting_browser', 'a borrowed CLI login does not block starting a house login');
    assert.equal(started.url, 'https://auth.example/authorize');
    resolveLogin({ access: 'house-access', refresh: 'house-refresh', expires: houseExpires });
    for (let i = 0; i < 100 && getLoginSession().status === 'awaiting_browser'; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(getLoginSession().status, 'complete');
    const snap = await getCodexAuthSnapshot();
    assert.equal(snap.source, 'house');
    assert.equal(snap.expiresAt, houseExpires);
    assert.equal(snap.refreshable, true);
  } finally {
    _resetForTests();
  }
});
