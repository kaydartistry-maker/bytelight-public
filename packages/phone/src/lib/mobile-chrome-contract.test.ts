import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const shell = readFileSync(new URL('../components/AppShell.tsx', import.meta.url), 'utf8');
const chat = readFileSync(new URL('../components/ChatInput.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');

test('shared app backs have a labelled 44px touch target', () => {
  assert.match(shell, /aria-label={`Back from \$\{title\}`}/);
  assert.match(shell, /bytelight-back-button/);
  assert.match(css, /\.bytelight-back-button[\s\S]*min-width:\s*44px;[\s\S]*min-height:\s*44px;/);
});

test('chat composer owns one compact bottom safe-area inset', () => {
  assert.match(chat, /paddingBottom:\s*'max\(0\.5rem, min\(var\(--sab, 0px\), 2\.25rem\)\)'/);
  assert.doesNotMatch(chat, /paddingBottom:[^\n]*env\(safe-area-inset-bottom/);
});
