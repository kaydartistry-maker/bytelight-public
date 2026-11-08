// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discordTurnAudience, isTurnAudience, guestToolRefusal } from './turn-audience.js';

const HERE = dirname(fileURLToPath(import.meta.url));

test('the owner on Discord is the owner', () => {
  assert.deepEqual(discordTurnAudience(true, undefined), { kind: 'owner' });
  assert.deepEqual(discordTurnAudience(true, 'limited'), { kind: 'owner' });
});

test('anyone else is a guest at the trust their rule gives them', () => {
  assert.deepEqual(discordTurnAudience(false, 'full'), { kind: 'guest', trust: 'full' });
  assert.deepEqual(discordTurnAudience(false, 'standard'), { kind: 'guest', trust: 'standard' });
  assert.deepEqual(discordTurnAudience(false, 'limited'), { kind: 'guest', trust: 'limited' });
});

test('no rule, or a trust level nobody recognises, is the narrowest profile', () => {
  assert.deepEqual(discordTurnAudience(false, undefined), { kind: 'guest', trust: 'limited' });
  assert.deepEqual(discordTurnAudience(false, 'owner'), { kind: 'guest', trust: 'limited' });
});

test('only a well-formed audience passes the check', () => {
  assert.equal(isTurnAudience({ kind: 'owner' }), true);
  assert.equal(isTurnAudience({ kind: 'guest', trust: 'standard' }), true);
  assert.equal(isTurnAudience({ kind: 'guest', trust: 'root' }), false);
  assert.equal(isTurnAudience({ kind: 'guest' }), false);
  assert.equal(isTurnAudience('owner'), false);
  assert.equal(isTurnAudience(null), false);
});

test('the Discord handler stamps every turn it hands over with its audience', () => {
  const source = readFileSync(join(HERE, 'discord', 'index.ts'), 'utf-8');
  const call = source.slice(source.indexOf('this.agentService.processMessage('));
  const opts = call.slice(0, call.indexOf(');'));
  assert.match(opts, /audience: discordTurnAudience\(isOwner, getUserRule\(userId\)\?\.trustLevel\)/);
});

test('the lane is handed the audience in the inbox record', () => {
  const runtime = readFileSync(join(HERE, 'heartbeat', 'runtime.ts'), 'utf-8');
  const append = runtime.slice(runtime.indexOf('session.appendInbox({'));
  assert.match(append.slice(0, append.indexOf('});')), /audience/);
});

// byte-light runs its engines from agent.ts rather than a router module, so
// the same promises are checked where they live here.
test('agent.ts reads the audience once and hands it to every engine', () => {
  const agent = readFileSync(join(HERE, 'agent.ts'), 'utf-8');
  assert.match(agent, /const turnAudience = isTurnAudience\(platformOpts\?\.audience\) \? platformOpts\.audience : undefined/);
  // SDK lane: the PreToolUse hook sees it, and a guest is handed no MCP servers.
  assert.match(agent, /\.\.\.\(turnAudience \? \{ audience: turnAudience \} : \{\}\),\n    \};/);
  assert.match(agent, /!guestTurn && Object\.keys\(allMcpServers\)\.length > 0/);
  // Router / Codex OAuth: no tools offered, and the belt context carries it.
  assert.match(agent, /if \(!guestTurn && runtimeNeedsRouterToolPayload/);
  assert.match(agent, /runWithBeltContext\(\{\n\s+threadId,\n\s+\.\.\.\(turnAudience \? \{ audience: turnAudience \} : \{\}\),/);
  // Warm CLI lanes: it rides the turn input.
  assert.match(agent, /if \(turnAudience\) turnInput\.audience = turnAudience;/);
});

test('every tool door refuses a guest through guestToolRefusal', () => {
  const hooks = readFileSync(join(HERE, 'hooks.ts'), 'utf-8');
  assert.match(hooks, /guestToolRefusal\(ctx\.audience, rawToolName\)/);
  const bridge = readFileSync(join(HERE, 'mcp-bridge.ts'), 'utf-8');
  const exec = bridge.slice(bridge.indexOf('export async function executeRouterTool('));
  assert.match(exec.slice(0, exec.indexOf('executeBeltTool(')), /guestToolRefusal\(getBeltContext\(\)\?\.audience, name\)/);
  // The .mcp.json door for the API lanes refuses before it reaches a server.
  const foreign = bridge.slice(bridge.indexOf('export async function executeForeignLaneTool('));
  assert.match(foreign.slice(0, foreign.indexOf('executeMcpJsonTool(')), /guestToolRefusal\(getBeltContext\(\)\?\.audience, name\)/);
  const belt = readFileSync(join(HERE, '..', 'routes', 'mcp-belt.ts'), 'utf-8');
  assert.match(belt, /deps\.activeAudience\?\.\(\)/);
});

test('the phone, Telegram and the house never stamp a turn as a guest', () => {
  // Only Discord says who is asking; everything else is the owner's by absence.
  for (const file of [join('telegram', 'index.ts'), 'ws.ts', 'orchestrator.ts', 'commands.ts', join('..', 'routes', 'messages.ts')]) {
    const src = readFileSync(join(HERE, file), 'utf-8');
    assert.doesNotMatch(src, /audience:/, file);
  }
});

test('guestToolRefusal blocks every router tool for a guest', () => {
  const r = guestToolRefusal({ kind: 'guest', trust: 'full' }, 'shell_exec');
  assert.ok(r && r.ok === false);
  assert.match(r.result, /not available on a guest turn/);
  // Even a full-trust guest, even a read-shaped tool: the router path has no safe subset.
  assert.ok(guestToolRefusal({ kind: 'guest', trust: 'full' }, 'read_file'));
  assert.ok(guestToolRefusal({ kind: 'guest', trust: 'limited' }, 'core_memory_append'));
});

test('guestToolRefusal lets the owner and the wakes (no audience) run tools', () => {
  assert.equal(guestToolRefusal({ kind: 'owner' }, 'shell_exec'), null);
  assert.equal(guestToolRefusal(undefined, 'codex_exec'), null);
});
