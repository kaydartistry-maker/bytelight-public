// A house with no password has no proxy to trust, so a forwarded host must not
// talk a cross-site request through (third outside audit, Nov 17 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { csrfProtection } from './csrf.js';

const dir = mkdtempSync(join(tmpdir(), 'bl-csrf-'));
const yamlPath = join(dir, 'bytelight.yaml');
writeFileSync(yamlPath, 'auth:\n  password: ""\nserver:\n  port: 3002\n');
loadConfig(yamlPath);

function run(headers: Record<string, string>): number {
  let status = 200;
  let passed = false;
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const req = { method: 'POST', path: '/api/x', headers: lower, get: (h: string) => lower[h.toLowerCase()] } as never;
  const res = {
    status(code: number) { status = code; return this; },
    json() { return this; },
    cookie() { return this; },
    setHeader() { return this; },
  } as never;
  csrfProtection(req, res, () => { passed = true; });
  return passed ? 200 : status;
}

test('with no password, a forwarded host does not make another site this house', () => {
  const warn = console.warn; console.warn = () => {};
  try {
    assert.equal(run({ host: 'localhost:3002', origin: 'https://evil.test' }), 403, 'plain cross-site post');
    assert.equal(run({ host: 'localhost:3002', origin: 'https://evil.test', 'x-forwarded-host': 'evil.test' }), 403, 'the same post with the header added');
  } finally { console.warn = warn; }
});
