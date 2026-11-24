import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildAppearanceCss, buildAppearanceFontFaces, themeFontFamily } from './appearance-css';
import { AppearanceRuntime, BubblePaintLayers } from '../components/AppearanceRuntime';
import { AppBackground, safeWallpaperSource } from '../components/ThemedAppBackground';
import type { AppTheme } from '../types';

test('empty appearance generates no CSS, font face or visual reset', () => {
  assert.equal(buildAppearanceCss(undefined), '');
  assert.equal(buildAppearanceCss({ version: 1 }), '');
  assert.equal(buildAppearanceFontFaces({}), '');
  assert.equal(renderToStaticMarkup(React.createElement(AppearanceRuntime, { legacyMotion: 100 })), '');
});

test('solid fill overrides replace skin gradients instead of being hidden underneath them', () => {
  const css = buildAppearanceCss({ chat: { user: { fill: { color: '#264f45' } } } });
  assert.match(css, /background-color:color-mix\(in srgb, #264f45 100%, transparent\)!important;background-image:none!important/);
  assert.doesNotMatch(css, /backdrop-filter/);
});

test('explicit card and button typography reaches fixed-size descendants without resetting unspecified properties', () => {
  const card = buildAppearanceCss({ cards: { text: { color: '#ffffff', size: 20 } } });
  assert.match(card, /:is\(div,span,p,label,small,h1,h2,h3,h4,h5,h6,.prose\)/);
  assert.match(card, /:not\(:where\(button:not\(\[data-appearance-card\]\),button:not\(\[data-appearance-card\]\) \*/);
  assert.match(card, /font-size:inherit!important;color:inherit!important/);
  const buttons = buildAppearanceCss({ controls: { buttons: { text: { size: 22 } } } });
  assert.match(buttons, /font-size:inherit!important/);
  assert.doesNotMatch(buttons, /:not\(:where\(button:not\(\[data-appearance-card\]\)/);
  assert.match(buttons, /button:not\(:where\(\[role="tab"\],\[data-appearance-tab\],\[data-appearance-card\]/);
  const opacity = buildAppearanceCss({ chat: { user: { text: { opacity: 60 } } } });
  assert.match(opacity, /color:inherit!important/);
  assert.doesNotMatch(opacity, /font-size|font-family|line-height|letter-spacing/);
});

test('user timestamp preferences do not change companion split-message footers', () => {
  const user = buildAppearanceCss({ chat: { user: { avatar: { showTimestamp: false } } } });
  assert.doesNotMatch(user, /appearance-shared-time/);
  const companion = buildAppearanceCss({ chat: { companions: { companion-a: { avatar: { showTimestamp: false } } } } });
  assert.match(companion, /appearance-shared-time/);
});

test('scrollbar controls have real paint consumers and unread color preserves readable ink', () => {
  const css = buildAppearanceCss({ details: { scrollbarColor: '#ff00ff', scrollbarWidth: 8, unreadColor: '#ffffff' } });
  assert.match(css, /::-webkit-scrollbar-thumb\{background-color:#ff00ff!important/);
  assert.match(css, /scrollbar-width:thin!important/);
  assert.match(css, /background-color:#ffffff!important;color:#090807!important/);
});

test('card fill and uploaded textures use paint opacity without fading content', () => {
  const css = buildAppearanceCss({ cards: { fill: { color: '#fff', opacity: 30 },
    overlay: { assetId: 'image-1', opacity: 25, scale: 120, repeat: 'repeat', blend: 'multiply' } } });
  const first = css.slice(0, css.indexOf('}') + 1);
  assert.match(first, /background-color:color-mix\(in srgb, #fff 30%, transparent\)/);
  assert.doesNotMatch(first, /[;{]opacity:/);
  assert.match(css, /::after\{[^}]*opacity:0\.25!important/);
  assert.match(css, /background-size:120%/);
  assert.match(css, /mix-blend-mode:multiply/);
  assert.match(css, /pointer-events:none/);
  assert.match(css, /data-appearance-card/);
  assert.match(css, /z-index:0!important/);
  assert.match(css, />:not\(\.appearance-paint,\.appearance-border\)[^}]*z-index:1!important/);
});

test('native border styles are not covered by a continuous border texture', () => {
  for (const style of ['dashed', 'dotted', 'double', 'none'] as const) {
    const css = buildAppearanceCss({ cards: { border: { style, width: 4, overlay: { assetId: 'gold-ring' } } } });
    assert.match(css, new RegExp(`border-style:${style}!important`));
    assert.doesNotMatch(css, /gold-ring/);
  }
  const solid = buildAppearanceCss({ cards: { border: { style: 'solid', width: 4, overlay: { assetId: 'gold-ring' } } } });
  assert.match(solid, /gold-ring/);
  assert.match(solid, /mask-composite:exclude/);
});

test('separate bubble speakers inherit chat only, not panel colors or blur', () => {
  const css = buildAppearanceCss({ cards: { fill: { color: '#fff' }, blur: 20 }, chat: {
    defaults: { border: { width: 1 } }, user: { fill: { color: '#f00' } },
    companions: { companion-a: { fill: { color: '#0f0' } }, companion-b: { fill: { color: '#00f' } } },
  } });
  const blocks = css.split('}');
  const role = (name: string) => blocks.filter(block => block.startsWith(`body [data-appearance-bubble][data-speaker="${name}"]`)).join('}');
  assert.match(role('user'), /#f00/); assert.doesNotMatch(role('user'), /#0f0|#fff|backdrop-filter/);
  assert.match(role('companion-a'), /#0f0/); assert.doesNotMatch(role('companion-a'), /#00f|#fff|backdrop-filter/);
  assert.match(role('companion-b'), /#00f/);
  assert.match(role('companion-a'), /border-width:1px/);
});

test('bubble paint preserves original ::before glass and never uses backdrop blur', () => {
  const css = buildAppearanceCss({ chat: { defaults: { blur: 30, overlay: { assetId: 'paint', opacity: 40 },
    border: { width: 3, opacity: 50, overlay: { assetId: 'ring', opacity: 80 } }, shadow: { blur: 12 } } } });
  assert.doesNotMatch(css, /backdrop-filter/);
  assert.doesNotMatch(css, /::before\{/);
  assert.match(css, />\.appearance-paint[^}]*opacity:0\.4/);
  assert.match(css, />\.appearance-border[^}]*padding:3px/);
  assert.match(css, /mask-composite:exclude/);
  const markup = renderToStaticMarkup(React.createElement(BubblePaintLayers));
  assert.match(markup, /aria-hidden="true" class="appearance-paint"/);
  assert.match(markup, /class="appearance-border"/);
  assert.doesNotMatch(markup, /img|button|tabindex/);
});

test('role layout, tail, text, avatar and metadata controls have real selectors', () => {
  const css = buildAppearanceCss({ chat: { user: {
    text: { size: 21, weight: 600, tracking: 0.03, opacity: 80 },
    border: { radius: 18 }, layout: { padding: 20, gap: 12, maxWidth: 60, alignment: 'center', tail: 'none' },
    avatar: { size: 48, shape: 'square', ringWidth: 4, ringColor: '#abc', showName: true, showTimestamp: false },
  } } });
  for (const expected of ['font-size:21px', 'font-weight:600', 'padding:20px', 'max-width:60%',
    'justify-content:center', 'width:48px', 'border-radius:0', 'border-color:#abc',
    'data-appearance-name', 'data-appearance-timestamp', '--bytelight-user-bubble-text']) {
    assert.ok(css.includes(expected), expected);
  }
  assert.match(css, /border-top-left-radius:18px/);
  assert.match(css, /border-top-right-radius:18px/);
});

test('card section overrides and bubble default roles resolve independently', () => {
  const css = buildAppearanceCss({ cards: { fill: { color: '#fff' }, border: { width: 2 } },
    sectionOverrides: { notes: { fill: { color: '#abc' } } }, chat: { defaults: { fill: { color: '#123' } } } }, { section: 'notes' });
  assert.match(css.split('}')[0], /#abc/);
  assert.match(css.split('}')[0], /border-width:2px/);
  assert.doesNotMatch(css.split('}')[0], /#123/);
});

test('safe selectors, colors and IDs prevent CSS or external URL injection', () => {
  const css = buildAppearanceCss({ cards: { fill: { color: '#fff;display:none' },
    overlay: { assetId: 'https://tracking.invalid/x' }, text: { font: 'x"}body{display:none' } }, apiKey: 'secret' });
  assert.equal(css, '');
  assert.throws(() => buildAppearanceCss({}, { scope: 'body}body{display:none' }), /Unsafe/);
  assert.doesNotThrow(() => buildAppearanceCss({}, { scope: '[data-appearance-preview]' }));
  const scoped = buildAppearanceCss({ cards: { blur: 10 } }, { scope: '[data-appearance-preview]' });
  assert.match(scoped, /^\[data-appearance-preview\]/);
});

test('font faces use only local font slots and exact asset metadata family', () => {
  const css = buildAppearanceCss({ typography: { body: { assetId: 'font-abc-123' } }, cards: { overlay: { assetId: 'image-only' } } });
  assert.equal(themeFontFamily('font-abc-123'), 'ThemeFont_font_abc_123');
  assert.match(css, /@font-face\{font-family:"ThemeFont_font_abc_123";src:url\("\/api\/theme-assets\/font-abc-123\/file"\)/);
  assert.doesNotMatch(buildAppearanceFontFaces({ cards: { overlay: { assetId: 'image-only' } } }), /image-only/);
  assert.match(css, /font-display:swap/);
});

test('editor is excluded from visual rules and has a readable typography boundary', () => {
  const css = buildAppearanceCss({ typography: { body: { font: 'Fraunces', size: 48 } },
    cards: { overlay: { assetId: 'paint' } }, controls: { buttons: { fill: { color: '#000' } } } });
  assert.match(css, /:not\(:where\(\[data-theme-editor\],\[data-theme-editor\] \*\)\)/);
  assert.match(css, /\[data-theme-editor\]\{font-family:system-ui!important;font-size:14px/);
});

test('motion consumes the old slider and respects OS reduced-motion', () => {
  const css = buildAppearanceCss({ motion: { scale: 50, hover: false, press: false } });
  assert.match(css, /transition-duration:calc\(var\(--tw-duration,150ms\) \* 0\.5\)/);
  assert.match(css, /--animate-spin:spin calc\(1s \* 0\.5\)/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /animation-duration:0\.01ms/);
  assert.match(css, /:hover[^}]*transform:none/);
  const markup = renderToStaticMarkup(React.createElement(AppearanceRuntime, { legacyMotion: 50 }));
  assert.match(markup, /var\(--tw-duration,150ms\) \* 0\.5/);
  const off = buildAppearanceCss({ motion: { enabled: false } });
  assert.match(off, /transition-duration:0ms/);
  const hoverOnly = buildAppearanceCss({ motion: { hover: false } });
  assert.doesNotMatch(hoverOnly, /--appearance-motion-duration/);
});

test('legacy wallpaper keeps default cover and opacity while new layers remain independent', () => {
  const theme: AppTheme = { id: 'magenta', mode: 'dark', wallpaper: 'data:image/png;base64,YQ==' };
  const legacy = renderToStaticMarkup(React.createElement(AppBackground, { theme }));
  assert.match(legacy, /data-appearance-wallpaper/);
  assert.match(legacy, /opacity:0\.8/);
  assert.match(legacy, /object-fit:cover/);
  assert.doesNotMatch(legacy, /wallpaper-dim|wallpaper-wash/);
  const custom = renderToStaticMarkup(React.createElement(AppBackground, { theme: { ...theme, appearance: {
    version: 1, wallpaper: { assetId: 'wallpaper-id', opacity: 50, zoom: 120, blur: 4, dim: 20,
      fit: 'contain', positionX: 25, colorWash: { color: '#abc', opacity: 30 } },
  } } }));
  for (const expected of ['/api/theme-assets/wallpaper-id/file', 'opacity:0.5', 'scale(1.2)', 'blur(4px)', 'wallpaper-dim', 'wallpaper-wash', 'object-fit:contain']) {
    assert.ok(custom.includes(expected), expected);
  }
});

test('wallpaper rejects active schemes and supports safe legacy paths', () => {
  assert.equal(safeWallpaperSource('javascript:alert(1)'), undefined);
  assert.equal(safeWallpaperSource('data:text/html,hello'), undefined);
  assert.equal(safeWallpaperSource('//tracking.invalid/image'), undefined);
  assert.equal(safeWallpaperSource('/api/files/image'), '/api/files/image');
  assert.equal(safeWallpaperSource('https://example.invalid/image.png'), 'https://example.invalid/image.png');
});

test('button and tab states inherit base surfaces and use separate selectors', () => {
  const css = buildAppearanceCss({ controls: {
    buttons: { fill: { color: '#111', opacity: 40 }, border: { width: 2 } },
    tabs: { fill: { color: '#222' } }, buttonStates: { hover: { fill: { color: '#abc' } } },
    tabStates: { selected: { fill: { color: '#def' } } },
  } });
  const blocks = css.split('}');
  const hover = blocks.find(block => block.includes('button:not(') && block.includes(':hover'))!;
  assert.match(hover, /#abc 40%/);
  assert.match(hover, /border-width:2px/);
  assert.match(hover, /not\(:where\(\[role="tab"\],\[data-appearance-tab\]/);
  assert.doesNotMatch(hover, /#222|#def/);
  const selected = blocks.find(block => block.includes('body :is([role="tab"],[data-appearance-tab]):is([aria-selected="true"]'))!;
  assert.match(selected, /#def/);
  assert.doesNotMatch(selected, /#111|#abc|border-width:2px/);
});

test('state precedence is hover then selected then pressed then disabled, all editor guarded', () => {
  const css = buildAppearanceCss({ controls: { buttonStates: {
    hover: { fill: { color: '#111' } }, selected: { fill: { color: '#222' } },
    pressed: { fill: { color: '#333' } }, disabled: { fill: { color: '#444' } },
  } } });
  assert.ok(css.indexOf(':hover') < css.indexOf(':is([aria-selected="true"]'));
  assert.ok(css.indexOf(':is([aria-selected="true"]') < css.indexOf(':active'));
  assert.ok(css.indexOf(':active') < css.indexOf(':is(:disabled,[aria-disabled="true"])'));
  for (const block of css.split('}').filter(Boolean)) assert.match(block, /data-theme-editor/);
  assert.equal(buildAppearanceCss({ controls: { buttonStates: {}, tabStates: {} } }), '');
});

test('state-only custom fonts load, images stay image-only, fullscreen backdrops are excluded', () => {
  const input = { cards: { overlay: { assetId: 'card-image' } }, controls: {
    buttonStates: { hover: { text: { assetId: 'hover-font' }, overlay: { assetId: 'hover-image' } } },
    tabStates: { selected: { text: { assetId: 'selected-font' } } },
  } };
  const faces = buildAppearanceFontFaces(input);
  assert.match(faces, /ThemeFont_hover_font/);
  assert.match(faces, /ThemeFont_selected_font/);
  assert.doesNotMatch(faces, /card-image|hover-image/);
  assert.match(buildAppearanceCss(input), /:not\(\.fixed\.inset-0\)/);
});
