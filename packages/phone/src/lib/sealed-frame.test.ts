// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The sealed frame, shared by Artifacts and the Story Shelf's scene widgets.
// What is checked here: the Artifacts document did not change when the
// runtime moved, a widget's own policy refuses the network before anything
// loads, and a widget's bridge hands it its scene and lets it say one thing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  STORY_MOVE_MESSAGE,
  STORY_WIDGET_CSP,
  fillSealedPage,
  sealedPageTemplate,
  storyWidgetColorStyle,
  storyWidgetPrelude,
} from './sealed-frame';

const base = { themeMode: 'dark' as const, accent: 'oklch(0.7 0.15 50)', houseFont: '"Geist", sans-serif' };

test('the Artifacts app builds its document from the shared template, with nothing of the widget in it', () => {
  // byte-light adaptation: byte-light's ArtifactsApp still keeps its own copy
  // of this document and was not rewired onto the shared template with the
  // Story Shelf port, so only the artifact's sandbox is checked there.
  const artifacts = readFileSync(new URL('../components/ArtifactsApp.tsx', import.meta.url), 'utf8');
  assert.match(artifacts, /sandbox="allow-scripts"/);

  const page = sealedPageTemplate(base);
  assert.doesNotMatch(page, /Content-Security-Policy/);
  assert.match(page, /root\.render\(React\.createElement\(Component\)\);/);
  assert.match(page, /__VENDOR_SCRIPTS__\n  <script>\n    \(function\(\) \{/, 'no bridge between the runtime and the code');
});

test('a widget’s own policy arrives before anything can load, and refuses every connection', () => {
  const page = sealedPageTemplate({
    ...base,
    headStart: `<meta http-equiv="Content-Security-Policy" content="${STORY_WIDGET_CSP}">`,
    prelude: 'window.x = 1;',
    propsExpression: 'window.story',
  });
  const policyAt = page.indexOf('http-equiv="Content-Security-Policy"');
  assert.ok(policyAt > 0 && policyAt < page.indexOf('<style>') && policyAt < page.indexOf('<script>'));
  for (const rule of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", 'img-src data: blob:', 'media-src data: blob:']) {
    assert.ok(STORY_WIDGET_CSP.includes(rule), rule);
  }
  assert.doesNotMatch(STORY_WIDGET_CSP, /https?:|'self'|\*/, 'nothing the widget can reach on the network is named');
  assert.ok(page.indexOf('<script>window.x = 1;</script>') > page.indexOf('__VENDOR_SCRIPTS__'), 'the bridge runs after the runtime arrives');
  assert.ok(page.indexOf('<script>window.x = 1;</script>') < page.indexOf("atob('__ARTIFACT_CODE__')"), 'and before the widget');
  assert.match(page, /root\.render\(React\.createElement\(Component, window\.story\)\);/);
});

test('a widget page asks the house for no font files, which its policy would refuse, and an artifact still gets them', () => {
  assert.match(sealedPageTemplate(base), /url\('\/fonts\/Geist-Regular\.woff2'\)/);
  const widget = sealedPageTemplate({ ...base, houseFonts: false });
  assert.doesNotMatch(widget, /@font-face|\/fonts\//);
  assert.match(widget, /<style>\n {4}\* \{ box-sizing: border-box;/, 'the rest of the style block is untouched');
  const frame = readFileSync(new URL('../components/StoryWidgetFrame.tsx', import.meta.url), 'utf8');
  assert.match(frame, /houseFonts: false/, 'the widget frame leaves them out');
});

test('the bridge hands the widget its scene, and its one message is a move', () => {
  const prelude = storyWidgetPrelude({
    book: { id: 'b1', title: 'The </script> Night Market', genre: 'gothic' },
    page: { id: 'p1' },
    state: { badge: 'Night 1' },
    choices: [{ id: 'c1', label: 'Go left' }],
  });
  assert.doesNotMatch(prelude, /<\/script/i, 'nothing in the data can close the bridge’s own tag');
  const posted: Array<[unknown, string]> = [];
  const frameWindow: Record<string, any> = { parent: { postMessage: (message: unknown, origin: string) => posted.push([message, origin]) } };
  new Function('window', prelude)(frameWindow);
  assert.equal(frameWindow.story.book.title, 'The </script> Night Market');
  assert.deepEqual(frameWindow.story.state, { badge: 'Night 1' });
  assert.deepEqual(frameWindow.story.choices, [{ id: 'c1', label: 'Go left' }]);
  frameWindow.story.move('c1');
  frameWindow.storyMove(7);
  assert.deepEqual(posted, [
    [{ type: STORY_MOVE_MESSAGE, value: 'c1' }, '*'],
    [{ type: STORY_MOVE_MESSAGE, value: '7' }, '*'],
  ]);
});

test('filling the template leaves a $ in the code or the runtime as itself', () => {
  const filled = fillSealedPage(sealedPageTemplate(base), '<script>var $& = 1;</script>', 'const x = "$1";');
  assert.ok(filled.includes('<script>var $& = 1;</script>'));
  const packed = /atob\('([^']+)'\)/.exec(filled)![1];
  assert.equal(decodeURIComponent(atob(packed)), 'const x = "$1";');
});

test('the house colors handed to a widget cannot break out of their style block', () => {
  const style = storyWidgetColorStyle({
    accent: 'oklch(0.7 0.15 50)', onAccent: '#090807', text: 'red;}</style><script>', muted: 'gray', panel: 'black', border: 'white',
  });
  assert.match(style, /^<style>:root \{ --story-accent: oklch\(0\.7 0\.15 50\); /);
  assert.doesNotMatch(style.slice('<style>'.length, -'</style>'.length), /<|>|\}.*\{/);
});
