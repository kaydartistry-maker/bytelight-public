import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const config = readFileSync(new URL('../../capacitor.config.ts', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../../android/app/src/main/res/values/styles.xml', import.meta.url), 'utf8');

// The shell opts out of edge-to-edge, so Android resizes the window above the
// keyboard. Capacitor's SystemBars padding on top of that took the keyboard
// off twice and left the app a strip over a gray window. One of the two only.
test('the keyboard is subtracted once: edge-to-edge opted out, SystemBars insets off', () => {
  assert.match(styles, /windowOptOutEdgeToEdgeEnforcement">true/);
  assert.match(config, /SystemBars:\s*\{\s*insetsHandling:\s*'disable'\s*\}/);
});
