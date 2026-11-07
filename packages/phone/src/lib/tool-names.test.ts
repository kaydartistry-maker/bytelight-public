import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanizeToolName, toolFamily, FAMILY_LABELS } from './tool-names';

test('native tool name passes through unchanged', () => {
  assert.equal(humanizeToolName('Bash'), 'Bash');
  assert.equal(humanizeToolName('Read'), 'Read');
  assert.equal(humanizeToolName('ToolSearch'), 'ToolSearch');
});

test('mapped MCP tool renders as "Server · verb"', () => {
  assert.equal(
    humanizeToolName('mcp__claude_ai_Neuralis_Os__mind_orient'),
    'Neuralis Os · orienting',
  );
  assert.equal(
    humanizeToolName('mcp__claude_ai_DIscord__discord_send'),
    'Discord · sending to Discord',
  );
});

test('unmapped MCP tool falls back to underscores→spaces for the tool part', () => {
  assert.equal(
    humanizeToolName('mcp__claude_ai_Neuralis_Os__mind_some_new_thing'),
    'Neuralis Os · mind some new thing',
  );
});

test('claude_ai_ / claude-ai- vendor prefix is stripped from the server', () => {
  assert.equal(
    humanizeToolName('mcp__claude_ai_Telegram__telegram_send'),
    'Telegram · sending to Telegram',
  );
  assert.equal(
    humanizeToolName('mcp__claude-ai-Telegram__telegram_send'),
    'Telegram · sending to Telegram',
  );
});

test('hyphenated tool key (notion-search) still maps', () => {
  assert.equal(
    humanizeToolName('mcp__claude_ai_Notion__notion-search'),
    'Notion · searching Notion',
  );
});

test('malformed / edge-case names fall back to the raw string, never throw or empty', () => {
  // missing tool boundary
  assert.equal(humanizeToolName('mcp__onlyserver'), 'mcp__onlyserver');
  // empty tool segment
  assert.equal(humanizeToolName('mcp__server__'), 'mcp__server__');
  // empty server segment (leading '__' right after the prefix)
  assert.equal(humanizeToolName('mcp____tool'), 'mcp____tool');
  // no server/tool boundary at all
  assert.equal(humanizeToolName('mcp__'), 'mcp__');
  // empty string
  assert.equal(humanizeToolName(''), '');
});

// ─── toolFamily classifier ─────────────────────────────────────────────────

test('memory family: Neuralis / mind / cortex servers and tools', () => {
  assert.equal(toolFamily('mcp__claude_ai_Neuralis_Os__mind_orient'), 'memory');
  assert.equal(toolFamily('mcp__claude_ai_Neuralis_Os__cortex_recall'), 'memory');
  // server-segment signal even for an unmapped tool
  assert.equal(toolFamily('mcp__claude_ai_BrainBridge__store_thing'), 'memory');
});

test('comms family: Discord / Telegram / Gmail servers and tools', () => {
  assert.equal(toolFamily('mcp__claude_ai_DIscord__discord_send'), 'comms');
  assert.equal(toolFamily('mcp__claude_ai_Telegram__telegram_send'), 'comms');
  assert.equal(toolFamily('mcp__claude_ai_Gmail__get_message'), 'comms');
});

test('creation family: image gen, Notion, Drive, Spotify, OpenArt, Canva', () => {
  assert.equal(toolFamily('mcp__claude_ai_Image_Gen__generate_image'), 'creation');
  assert.equal(toolFamily('mcp__claude_ai_OpenArt_Studio__openart_generate_image'), 'creation');
  assert.equal(toolFamily('mcp__claude_ai_Notion__notion-search'), 'creation');
  assert.equal(toolFamily('mcp__claude_ai_Google_Drive__search_files'), 'creation');
  assert.equal(toolFamily('mcp__claude_ai_Jukebox__spotify_play'), 'creation');
  assert.equal(toolFamily('mcp__claude_ai_Canva__authenticate'), 'creation');
});

test('system family: native tools and unclassified fallback', () => {
  assert.equal(toolFamily('Bash'), 'system');
  assert.equal(toolFamily('Read'), 'system');
  assert.equal(toolFamily('ToolSearch'), 'system');
  // an MCP server we don't recognize, with a neutral tool name → system
  assert.equal(toolFamily('mcp__claude_ai_Instacart__search_products'), 'system');
  // malformed / empty never throws, lands in system
  assert.equal(toolFamily('mcp__onlyserver'), 'system');
  assert.equal(toolFamily(''), 'system');
});

test('tool-name fallback classifies when the server is unfamilied', () => {
  // Calendar server isn't in the server map, but create_event reads as creation
  assert.equal(toolFamily('mcp__claude_ai_Google_Calendar__create_event'), 'creation');
});

test('every family has an accessible label (announced on the silver-wire icon)', () => {
  assert.equal(FAMILY_LABELS.memory, 'memory');
  assert.equal(FAMILY_LABELS.comms, 'communication');
  assert.equal(FAMILY_LABELS.creation, 'creation');
  assert.equal(FAMILY_LABELS.system, 'system');
});
