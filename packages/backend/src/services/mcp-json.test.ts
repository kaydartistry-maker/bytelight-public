import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMcpJson } from './mcp-json.js';

const write = (content: string) => {
  const path = join(mkdtempSync(join(tmpdir(), 'mcpjson-')), '.mcp.json');
  writeFileSync(path, content);
  return path;
};

test('normalizes every entry the Claude lane has always accepted', () => {
  const path = write(JSON.stringify({ mcpServers: {
    a: { type: 'url', url: 'https://a' },
    b: { type: 'http', url: 'https://b', headers: { X: '1' } },
    c: { type: 'sse', url: 'https://c' },
    d: { command: 'node', args: ['d.js'], env: { K: 'v' } },
    e: { type: 'stdio', command: 'e' },
    f: { type: 'weird' },
  } }));
  assert.deepEqual(readMcpJson(path), {
    a: { type: 'http', url: 'https://a', headers: undefined },
    b: { type: 'http', url: 'https://b', headers: { X: '1' } },
    c: { type: 'sse', url: 'https://c', headers: undefined },
    d: { type: 'stdio', command: 'node', args: ['d.js'], env: { K: 'v' } },
    e: { type: 'stdio', command: 'e', args: undefined, env: undefined },
  });
});

test('missing or broken files yield no servers', () => {
  assert.deepEqual(readMcpJson('/nonexistent/.mcp.json'), {});
  assert.deepEqual(readMcpJson(write('{not json')), {});
  assert.deepEqual(readMcpJson(write('{}')), {});
});
