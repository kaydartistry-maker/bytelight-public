import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settingsForClient } from './settings-view.js';

test('the settings the phone gets carry no stored secret', () => {
  const view = settingsForClient({
    'agent.model': 'claude-opus-5-5',
    'secret:discord_bot_token': 'MTQ-not-a-real-token',
    'secret:fcm_service_account': '{"private_key":"x"}',
    'heartbeat.autocompact_tokens': '800000',
  });
  assert.deepEqual(view, { 'agent.model': 'claude-opus-5-5', 'heartbeat.autocompact_tokens': '800000' });
});

test('the settings door refuses secrets, security switches, auth and app_settings', async () => {
  const { isGuardedSettingKey } = await import('./settings-view.js');
  for (const k of ['secret:discord_bot_token', 'SECRET:x', 'security.csrf_mode', 'auth.password', 'app_settings', ' app_settings ']) {
    assert.equal(isGuardedSettingKey(k), true, k);
  }
  for (const k of ['agent.model', 'orchestrator.thread_cadence', 'agent.claude_session_resume', 'voice.tts_model']) {
    assert.equal(isGuardedSettingKey(k), false, k);
  }
});

test('a key stored outside the secrets prefix is left out too', () => {
  const out = settingsForClient({ 'image_gen.openai_api_key': 'sk-dummy', 'image_gen.backend': 'codex', 'cortex.token': 't' });
  assert.deepEqual(out, { 'image_gen.backend': 'codex' });
});

test('the settings door refuses a setting that names a program to run', async () => {
  const { isGuardedSettingKey } = await import('./settings-view.js');
  for (const k of ['image_gen.codex_bin', 'image_gen.antigravity_bin', 'videos.ytdlp_path', 'Videos.YTDLP_PATH', 'anything.new_bin']) {
    assert.equal(isGuardedSettingKey(k), true, k);
  }
  for (const k of ['voice.local_stt_url', 'videos.max_seconds', 'image_gen.backend']) {
    assert.equal(isGuardedSettingKey(k), false, k);
  }
});
