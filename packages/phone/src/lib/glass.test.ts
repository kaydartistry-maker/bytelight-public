import test from 'node:test';
import assert from 'node:assert/strict';
import { glassVars, textureAlpha, textureFitVars, textureOn } from './glass.js';

const theme = {
  panel: 'rgba(24, 24, 27, 0.95)',
  page: '#09090b',
  hairline: 'rgba(255, 255, 255, 0.16)',
  text: '#fafafa',
  accent: '#44b8a0',
};

test('untouched glass is exactly what Slice 1 shipped: 72%, the dock frost, no glow', () => {
  const v = glassVars(undefined, theme);
  assert.match(v['--bl-glass'], / 72%, transparent\)$/);
  assert.equal(v['--bl-glass-blur'], 'blur(14px) saturate(1.18)');
  assert.equal(v['--bl-glass-border'], theme.hairline);
  assert.equal(v['--bl-glass-border-width'], '1px');
  assert.equal(v['--bl-glass-ink'], theme.text);
  assert.equal(v['--bl-glass-glow'], '0 0 0 0 transparent');
  // Tint is the theme panel made solid over the page.
  assert.match(v['--bl-glass-tint'], /^rgb\(/);
});

test('her picks drive every variable', () => {
  const v = glassVars({ tint: '#3a2550', opacity: 40, blur: 6, borderColor: '#e8c07a', borderWidth: 2, glow: 50 }, theme);
  assert.equal(v['--bl-glass'], 'color-mix(in srgb, #3a2550 40%, transparent)');
  assert.equal(v['--bl-glass-blur'], 'blur(6px) saturate(1.18)');
  assert.equal(v['--bl-glass-border'], '#e8c07a');
  assert.equal(v['--bl-glass-border-width'], '2px');
  assert.match(v['--bl-glass-glow'], /#e8c07a 35%/); // glow wears her border colour
});

test('blur 0 means no frost (a zero blur, never none); glow falls back to the accent without a border colour', () => {
  const v = glassVars({ blur: 0, glow: 100 }, theme);
  assert.equal(v['--bl-glass-blur'], 'blur(0px) saturate(1)');
  assert.match(v['--bl-glass-glow'], /#44b8a0 70%/);
});

test('out-of-range and junk values are clamped, not trusted', () => {
  const v = glassVars({ opacity: 250, blur: -4, borderWidth: 9, tint: 'not-a-colour', borderColor: 'red' }, theme);
  assert.match(v['--bl-glass'], / 100%, transparent\)$/);
  assert.equal(v['--bl-glass-blur'], 'blur(0px) saturate(1)');
  assert.equal(v['--bl-glass-border-width'], '3px');
  assert.equal(v['--bl-glass-border'], theme.hairline);
});

test('auto ink flips dark on a pale tint and stays light on a dark one', () => {
  assert.equal(glassVars({ tint: '#f3ecff', opacity: 90 }, theme)['--bl-glass-ink'], '#090807');
  assert.equal(glassVars({ tint: '#1b1426', opacity: 90 }, theme)['--bl-glass-ink'], '#ffffff');
});

test('theme ink ignores the tint; her own ink wins over everything', () => {
  assert.equal(glassVars({ tint: '#f3ecff', ink: 'theme' }, theme)['--bl-glass-ink'], theme.text);
  assert.equal(glassVars({ tint: '#f3ecff', ink: '#ff00aa' }, theme)['--bl-glass-ink'], '#ff00aa');
});

test('texture shows only in Texture mode with a real image', () => {
  assert.equal(textureOn(undefined), false);
  assert.equal(textureOn({ mode: 'texture' }), false);
  assert.equal(textureOn({ mode: 'colour', texture: 'data:image/png;base64,AA' }), false); // kept, not shown
  assert.equal(textureOn({ mode: 'texture', texture: 'https://example.com/x.png' }), false);
  assert.equal(textureOn({ mode: 'texture', texture: 'data:image/png;base64,AA' }), true);
});

test('fit: One sheet is the default and pins to the screen; tile repeats; fill covers each surface', () => {
  assert.deepEqual(textureFitVars(undefined), { '--bl-tex-size': 'cover', '--bl-tex-repeat': 'no-repeat', '--bl-tex-attach': 'fixed' });
  assert.equal(textureFitVars({ textureFit: 'tile' })['--bl-tex-repeat'], 'repeat');
  assert.equal(textureFitVars({ textureFit: 'fill' })['--bl-tex-attach'], 'scroll');
  assert.equal(textureFitVars({ textureFit: 'nonsense' as never })['--bl-tex-attach'], 'fixed');
});

test('texture strength becomes a clamped alpha, full strength by default', () => {
  assert.equal(textureAlpha(undefined), 1);
  assert.equal(textureAlpha({ textureStrength: 40 }), 0.4);
  assert.equal(textureAlpha({ textureStrength: 400 }), 1);
  assert.equal(textureAlpha({ textureStrength: -5 }), 0);
});
