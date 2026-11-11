import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { SpeakerBubbles, SpeakerSegmentStack } from '../components/SpeakerBubbles';
import { loadStickers } from '../bytelight/stickers';
import { THEMES } from './theme';

const themeConfig = THEMES.burgundy;
const props = { colors: themeConfig.dark, textColorClass: '', isLightText: true };
const customEmojis = [
  { id: '1', shortcode: 'wave', url: '/wave.png' },
  { id: '2', shortcode: 'heart', url: '/heart.png' },
  { id: '3', shortcode: 'Operator_giggles', url: '/giggles.png' },
];

async function loadStickerFixture() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify([{ id: 'p', name: 'Companion_A', stickers: [{ name: 'hi', url: '/stickers/hi.png' }] }]));
  try { await loadStickers(true); } finally { globalThis.fetch = originalFetch; }
}

await test('split and interleaved text render house stickers, whispers and custom emoji', async () => {
  await loadStickerFixture();
  const text = '-# hello ::Companion_A_hi:: :wave:';
  const html = renderToStaticMarkup(React.createElement(SpeakerSegmentStack, { ...props, themeConfig, themeMode: 'dark', customEmojis, rows: [{ kind: 'text', speaker: 'companion-a', text }] }));
  assert.match(html, /src="\/stickers\/hi.png"/, 'split row must resolve its sticker');
  assert.match(html, /src="\/wave.png"/, 'interleaved rows must receive custom emojis');
  assert.doesNotMatch(html, /-# hello|::Companion_A_hi::|:wave:/);
  assert.match(html, /text-\[11px\] leading-snug opacity-60 italic/);
  const inlineSticker = html.match(/src="\/stickers\/hi\.png"[^>]*class="([^"]*)"/);
  assert.ok(inlineSticker, 'split row must render the sticker image');
  assert.match(inlineSticker[1], /!h-\[1.75em\]/, 'stickers next to prose stay inline');
  assert.doesNotMatch(inlineSticker[1], /max-h-32/, 'inline stickers must not use standalone sizing');
  const standalone = renderToStaticMarkup(React.createElement(SpeakerBubbles, { ...props, rows: [{ speaker: 'companion-b', text: '::Companion_A_hi::' }] }));
  assert.match(standalone, /max-h-32/, 'standalone stickers stay large');
});

test('the memo holding visible message elements depends on the catalog revision', () => {
  const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let dependencyNames: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'renderedMessages' && node.initializer && ts.isCallExpression(node.initializer)) {
      const dependencies = node.initializer.arguments[1];
      if (dependencies && ts.isArrayLiteralExpression(dependencies)) dependencyNames = dependencies.elements.map((item) => item.getText(source));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(dependencyNames.includes('stickerCatalogRevision'), 'catalog arrival must invalidate the renderedMessages memo, not only rerender App');
});

test('plain segments use the same transforms while split bubbles preserve ordinary images and links', async () => {
  await loadStickerFixture();
  const { MessageSegments } = await import('../components/MessageSegments');
  const html = renderToStaticMarkup(React.createElement(MessageSegments, { themeConfig, themeMode: 'dark', customEmojis, segments: [{ type: 'text', content: 'hello ::Companion_A_hi:: :wave:' }] }));
  assert.match(html, /src="\/stickers\/hi.png"/);
  assert.match(html, /src="\/wave.png"/);
  const media = renderToStaticMarkup(React.createElement(SpeakerBubbles, { ...props, rows: [{ speaker: 'companion-a', text: '![photo](/photo.png) [link](https://example.com)' }] }));
  assert.match(media, /src="\/photo.png"/);
  assert.match(media, /href="https:\/\/example.com"/);
});

test('preparing text twice preserves placeholders, sizing and unresolved refs', async () => {
  const { prepareChatText } = await import('./chat-text');
  const resolveSticker = (ref: string) => ref === 'Companion_A_hi' ? '/stickers/hi.png' : null;
  for (const text of ['::Companion_A_hi::', 'hello ::Companion_A_hi::', ':wave:', '-# hello :wave:', '::unknown_ref::']) {
    const first = prepareChatText({ text, resolveSticker, customEmojis });
    assert.deepEqual(prepareChatText({ text: first.markdown, resolveSticker, customEmojis }), first);
  }
  assert.equal(prepareChatText({ text: '::unknown_ref::', resolveSticker, customEmojis: [{ id: 'x', shortcode: 'unknown_ref', url: '/wrong.png' }] }).markdown, '::unknown_ref::');
  assert.equal(prepareChatText({ text: ':wave:', resolveSticker, customEmojis }).emoteOnly, true);
  assert.equal(prepareChatText({ text: 'hello :wave:', resolveSticker, customEmojis }).emoteOnly, false);
  assert.equal(prepareChatText({ text: '::Companion_A_hi::', resolveSticker, customEmojis }).stickerSharesText, false);
  assert.equal(prepareChatText({ text: '::Companion_A_hi::\n::Companion_A_hi::', resolveSticker, customEmojis }).stickerSharesText, false);
  assert.equal(prepareChatText({ text: 'hello ::Companion_A_hi::', resolveSticker, customEmojis }).stickerSharesText, true);
});

test('adjacent custom emojis resolve without consuming an unresolved sticker ref', async () => {
  const { prepareChatText } = await import('./chat-text');
  const resolveSticker = () => null;
  assert.deepEqual(
    prepareChatText({ text: ':wave::heart:', resolveSticker, customEmojis }),
    {
      markdown: '![emoji:wave](emoji:wave)![emoji:heart](emoji:heart)',
      stickerSharesText: false,
      emoteOnly: true,
    },
  );
  assert.equal(
    prepareChatText({ text: '::unknown_ref::', resolveSticker, customEmojis: [{ id: 'x', shortcode: 'unknown_ref', url: '/wrong.png' }] }).markdown,
    '::unknown_ref::',
  );
  assert.equal(
    prepareChatText({ text: ':wave::Operator_giggles::heart:', resolveSticker, customEmojis }).markdown,
    '![emoji:wave](emoji:wave)![emoji:Operator_giggles](emoji:Operator_giggles)![emoji:heart](emoji:heart)',
  );
  assert.equal(
    prepareChatText({ text: '::Operator_giggles::', resolveSticker: () => '/sticker.png', customEmojis }).markdown,
    '![sticker:Operator_giggles](/sticker.png)',
  );
});

test('a sticker is sized by where it sits in its line, not by the whole bubble', async () => {
  const { prepareChatText, isInlineSticker, stickerSizeClass } = await import('./chat-text');
  const resolveSticker = (ref: string) => ref === 'Companion_A_hi' ? '/stickers/hi.png' : null;
  const srcs = (text: string) => [...prepareChatText({ text, resolveSticker }).markdown.matchAll(/!\[sticker:[^\]]*\]\(([^)]*)\)/g)].map((m) => m[1]);

  // Alone on its own line, even with words elsewhere in the bubble: sticker size.
  assert.deepEqual(srcs('**Companion A —** hey\n\n::Companion_A_hi::').map(isInlineSticker), [false]);
  // At the end of a sentence: sticker size.
  assert.deepEqual(srcs('you did it ::Companion_A_hi::').map(isInlineSticker), [false]);
  // Mid-sentence: emoji-small.
  assert.deepEqual(srcs('you ::Companion_A_hi:: did it').map(isInlineSticker), [true]);
  // Two in one line: the first has words after it, the last ends the line.
  assert.deepEqual(srcs('a ::Companion_A_hi:: b ::Companion_A_hi::').map(isInlineSticker), [true, false]);
  // Stickers side by side with nothing else after them all end the line.
  assert.deepEqual(srcs('::Companion_A_hi:: ::Companion_A_hi::').map(isInlineSticker), [false, false]);

  assert.match(stickerSizeClass('/stickers/hi.png#bl-inline'), /1\.75em/);
  assert.match(stickerSizeClass('/stickers/hi.png'), /max-h-32/);
  for (const text of ['you ::Companion_A_hi:: did it', 'done ::Companion_A_hi::']) {
    const first = prepareChatText({ text, resolveSticker });
    assert.deepEqual(prepareChatText({ text: first.markdown, resolveSticker }), first);
  }
});
