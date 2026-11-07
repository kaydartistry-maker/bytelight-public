import assert from 'node:assert/strict';
import test from 'node:test';
import { groupToolRuns, formatToolOutput, isHiddenTool, type ToolSegment } from './tool-runs';
import type { MessageSegment } from '../bytelight';

const tool = (id: string, name = 'Bash'): MessageSegment => ({ type: 'tool', toolId: id, toolName: name, input: id, output: 'ok' });
const text = (content: string): MessageSegment => ({ type: 'text', content });

test('seven tools back to back become one run', () => {
  const segs = [text('Night shift.'), ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => tool(id)), text('Found one.')];
  const items = groupToolRuns(segs);
  assert.equal(items.length, 3);
  assert.equal(items[1].kind, 'tools');
  assert.equal(items[1].kind === 'tools' && items[1].tools.length, 7);
  assert.equal(items[1].index, 1);
});

test('text or thinking between tools starts a new run where it happened', () => {
  const segs: MessageSegment[] = [tool('a'), text('mid'), tool('b'), { type: 'thinking', content: 'hm', summary: 'hm' }, tool('c')];
  assert.deepEqual(groupToolRuns(segs).map((i) => i.kind), ['tools', 'segment', 'tools', 'segment', 'tools']);
});

test('hidden plumbing tools vanish without splitting the run around them', () => {
  const segs = [tool('a'), tool('outbox'), tool('b')];
  const items = groupToolRuns(segs, (s: ToolSegment) => s.toolId === 'outbox');
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].kind === 'tools' && items[0].tools.map((t) => t.toolId), ['a', 'b']);
});

test('formatToolOutput pretty-prints JSON and unescapes newlines', () => {
  assert.equal(formatToolOutput('{"a":1}'), '{\n  "a": 1\n}');
  assert.equal(formatToolOutput('line1\\nline2'), 'line1\nline2');
  assert.equal(formatToolOutput(''), '');
});

test('isHiddenTool drops outbox and ack plumbing, keeps real calls', () => {
  const t = (toolName: string, input: string): ToolSegment => ({ type: 'tool', toolId: '', toolName, input });
  assert.equal(isHiddenTool(t('Bash', 'write to outbox/reply.md')), true);
  assert.equal(isHiddenTool(t('Bash', 'acknowledge')), true);
  assert.equal(isHiddenTool(t('mcp__x__companion-post', 'companion-post ping')), true);
  assert.equal(isHiddenTool(t('Bash', 'git status')), false);
  assert.equal(isHiddenTool(t('mcp__claude_ai_Neuralis_Os__mind_orient', '{}')), false);
});

test('a live run keeps its first index as tools stream in', () => {
  const pending = (id: string): MessageSegment => ({ type: 'tool', toolId: '', toolName: 'Bash', input: id });
  const before = groupToolRuns([text('hi'), pending('a')]);
  const after = groupToolRuns([text('hi'), pending('a'), pending('b')]);
  assert.equal(before[1].index, after[1].index);
  assert.equal(after[1].kind === 'tools' && after[1].tools.length, 2);
});
