import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const settings = readFileSync(new URL('../components/SettingsDashboard.tsx', import.meta.url), 'utf8');
const editor = readFileSync(new URL('../components/AppearanceStudio.tsx', import.meta.url), 'utf8');

test('render-only previews are excluded from both local and server persistence', () => {
  assert.match(app, /const theme = previewTheme \?\? storedTheme/);
  assert.match(app, /localforage\.setItem\('bytelight_theme', storedTheme\)/);
  assert.match(app, /const themeForLocalStorage = themeFirstPaintCache\(storedTheme\)/);
  assert.match(app, /settingsSnapshot\.current = \{ theme: storedTheme, contacts, appSettings \}/);
  assert.match(app, /pushServerSettingsDetailed\(settingsEnvelope\(\)\)/);
  assert.doesNotMatch(app, /pushServerSettings(?:Detailed)?\(\{ theme, contacts/);
  assert.match(app, /if \(!serverSettingsHydrated\.current\) return/);
});

test('the existing preview is upgraded once, with draft controls and explicit apply', () => {
  assert.equal((settings.match(/<AppearancePreview\b/g) || []).length, 1);
  assert.equal((settings.match(/<AppearanceStudio\b/g) || []).length, 1);
  assert.doesNotMatch(settings, /How's the vibe looking\?/);
  assert.match(editor, /onApplyTheme\(draft\)/);
  assert.match(app, /onThemeReplace=\{applyThemeDurably\}/);
  assert.match(app, /await localforage\.setItem\('bytelight_theme', next\)[\s\S]*?setTheme\(next\)[\s\S]*?await pushServerSettingsDetailed\(settingsEnvelope\(\{ theme: next \}\)\)/);
  assert.match(editor, /const result = await onApplyTheme\(draft\)/);
  assert.match(editor, /onPreviewChange\(undefined\)/);
  assert.match(app, /if \(!showSettings\) setPreviewTheme\(undefined\)/);
});

test('web push uses the repaired panel without replacing the native FCM controls', () => {
  assert.match(settings, /Capacitor\.isNativePlatform\(\) \? \(/);
  assert.match(settings, /<PushNotificationsPanel colors=\{colors\}/);
  assert.match(settings, /PushNotifications\.addListener\("registration"/);
});
