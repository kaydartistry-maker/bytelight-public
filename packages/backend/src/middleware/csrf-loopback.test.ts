// With a password set, a request on a loopback Host still meets the
// cross-site check: a page in a browser on this machine can post to
// localhost with the login cookie attached (outside re-check, Nov 24 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { csrfProtection } from './csrf.js';

const dir = mkdtempSync(join(tmpdir(), 'bl-csrf-lo-'));
const yamlPath = join(dir, 'bytelight.yaml');
writeFileSync(yamlPath, 'auth:\n  password: "a test password"\nserver:\n  port: 3002\n');
loadConfig(yamlPath);

function run(headers: Record<string, string>): number {
  let status = 200;
  let passed = false;
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const req = { method: 'POST', path: '/api/x', headers: lower, get: (h: string) => lower[h.toLowerCase()], secure: false } as never;
  const res = {
    status(code: number) { status = code; return this; },
    json() { return this; },
    cookie() { return this; },
    setHeader() { return this; },
  } as never;
  csrfProtection(req, res, () => { passed = true; });
  return passed ? 200 : status;
}

test('a cross-site post to localhost with the login cookie is refused', () => {
  const warn = console.warn; console.warn = () => {};
  try {
    assert.equal(run({ host: 'localhost:3003', cookie: 'bytelight_session=abc', origin: 'https://evil.test' }), 403);
    assert.equal(run({ host: '127.0.0.1:3003', cookie: 'bytelight_session=abc', 'sec-fetch-site': 'cross-site' }), 403);
  } finally { console.warn = warn; }
});

test("the box's own tools on loopback still pass with a cookie and no token", () => {
  assert.equal(run({ host: 'localhost:3003', cookie: 'bytelight_session=abc; bytelight_csrf=stale' }), 200, 'curl with the jar, no Origin, no token');
  assert.equal(run({ host: 'localhost:3003', cookie: 'bytelight_session=abc', 'sec-fetch-site': 'same-origin' }), 200, 'the page itself');
});
