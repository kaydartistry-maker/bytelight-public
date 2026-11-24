import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (name: string) => readFileSync(new URL(`./${name}.tsx`, import.meta.url), 'utf8');
const openingButtons = (name: string): string[] => Array.from(source(name).match(/<button\b[\s\S]*?(?=className=)/g) ?? []);

test('real view selectors expose appearance markers and pressed state without introducing incomplete ARIA tabs', () => {
  for (const name of ['AgentApp', 'CommandCenterApp', 'StatusApp', 'UsageApp', 'LibraryApp', 'DiscordRules', 'EmojiPicker']) {
    const buttons = openingButtons(name).filter(tag => tag.includes('data-appearance-tab'));
    assert.ok(buttons.length, `${name} must expose real tab-like view buttons`);
    for (const button of buttons) {
      assert.match(button, /aria-pressed=\{[^}]+\}/, `${name} selected styling must follow real pressed state`);
      assert.doesNotMatch(button, /aria-selected|role="tab"/, 'ordinary toggle buttons retain their existing keyboard behavior');
    }
  }
});

test('Reading Nook marks view selectors, not its upload action', () => {
  const text = source('LibraryApp');
  assert.match(text, /data-appearance-tab=""\s+aria-pressed=\{!club && tab === t\}/);
  assert.match(text, /data-appearance-tab=""\s+aria-pressed=\{club\}/);
  assert.doesNotMatch(openingButtons('LibraryApp').find(tag => tag.includes('uploadRef.current?.click()')) ?? '', /data-appearance-tab|aria-pressed/);
});

test('the actual thread unread count, not the whole thread row, receives unread styling', () => {
  const text = source('ThreadSwitcher');
  assert.match(text, /thread\.unread_count > 0 && \(\s*<span\s+data-unread="true"/);
  assert.doesNotMatch(text, /<button\b[^>]*data-unread/);
});

test('native model selection remains available without a Cloud-only picker', () => {
  const text = source('ModelPill');
  assert.match(text, /companion-settings-routes/);
  assert.match(text, /providerEnabled/);
  assert.doesNotMatch(text, /letta-control|ConversationModelPicker/);
});
