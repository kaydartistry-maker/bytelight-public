import test from 'node:test';
import assert from 'node:assert/strict';
import { collectThemeAssetIds, normalizeThemeAppearance, resolveBubbleAppearance, resolveCardAppearance, resolveControlAppearance } from './theme-appearance.js';

test('empty, malformed and unsupported-version appearance preserve the old look', () => {
  for (const value of [undefined, null, '', [], 42, true, {}, { version: 2, cards: { blur: 10 } },
    { version: '1' }, { cards: { fill: {} }, chat: { companions: {} }, typography: {} }]) {
    assert.deepEqual(normalizeThemeAppearance(value), { version: 1 });
    assert.deepEqual(resolveCardAppearance(value), {});
    assert.deepEqual(resolveBubbleAppearance(value, 'user'), {});
  }
});

test('card section overrides merge nested properties, preserving explicit zero and false', () => {
  const settings = normalizeThemeAppearance({ cards: {
    fill: { color: '#abc', opacity: 50 }, border: { color: '#123456', width: 2, overlay: { assetId: 'base', scale: 100 } },
    shadow: { inset: true, blur: 12 },
  }, sectionOverrides: { studio: {
    fill: { opacity: 0 }, border: { width: 0, overlay: { opacity: 0 } }, shadow: { inset: false },
  } } });
  assert.deepEqual(resolveCardAppearance(settings, 'studio'), {
    fill: { color: '#abc', opacity: 0 },
    border: { color: '#123456', width: 0, overlay: { assetId: 'base', scale: 100, opacity: 0 } },
    shadow: { inset: false, blur: 12 },
  });
  assert.deepEqual(resolveCardAppearance(settings, 'unknown'), settings.cards);
});

test('per-companion and user appearance inherit only chat defaults, never cards', () => {
  const settings = normalizeThemeAppearance({ cards: { blur: 40, fill: { color: '#fff' }, border: { width: 14 } },
    chat: { defaults: { fill: { color: '#456', opacity: 75 }, border: { width: 1 } },
      user: { fill: { color: '#f00' } }, companions: { companion-a: { border: { width: 3 } }, companion-b: { text: { weight: 800 } } } } });
  assert.deepEqual(resolveBubbleAppearance(settings, 'user'), { fill: { color: '#f00', opacity: 75 }, border: { width: 1 } });
  assert.deepEqual(resolveBubbleAppearance(settings, 'companion-a'), { fill: { color: '#456', opacity: 75 }, border: { width: 3 } });
  assert.deepEqual(resolveBubbleAppearance(settings, 'companion-b'), {
    fill: { color: '#456', opacity: 75 }, border: { width: 1 }, text: { weight: 800 },
  });
  assert.deepEqual(resolveBubbleAppearance(settings, 'unlisted'), settings.chat?.defaults);
  assert.deepEqual(resolveBubbleAppearance({ cards: { fill: { color: '#fff' } } }, 'user'), {});
});

test('backdrop blur cannot enter bubbles through imports or speaker overrides', () => {
  const settings = normalizeThemeAppearance({ cards: { blur: 12 }, chat: {
    defaults: { blur: 20 }, user: { blur: 30 }, companions: { companion-a: { blur: 40, shadow: { blur: 15 } } },
  } });
  assert.equal(settings.cards?.blur, 12);
  assert.equal(settings.chat?.defaults, undefined);
  assert.equal(settings.chat?.user, undefined);
  assert.deepEqual(resolveBubbleAppearance(settings, 'companion-a'), { shadow: { blur: 15 } });
});

test('numbers clamp to documented bounds; non-finite values and numeric strings are dropped', () => {
  const value = normalizeThemeAppearance({ cards: {
    fill: { opacity: -10 }, overlay: { scale: 999, opacity: 150 },
    border: { width: -1, radius: 999 }, shadow: { x: -999, y: 999, blur: Infinity },
    text: { size: 1, weight: 1200, tracking: -3, lineHeight: '2', opacity: NaN },
    layout: { padding: 500, gap: -5, maxWidth: 5 }, avatar: { size: 999, ringWidth: -4 }, blur: 999,
  }, motion: { scale: 999, duration: -1 }, wallpaper: { slideshowInterval: 0, transitionDuration: 999 } });
  assert.deepEqual(value.cards, {
    fill: { opacity: 0 }, overlay: { scale: 400, opacity: 100 }, border: { width: 0, radius: 80 },
    shadow: { x: -100, y: 100 }, text: { size: 8, weight: 900, tracking: -0.1 },
    layout: { padding: 64, gap: 0, maxWidth: 20 }, avatar: { size: 96, ringWidth: 0 }, blur: 40,
  });
  assert.deepEqual(value.motion, { scale: 200, duration: 0 });
  assert.deepEqual(value.wallpaper, { slideshowInterval: 1, transitionDuration: 10 });
});

test('allowlist strips unknown secrets, paths, external URLs, unsupported enums and CSS injection', () => {
  const value = normalizeThemeAppearance({ apiKey: 'private', contacts: { user: 'private' }, cards: {
    fill: { color: 'url(https://tracker.invalid)', opacity: 50, secret: 'private' },
    overlay: { assetId: '../private.png', repeat: 'round', blend: 'evil', url: 'https://tracker.invalid' },
    border: { color: '#123456; background:red', style: 'hidden' },
    text: { font: 'Inter;display:none', assetId: '/root/private.woff2', color: 'red' },
  }, typography: { body: { font: 'Space Grotesk', assetId: 'font-123_abc' } },
    wallpaper: { assetId: 'https://tracker.invalid', fit: 'evil' } });
  assert.deepEqual(value, { version: 1, cards: { fill: { opacity: 50 } },
    typography: { body: { font: 'Space Grotesk', assetId: 'font-123_abc' } } });
});

test('safe hex colors and explicitly supported enums survive normalization', () => {
  const value = normalizeThemeAppearance({ cards: { fill: { color: '#aBcD' }, border: { color: 'transparent', style: 'dotted' },
    overlay: { assetId: 'A_123-uuid', repeat: 'repeat-x', blend: 'soft-light' },
    text: { color: 'currentColor', font: 'JetBrains Mono' } }, wallpaper: { colorWash: { color: '#12345678' } } });
  assert.equal(value.cards?.fill?.color, '#aBcD');
  assert.equal(value.cards?.overlay?.blend, 'soft-light');
  assert.equal(value.wallpaper?.colorWash?.color, '#12345678');
});

test('prototype and accessor imports cannot pollute output or invoke getters', () => {
  const input = JSON.parse('{"sectionOverrides":{"__proto__":{"blur":30},"constructor":{"blur":20},"safe":{"blur":4}},"chat":{"companions":{"prototype":{"text":{"size":90}}}}}');
  assert.deepEqual(normalizeThemeAppearance(input), { version: 1, sectionOverrides: { safe: { blur: 4 } } });
  assert.deepEqual(resolveCardAppearance(input, '__proto__'), {});
  const source = {};
  Object.defineProperty(source, 'cards', { enumerable: true, get() { throw new Error('must not execute'); } });
  assert.deepEqual(normalizeThemeAppearance(source), { version: 1 });
  assert.deepEqual(normalizeThemeAppearance(Object.create({ cards: { blur: 40 } })), { version: 1 });
  assert.equal(({} as Record<string, unknown>).blur, undefined);
});

test('normalization and resolved nested objects are detached from saved input', () => {
  const input = { cards: { border: { overlay: { assetId: 'paint', scale: 100 } } },
    chat: { defaults: { fill: { color: '#abc' } } } };
  const settings = normalizeThemeAppearance(input);
  const card = resolveCardAppearance(settings);
  const bubble = resolveBubbleAppearance(settings, 'user');
  card.border!.overlay!.scale = 300;
  bubble.fill!.color = '#fff';
  assert.equal(settings.cards!.border!.overlay!.scale, 100);
  assert.equal(settings.chat!.defaults!.fill!.color, '#abc');
  settings.cards!.border!.overlay!.scale = 200;
  assert.equal(input.cards.border.overlay.scale, 100);
});

test('asset collection covers fonts, wallpaper, controls, card and speaker overrides, sorted and unique', () => {
  const input = { cards: { overlay: { assetId: 'image' }, border: { overlay: { assetId: 'border' } } },
    sectionOverrides: { notes: { text: { assetId: 'font' } } },
    chat: { defaults: { text: { assetId: 'font' } }, companions: { companion-a: { overlay: { assetId: 'image' } } } },
    typography: { mono: { assetId: 'mono' } }, wallpaper: { assetId: 'wallpaper' },
    controls: { buttons: { overlay: { assetId: 'button' } }, tabs: { border: { overlay: { assetId: 'tab' } } } },
    apiKey: { assetId: 'secret' },
  };
  assert.deepEqual(collectThemeAssetIds(input), ['border', 'button', 'font', 'image', 'mono', 'tab', 'wallpaper']);
});

test('independent groups retain valid controls without inventing defaults', () => {
  const input = { version: 1, typography: { heading: { font: 'Fraunces', size: 30 } },
    wallpaper: { fit: 'contain', zoom: 120, dim: 0, positionX: 25, positionY: 75 },
    controls: { icons: { size: 20, strokeWidth: 2, opacity: 90 } },
    motion: { enabled: false, reduceMotion: true, entrance: false, duration: 150 },
    details: { dividerColor: '#123', scrollbarWidth: 6, focusWidth: 0 } };
  assert.deepEqual(normalizeThemeAppearance(input), input);
  assert.deepEqual(normalizeThemeAppearance(normalizeThemeAppearance(input)), input);
});

test('override dictionaries are bounded', () => {
  const input = { sectionOverrides: Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`section-${i}`, { blur: 2 }])) };
  assert.equal(Object.keys(normalizeThemeAppearance(input).sectionOverrides!).length, 100);
});

test('control states are a shallow allowlist of normal validated surfaces', () => {
  assert.deepEqual(normalizeThemeAppearance({ controls: {
    buttonStates: { hover: { fill: { color: '#abc', opacity: 120 }, states: { hover: { blur: 20 } } },
      pressed: { border: { width: -5 } }, focus: { fill: { color: '#fff' } } },
    tabStates: { disabled: { overlay: { assetId: '../private' }, text: { weight: 700 } } },
  } }), { version: 1, controls: { buttonStates: { hover: { fill: { color: '#abc', opacity: 100 } },
    pressed: { border: { width: 0 } } }, tabStates: { disabled: { text: { weight: 700 } } } } });
  assert.deepEqual(normalizeThemeAppearance({ controls: { buttonStates: {}, tabStates: {} } }), { version: 1 });
});

test('control states deep inherit only their own button or tab base', () => {
  const settings = { cards: { fill: { color: '#fff' } }, chat: { defaults: { blur: 20 } }, controls: {
    buttons: { fill: { color: '#111', opacity: 40 }, border: { width: 2, overlay: { assetId: 'base-image', scale: 100 } } },
    tabs: { fill: { color: '#222' } },
    buttonStates: { hover: { fill: { color: '#abc' }, border: { overlay: { opacity: 25 } } } },
    tabStates: { selected: { text: { weight: 800 } } },
  } };
  assert.deepEqual(resolveControlAppearance(settings, 'buttons', 'hover'), {
    fill: { color: '#abc', opacity: 40 }, border: { width: 2, overlay: { assetId: 'base-image', scale: 100, opacity: 25 } },
  });
  assert.deepEqual(resolveControlAppearance(settings, 'tabs', 'selected'), { fill: { color: '#222' }, text: { weight: 800 } });
  assert.deepEqual(resolveControlAppearance(settings, 'tabs', 'hover'), { fill: { color: '#222' } });
  assert.deepEqual(resolveCardAppearance(settings), { fill: { color: '#fff' } });
  assert.deepEqual(resolveBubbleAppearance(settings, 'user'), {});
});

test('control state-only image, border and font asset references are retained', () => {
  assert.deepEqual(collectThemeAssetIds({ controls: {
    buttonStates: { hover: { overlay: { assetId: 'hover-image' } }, pressed: { border: { overlay: { assetId: 'pressed-ring' } } } },
    tabStates: { selected: { text: { assetId: 'selected-font' } }, disabled: { overlay: { assetId: 'hover-image' } } },
  } }), ['hover-image', 'pressed-ring', 'selected-font']);
});
