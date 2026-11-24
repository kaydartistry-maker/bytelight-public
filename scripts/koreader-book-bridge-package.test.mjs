import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const main = new URL('../packages/koreader-book-bridge/bytelight-book-bridge.koplugin/main.lua', import.meta.url);

test('Book Bridge explicitly places its menu in KOReader Tools', async () => {
  const source = await readFile(main, 'utf8');
  assert.match(source, /menu_items\.bytelight_book_bridge\s*=\s*\{[\s\S]*?sorting_hint\s*=\s*["']tools["']/);
});

test('Book Bridge verifies HTTPS with its bundled public CA root', async () => {
  const source = await readFile(main, 'utf8');
  assert.match(source, /cafile\s*=\s*plugin_dir\s*\.\.\s*["']\/isrg-root-x2\.pem["']/);
  assert.doesNotMatch(source, /\/system\/etc\/security\/cacerts/);
  const pem = await readFile(new URL('../packages/koreader-book-bridge/bytelight-book-bridge.koplugin/isrg-root-x2.pem', import.meta.url), 'utf8');
  assert.match(pem, /^-----BEGIN CERTIFICATE-----/);
});
