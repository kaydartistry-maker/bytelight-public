// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The Archivist reads one pile and answers once. Its options are the whole
// contract: no tools, one turn, and never a compaction of what it was handed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { archivistSdkOptions } from './archivist-sdk.js';

test('the Archivist never auto-compacts the pile it was handed to read', () => {
  const options = archivistSdkOptions('claude-haiku-5-5', 'system', new AbortController());
  assert.equal(options.env?.DISABLE_AUTO_COMPACT, '1');
  assert.equal(options.env?.PATH, process.env.PATH, 'the rest of the environment still reaches the CLI');
  assert.equal(options.maxTurns, 1);
  assert.deepEqual(options.allowedTools, []);
  // byte-light: built-in tools are removed, not merely left unapproved.
  assert.deepEqual((options as { tools?: unknown }).tools, []);
  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.model, 'claude-haiku-5-5');
});
