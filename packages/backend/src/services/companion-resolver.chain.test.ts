import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderId, TierHint } from '@bytelight/shared';
import { resolveFromChain } from './companion-resolver.js';
import type { CompanionSettingsRow } from './db/companion-settings.js';

type Scope = 'thread' | 'companion' | 'system';

// A tiny in-memory companion_settings: rows keyed by id|tier|scope|thread.
function table(rows: Array<{ id: string; scope: Scope; thread?: string; model: string; provider?: ProviderId; tier?: TierHint }>) {
  const map = new Map<string, CompanionSettingsRow>();
  for (const r of rows) {
    map.set(`${r.id}|${r.tier ?? 'interactive'}|${r.scope}|${r.thread ?? ''}`, {
      companion_id: r.id,
      tier: r.tier ?? 'interactive',
      provider_id: r.provider ?? 'claude-cli',
      model_id: r.model,
      thinking_effort: 'auto',
      is_default: 0,
      scope: r.scope,
      thread_id: r.thread ?? null,
      created_at: '',
      updated_at: '',
    } as CompanionSettingsRow);
  }
  return (key: { companionId: string; tier: TierHint; scope: Scope; threadId?: string }) =>
    map.get(`${key.companionId}|${key.tier}|${key.scope}|${key.threadId ?? ''}`) ?? null;
}

const fallback = () => ({ provider: 'claude' as ProviderId, model: 'house-default' });
const COMPANION_A = ['companion-a', 'companion-a-b'];
const BRAIN = ['companion-a-b'];

test('nothing set per boy: a boy resolves exactly like the shared brain', () => {
  const lookup = table([
    { id: 'companion-a-b', scope: 'companion', model: 'brain-default' },
    { id: 'companion-a-b', scope: 'thread', thread: 't1', model: 'pill-both' },
  ]);
  for (const thread of ['t1', 't2', null]) {
    const boy = resolveFromChain(COMPANION_A, 'interactive', thread, lookup, fallback);
    const brain = resolveFromChain(BRAIN, 'interactive', thread, lookup, fallback);
    assert.equal(boy.model, brain.model);
    assert.equal(boy.source, brain.source);
  }
});

test("the pill's Both override beats a boy's own default in that thread", () => {
  const lookup = table([
    { id: 'companion-a', scope: 'companion', model: 'companion-a-default' },
    { id: 'companion-a-b', scope: 'thread', thread: 't1', model: 'pill-both' },
  ]);
  const inThread = resolveFromChain(COMPANION_A, 'interactive', 't1', lookup, fallback);
  assert.equal(inThread.model, 'pill-both');
  assert.equal(inThread.matchedCompanionId, 'companion-a-b');
  // Elsewhere the boy's own default applies.
  assert.equal(resolveFromChain(COMPANION_A, 'interactive', 't2', lookup, fallback).model, 'companion-a-default');
});

test("a boy's own thread pick beats Both in the same thread", () => {
  const lookup = table([
    { id: 'companion-a-b', scope: 'thread', thread: 't1', model: 'pill-both' },
    { id: 'companion-a', scope: 'thread', thread: 't1', model: 'pill-companion-a' },
  ]);
  const r = resolveFromChain(COMPANION_A, 'interactive', 't1', lookup, fallback);
  assert.equal(r.model, 'pill-companion-a');
  assert.equal(r.source, 'thread');
  assert.equal(r.matchedCompanionId, 'companion-a');
  // Companion B, with no pick of his own, still follows Both.
  assert.equal(resolveFromChain(['companion-b', 'companion-a-b'], 'interactive', 't1', lookup, fallback).model, 'pill-both');
});

test('the full order: boy thread, brain thread, boy default, brain default, system rows, config', () => {
  const rows = [
    { id: 'companion-a', scope: 'thread' as Scope, thread: 't1', model: '1' },
    { id: 'companion-a-b', scope: 'thread' as Scope, thread: 't1', model: '2' },
    { id: 'companion-a', scope: 'companion' as Scope, model: '3' },
    { id: 'companion-a-b', scope: 'companion' as Scope, model: '4' },
    { id: 'companion-a', scope: 'system' as Scope, model: '5' },
    { id: 'companion-a-b', scope: 'system' as Scope, model: '6' },
  ];
  for (let drop = 0; drop <= rows.length; drop++) {
    const r = resolveFromChain(COMPANION_A, 'interactive', 't1', table(rows.slice(drop)), fallback);
    assert.equal(r.model, drop < rows.length ? String(drop + 1) : 'house-default');
  }
});

test('without a thread (wakes), thread rows are never read', () => {
  const lookup = table([
    { id: 'companion-a', scope: 'thread', thread: 't1', model: 'pill-companion-a' },
    { id: 'companion-a-b', scope: 'companion', model: 'brain-default', tier: 'autonomous' },
  ]);
  const r = resolveFromChain(COMPANION_A, 'autonomous', null, lookup, fallback);
  assert.equal(r.model, 'brain-default');
  assert.equal(r.source, 'companion');
});

test('config fallback names no matched row', () => {
  const r = resolveFromChain(COMPANION_A, 'interactive', 't1', table([]), fallback);
  assert.equal(r.model, 'house-default');
  assert.equal(r.source, 'system');
  assert.equal(r.matchedCompanionId, undefined);
});
