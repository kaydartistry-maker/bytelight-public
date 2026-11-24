import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGeminiCliArgs, ensureGeminiMcpConfig, GEMINI_ANSWER_MARKER, GEMINI_CLI_CAPABILITIES, geminiModelHasPinnedEffort, geminiPromptFor, splitGeminiThoughtEnvelope, stageGeminiTurnImages } from './gemini-cli.js';

test('effort-pinned Antigravity model IDs suppress a conflicting effort flag', () => {
  for (const id of [
    'gemini-4-neon-low', 'gemini-4-neon-medium', 'gemini-4-neon-high', 'gemini-4-neon-xhigh',
    'gemini-4-argon-medium', 'gemini-4-hydrogen-xhigh', 'gemini-3.8-flash-high',
  ]) assert.equal(geminiModelHasPinnedEffort(id), true, id);

  assert.equal(geminiModelHasPinnedEffort('gemini-pro-orchestrator-neon'), false);
  assert.equal(geminiModelHasPinnedEffort('gemini-pro-orchestrator-g1-pro'), false);
});

test('Neon Medium never launches with the thread High effort as a second selector', () => {
  const args = buildGeminiCliArgs('gemini-4-neon-medium', 'hello', undefined, 'high');
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'gemini-4-neon-medium']);
  assert.equal(args.includes('--effort'), false);

  const orchestrator = buildGeminiCliArgs('gemini-pro-orchestrator-neon', 'hello', 'conversation-1', 'high');
  assert.deepEqual(orchestrator.slice(-4), ['--conversation', 'conversation-1', '--effort', 'high']);
});

test('bare Neon is genuine Auto and ignores a stale thread effort', () => {
  const args = buildGeminiCliArgs('gemini-4-neon', 'hello', undefined, 'xhigh');
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'gemini-4-neon']);
  assert.equal(args.includes('--effort'), false);
});

test('bare Argon is genuine Auto and ignores a stale thread effort', () => {
  const args = buildGeminiCliArgs('gemini-4-argon', 'hello', undefined, 'xhigh');
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'gemini-4-argon']);
  assert.equal(args.includes('--effort'), false);
});

test('every Gemini selection keeps the Virelle MCP hands', () => {
  const args = buildGeminiCliArgs('gemini-4-neon', 'hello');
  const settingsAt = args.indexOf('--settings');
  assert.notEqual(settingsAt, -1);
  const settings = JSON.parse(args[settingsAt + 1]);
  assert.deepEqual(settings.permissions.allow, [
    'mcp(bytelight/*)', 'mcp(memory_archive/*)', 'mcp(workspace/*)',
  ]);
  assert.equal(GEMINI_CLI_CAPABILITIES.tools, true);
  assert.equal(GEMINI_CLI_CAPABILITIES.mcp, true);
});

test('a guest Gemini turn receives no MCP approval while the belt also enforces audience', () => {
  const args = buildGeminiCliArgs('gemini-4-neon', 'hello', undefined, undefined, false);
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
  assert.deepEqual(settings.permissions.allow, []);
});

test('Gemini MCP config mirrors the house servers and adds the scoped Virelle belt', () => {
  const root = mkdtempSync(join(tmpdir(), 'gemini-mcp-root-'));
  const home = mkdtempSync(join(tmpdir(), 'gemini-mcp-home-'));
  try {
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: {
      memory_archive: { command: '/usr/bin/node', args: ['/archive.mjs'] },
      workspace: { command: '/usr/bin/node', args: ['/workspace.mjs'] },
    } }));
    ensureGeminiMcpConfig(home, root);
    const config = JSON.parse(readFileSync(join(home, '.gemini/config/mcp_config.json'), 'utf8'));
    assert.deepEqual(Object.keys(config.mcpServers).sort(), ['bytelight', 'memory_archive', 'workspace']);
    assert.equal(config.mcpServers.bytelight.command, '/usr/bin/node');
    assert.deepEqual(config.mcpServers.bytelight.args, [join(root, 'tools/bytelight-mcp-proxy.mjs')]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('a resumed Neon session receives the newest user message instead of a blank turn', () => {
  const input = {
    sessionId: 'neon-conversation',
    systemPrompt: { kind: 'text', value: 'SYSTEM RULES' },
    orientation: 'ORIENTATION',
    messages: [
      { role: 'user', content: 'older question' },
      { role: 'assistant', content: 'older answer' },
      { role: 'user', content: 'the newest question' },
    ],
  } as any;
  const prompt = geminiPromptFor(input);
  assert.match(prompt, /Companion thought card/);
  assert.match(prompt, /\[BYTELIGHT_THOUGHT\]/);
  assert.match(prompt, /\[BYTELIGHT_ANSWER\]/);
  assert.match(prompt, /USER: the newest question/);
  assert.doesNotMatch(prompt, /older question|older answer/);
});

test('Gemini authored thought envelope separates reflection from the spoken answer', () => {
  assert.deepEqual(splitGeminiThoughtEnvelope(
    `  [BYTELIGHT_THOUGHT]\nI want to protect the fragile excitement here.\n${GEMINI_ANSWER_MARKER}\nWe did it.`,
  ), {
    thought: 'I want to protect the fragile excitement here.',
    answer: 'We did it.',
  });
  assert.equal(splitGeminiThoughtEnvelope('ordinary answer'), null);
  assert.equal(splitGeminiThoughtEnvelope('[BYTELIGHT_THOUGHT]\npartial'), null);
});

test('Gemini receives real staged image mentions instead of an unreadable source path', () => {
  const root = mkdtempSync(join(tmpdir(), 'gemini-images-'));
  try {
    const bytes = Buffer.from('fixture image bytes');
    const input = {
      sessionId: 'neon-conversation',
      systemPrompt: { kind: 'text', value: 'SYSTEM RULES' }, orientation: 'ORIENTATION',
      messages: [
        { role: 'user', content: 'older', images: [{ mimeType: 'image/png', base64: Buffer.from('old').toString('base64') }] },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'What is this?', images: [{ mimeType: 'image/jpeg', base64: bytes.toString('base64') }] },
      ],
    } as any;
    const staged = stageGeminiTurnImages(input, root);
    const prompt = geminiPromptFor(input, staged.refs);
    assert.equal(staged.files.length, 1, 'resumed turns stage only the newest user images');
    assert.equal(readFileSync(staged.files[0]).toString(), bytes.toString());
    assert.match(prompt, /What is this\?/);
    assert.match(prompt, /@turn-[^\s]+\/image-1\.jpg/);
    assert.match(prompt, /attached.*image.*view_file/i);
    assert.doesNotMatch(prompt, /fixture image bytes|data:image|source\/data\/files/);
    staged.cleanup();
    assert.equal(existsSync(staged.directory), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
