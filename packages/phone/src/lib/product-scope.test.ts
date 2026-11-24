import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APPS, appForPath } from './apps';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const restored = ['canvas', 'weather', 'spotify', 'fieldnotes', 'memory', 'treehouse', 'integrations', 'xray', 'journal', 'theater', 'gif', 'cutout'];

test('all original BL apps and retained custom apps are reachable', () => {
  for (const id of [...restored, 'questing', 'studio', 'settings']) {
    assert.equal(appForPath(`/${id}`)?.id, id);
    assert.ok(APPS.some(app => app.id === id), id);
  }
  assert.equal(appForPath('/chat')?.id, 'messages');
  assert.equal(appForPath('/command-center')?.id, 'commandcenter');
  assert.equal(appForPath('/unknown'), null);
});

test('ordinary Messages uses native model, tools and editing without Cloud bridge controls', () => {
  const app = read('../App.tsx');
  for (const native of ['<ModelPill', '<RateLimitBanner', '<ContextIndicator', '<CompactionBanner', 'sendUserMessage(', 'onStartVoiceConversation={ksActiveThreadId']) assert.ok(app.includes(native), native);
  assert.doesNotMatch(app, /ConversationModelPicker|BridgeControls|lettaMessages=|bridgeEnabled=|Letta Messages/);
  const input = read('../components/ChatInput.tsx');
  assert.match(input, /canvas-refs/);
  assert.match(input, /image\/gif/);
  assert.match(read('../bytelight/socket.ts'), /canvas-frames/);
});

test('native Agent and Status use local identity, memory, models and automation', () => {
  const agent = read('../components/AgentApp.tsx');
  for (const feature of ['IdentityApp', 'OrchestratorApp', 'PreferencesApp', 'RuntimeHealthCard']) assert.ok(agent.includes(feature), feature);
  for (const file of ['AgentApp', 'StatusApp', 'SkillsApp']) assert.doesNotMatch(read(`../components/${file}.tsx`), /letta-control|LettaWakes|LettaLab/);
});

test('custom appearance and the dedicated Questing game survive foundation restoration', () => {
  const app = read('../App.tsx');
  for (const feature of ['AppearanceRuntime', 'ThemedAppBackground', 'applyThemeDurably', 'savePresetsDurably', 'QuestingApp']) assert.ok(app.includes(feature), feature);
  const settings = read('../components/SettingsDashboard.tsx');
  assert.match(settings, /AppearanceStudio/);
  assert.match(settings, /lockSpotifyOf/);
  assert.match(settings, /Weather home/);
  assert.match(read('../components/QuestingApp.tsx'), /BossBattles/);
});
