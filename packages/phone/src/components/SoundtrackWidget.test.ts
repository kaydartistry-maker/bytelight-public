import test from 'node:test';
import assert from 'node:assert/strict';
import { homeSpotsOf, homeWidgetsOf, layoutWidgets, toggleWidget, HOME_WIDGETS } from '../lib/home-widgets.js';

test('the Soundtrack bar is a home widget: one row, full width, switched on like the rest', () => {
  const size = HOME_WIDGETS.find((w) => w.id === 'soundtrack');
  assert.ok(size, 'Soundtrack is in the widget list');
  assert.equal(size.cols, 4);
  assert.equal(size.rows, 1);
  assert.deepEqual(homeWidgetsOf(['soundtrack', 'day']), ['soundtrack', 'day']);
  assert.deepEqual(toggleWidget(['day'], 'soundtrack'), ['day', 'soundtrack']);
});

test('the Soundtrack bar keeps its own saved spot, so it never pushes the others around', () => {
  const spots = homeSpotsOf({ soundtrack: { col: 0, row: 2 }, day: { col: 0, row: 0 } });
  const layout = layoutWidgets(['day', 'soundtrack'], spots);
  assert.deepEqual(layout.soundtrack, { col: 0, row: 2 });
  assert.deepEqual(layout.day, { col: 0, row: 0 });
});
