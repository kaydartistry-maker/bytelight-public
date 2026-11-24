/**
 * Slice 5a parity pins — the steering wheel.
 *
 * Three test-enforced contracts for wiring resolveCompanionConfig into
 * agent.ts model resolution (via resolveModelForTurn):
 *
 *  PIN 1 (config parity / wake-day invariance):
 *    With a fresh DB containing ONLY the rows the production migrations
 *    seed (011: pulse/memory → haiku system rows; interactive/autonomous
 *    deliberately unseeded), the resolved turn model for every live
 *    Claude model string set as `agent.model` / `agent.model_autonomous`
 *    must equal the pre-5a getConfiguredModel oracle byte-for-byte.
 *    Hierarchy (documented + pinned): thread row > companion row >
 *    system row > config (DB > YAML > env > default). Wake-day state:
 *    companion rows mirroring the operator's config
 *    (claude / claude-opus-4-7[1m]) must still resolve to
 *    'claude-opus-4-7[1m]' — identical behavior, now sourced from the
 *    companion row.
 *
 *  PIN 2 (round-trip): PUT /api/companion-settings/thread →
 *    GET /api/companion-settings/effective returns it →
 *    resolveCompanionConfig / resolveModelForTurn resolve to it →
 *    DELETE clears → falls back to companion row / config.
 *    Routes are exercised by invoking the express Router directly with
 *    minimal fake req/res (repo pattern — no supertest dep; auth
 *    lives on the parent router in api.ts, outside this unit).
 *
 *  PIN 3 (foreign-ref flow): a thread override row naming
 *    openai-codex / gpt-5.5 (exactly what the June picker PUTs:
 *    providerId + modelId) resolves to a codex-lane ModelRef and,
 *    dispatched through _processQuery, takes the Slice 3b foreign
 *    branch — proven by the codex auth_required degrade sentinel,
 *    which the Claude query() lane can never produce (pattern reused
 *    from agent.dual-path.test.ts) — while `agent.model` stays a
 *    Claude id the whole time.
 *
 * Mirrors agent.dual-path.test.ts bootstrap: temp RESONANT_HOME + real
 * disk-backed DB through the production initDb migration path.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpRoot = mkdtempSync(join(tmpdir(), 'model-resolution-parity-'));
process.env.RESONANT_HOME = tmpRoot;
// Isolate the Codex auth check from the real machine: point it at a
// nonexistent file inside tmpRoot so isCodexLoggedIn() returns false and
// PIN 3's foreign-lane auth_required degrade fires (otherwise a connected
// Codex on the host makes getCodexAuthPath() resolve to a REAL
// data/codex-auth.json and this "logged out" scenario false-reds).
process.env.CODEX_AUTH_PATH = join(tmpRoot, 'no-codex-auth.json');
process.env.CODEX_CLI_AUTH_PATH = join(tmpRoot, 'no-codex-cli-auth.json');

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Router, Request, Response } from 'express';
import { MODEL_VARIANTS } from '@bytelight/shared';
import {
  initDb,
  createThread,
  setConfig as setDbConfig,
  getMessages,
  getProviderSession,
} from './db.js';
import { AgentService, getConfiguredModel } from './agent.js';
import { resolveModelForTurn } from './agent/model-resolution.js';
import { resolveCompanionConfig } from './companion-resolver.js';
import {
  upsertCompanionSetting,
  deleteCompanionSetting,
  getCompanionSetting,
} from './db/companion-settings.js';
import { createCompanionSettingsRoutes } from '../routes/companion-settings-routes.js';
import { loadConfig } from '../config.js';

const THREAD_ID = 'parity-thread';
const FOREIGN_THREAD_ID = 'parity-foreign-thread';
const COMPANION_ID = 'companion-a-b';

// The operator's real production state (preflight 2026-07-04): companion
// rows for interactive + autonomous mirroring agent.model.
const WAKE_DAY_MODEL = 'claude-opus-4-7[1m]';

// Every live Claude model string a settings surface can produce — same
// enumeration as agent.runtime-descriptor.test.ts / agent.dual-path.test.ts.
const LIVE_CLAUDE_MODELS = [
  'claude-sonnet-4-6',
  ...MODEL_VARIANTS.map((v) => v.modelApiId),
];

before(() => {
  // Nonexistent path → pure DEFAULTS (no live bytelight.yaml pickup).
  loadConfig(join(tmpRoot, 'bytelight.yaml'));
  initDb(join(tmpRoot, 'parity.db'));
  const now = new Date().toISOString();
  createThread({ id: THREAD_ID, name: 'parity', type: 'named', createdAt: now });
  createThread({ id: FOREIGN_THREAD_ID, name: 'parity-foreign', type: 'named', createdAt: now });
});

// ─── Minimal fake req/res for direct Router invocation ───────────────────

interface FakeRes {
  statusCode: number;
  jsonBody: unknown;
}

function callRoute(
  router: Router,
  method: 'GET' | 'PUT' | 'DELETE',
  url: string,
  opts: { query?: Record<string, string>; body?: unknown } = {},
): Promise<FakeRes> {
  return new Promise((resolve, reject) => {
    const out: FakeRes = { statusCode: 200, jsonBody: undefined };
    const req = {
      method,
      url,
      headers: {},
      query: opts.query ?? {},
      body: opts.body ?? {},
    } as unknown as Request;
    const res = {
      status(code: number) {
        out.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        out.jsonBody = payload;
        resolve(out);
        return this;
      },
    } as unknown as Response;
    // Router instances are callable middleware. `next` firing means no
    // handler matched (or a handler errored) — both are test failures.
    (router as unknown as (req: Request, res: Response, next: (err?: unknown) => void) => void)(
      req,
      res,
      (err?: unknown) => reject(err ?? new Error(`no route matched ${method} ${url}`)),
    );
  });
}

// ─── PIN 1 — config parity with only migration-seeded rows ───────────────

describe('PIN 1 — resolver/config parity (fresh DB, migration seeds only)', () => {
  test('migration 011 seeds exist and only pulse/memory are seeded', () => {
    assert.ok(getCompanionSetting({ companionId: COMPANION_ID, tier: 'pulse', scope: 'system' }));
    assert.ok(getCompanionSetting({ companionId: COMPANION_ID, tier: 'memory', scope: 'system' }));
    assert.equal(getCompanionSetting({ companionId: COMPANION_ID, tier: 'interactive', scope: 'system' }), null);
    assert.equal(getCompanionSetting({ companionId: COMPANION_ID, tier: 'autonomous', scope: 'system' }), null);
    assert.equal(getCompanionSetting({ companionId: COMPANION_ID, tier: 'interactive', scope: 'companion' }), null);
    assert.equal(getCompanionSetting({ companionId: COMPANION_ID, tier: 'autonomous', scope: 'companion' }), null);
  });

  test('pure defaults: resolved model equals the getConfiguredModel oracle', () => {
    for (const isAutonomous of [false, true]) {
      const resolved = resolveModelForTurn({ isAutonomous, threadId: THREAD_ID });
      assert.equal(
        resolved.model,
        getConfiguredModel(isAutonomous),
        `defaults parity broken (isAutonomous=${isAutonomous})`,
      );
      assert.equal(resolved.tierConfig.source, 'system');
      assert.equal(resolved.modelRef.runtime, 'claude-sdk');
    }
  });

  test('every live Claude model string set as config resolves identically to the oracle', () => {
    try {
      for (const model of LIVE_CLAUDE_MODELS) {
        setDbConfig('agent.model', model);
        setDbConfig('agent.model_autonomous', model);
        for (const isAutonomous of [false, true]) {
          const oracle = getConfiguredModel(isAutonomous);
          assert.equal(oracle, model, `oracle drift for '${model}'`);
          const resolved = resolveModelForTurn({ isAutonomous, threadId: THREAD_ID });
          assert.equal(
            resolved.model,
            oracle,
            `'${model}' (isAutonomous=${isAutonomous}): resolver diverged from getConfiguredModel`,
          );
          assert.equal(resolved.tierConfig.provider, 'claude');
          assert.equal(resolved.tierConfig.source, 'system');
          assert.equal(
            resolved.modelRef.runtime,
            'claude-sdk',
            `'${model}' must stay on the Claude lane`,
          );
        }
      }
    } finally {
      // Leave config in the wake-day state for the tests below.
      setDbConfig('agent.model', WAKE_DAY_MODEL);
      setDbConfig('agent.model_autonomous', WAKE_DAY_MODEL);
    }
  });

  test('canonical foreign config value keeps its real provider (pre-5a dormant path)', () => {
    // Pre-5a, resolveRuntimeDescriptor(getConfiguredModel()) normalized the
    // raw config string — so 'openai-codex/gpt-5.5' in agent.model routed
    // foreign (agent.dual-path.test.ts (a)). The resolver's systemFallback
    // must not mislabel it 'claude'.
    try {
      setDbConfig('agent.model', 'openai-codex/gpt-5.5');
      const resolved = resolveModelForTurn({ isAutonomous: false, threadId: THREAD_ID });
      assert.equal(resolved.tierConfig.provider, 'openai-codex');
      assert.equal(resolved.model, 'gpt-5.5');
      assert.equal(resolved.modelRef.runtime, 'codex');
      assert.equal(resolved.modelRef.canonical, 'openai-codex/gpt-5.5');
    } finally {
      setDbConfig('agent.model', WAKE_DAY_MODEL);
    }
  });

  test('seed rows: pulse + memory resolve to haiku system rows, not agent.model', () => {
    for (const tier of ['pulse', 'memory'] as const) {
      const resolved = resolveCompanionConfig(COMPANION_ID, tier, null);
      assert.equal(resolved.model, 'claude-haiku-4-5', `${tier} should ride the 011 seed`);
      assert.equal(resolved.source, 'system');
    }
  });

  test('wake-day invariance: companion rows mirroring config still resolve to claude-opus-4-7[1m]', () => {
    // Reproduce the operator's actual production rows.
    for (const tier of ['interactive', 'autonomous'] as const) {
      upsertCompanionSetting({
        companionId: COMPANION_ID,
        tier,
        scope: 'companion',
        providerId: 'claude',
        modelId: WAKE_DAY_MODEL,
        thinkingEffort: null,
      });
    }
    for (const isAutonomous of [false, true]) {
      const resolved = resolveModelForTurn({ isAutonomous, threadId: THREAD_ID });
      assert.equal(resolved.model, WAKE_DAY_MODEL, 'wake-day model must be unchanged');
      // Companion row outranks config — same string, different (documented) source.
      assert.equal(resolved.tierConfig.source, 'companion');
      assert.equal(resolved.modelRef.runtime, 'claude-sdk');
      // The pre-5a oracle agrees byte-for-byte: identical wake-day behavior.
      assert.equal(resolved.model, getConfiguredModel(isAutonomous));
      // NULL row effort → 'auto' sentinel → agent.ts falls through to the
      // pre-5a getConfiguredThinkingEffort chain (see SLICE-5a ADAPTATION
      // (effort) in agent.ts).
      assert.equal(resolved.tierConfig.effort, 'auto');
    }
  });
});

// ─── PIN 2 — route round-trip ─────────────────────────────────────────────

describe('PIN 2 — thread override round-trip (PUT → GET → resolver → DELETE)', () => {
  const router = createCompanionSettingsRoutes();
  const OVERRIDE_MODEL = 'claude-sonnet-4-6';

  test('PUT writes the thread-scope row', async () => {
    const res = await callRoute(router, 'PUT', '/companion-settings/thread', {
      body: {
        companionId: COMPANION_ID,
        tier: 'interactive',
        threadId: THREAD_ID,
        providerId: 'claude',
        modelId: OVERRIDE_MODEL,
        thinkingEffort: 'high',
      },
    });
    assert.equal(res.statusCode, 200);
    assert.equal((res.jsonBody as { ok: boolean }).ok, true);
  });

  test('GET /effective returns the override with source=thread', async () => {
    const res = await callRoute(router, 'GET', '/companion-settings/effective', {
      query: { companionId: COMPANION_ID, tier: 'interactive', threadId: THREAD_ID },
    });
    assert.equal(res.statusCode, 200);
    const body = res.jsonBody as {
      provider: string; model: string; thinkingEffort: string; source: string;
    };
    assert.equal(body.provider, 'claude');
    assert.equal(body.model, OVERRIDE_MODEL);
    assert.equal(body.thinkingEffort, 'high');
    assert.equal(body.source, 'thread');
  });

  test('resolveCompanionConfig + resolveModelForTurn read the same row', () => {
    const direct = resolveCompanionConfig(COMPANION_ID, 'interactive', THREAD_ID);
    assert.equal(direct.model, OVERRIDE_MODEL);
    assert.equal(direct.source, 'thread');
    assert.equal(direct.effort, 'high');

    const turn = resolveModelForTurn({ isAutonomous: false, threadId: THREAD_ID });
    assert.equal(turn.model, OVERRIDE_MODEL);
    assert.equal(turn.tierConfig.source, 'thread');
    assert.equal(turn.modelRef.runtime, 'claude-sdk');

    // Autonomous turns are never thread-scoped (resolveModelForTurn passes
    // threadId=null) — the override must NOT leak into autonomous.
    const auto = resolveModelForTurn({ isAutonomous: true, threadId: THREAD_ID });
    assert.equal(auto.model, WAKE_DAY_MODEL);
    assert.equal(auto.tierConfig.source, 'companion');
  });

  test('DELETE clears the override; resolution falls back to the companion row', async () => {
    const res = await callRoute(router, 'DELETE', '/companion-settings/thread', {
      body: { companionId: COMPANION_ID, tier: 'interactive', threadId: THREAD_ID },
    });
    assert.equal(res.statusCode, 200);
    assert.equal((res.jsonBody as { removed: boolean }).removed, true);

    const effective = await callRoute(router, 'GET', '/companion-settings/effective', {
      query: { companionId: COMPANION_ID, tier: 'interactive', threadId: THREAD_ID },
    });
    const body = effective.jsonBody as { model: string; source: string };
    assert.equal(body.model, WAKE_DAY_MODEL);
    assert.equal(body.source, 'companion');

    const turn = resolveModelForTurn({ isAutonomous: false, threadId: THREAD_ID });
    assert.equal(turn.model, WAKE_DAY_MODEL);
  });

  test('write routes reject non-interactive tiers (pill is interactive-only)', async () => {
    const res = await callRoute(router, 'PUT', '/companion-settings/thread', {
      body: {
        companionId: COMPANION_ID,
        tier: 'autonomous',
        threadId: THREAD_ID,
        providerId: 'claude',
        modelId: OVERRIDE_MODEL,
      },
    });
    assert.equal(res.statusCode, 400);
  });
});

// ─── PIN 3 — foreign thread override routes down the foreign branch ──────

describe('PIN 3 — thread row naming openai-codex/gpt-5.5 rides the foreign lane', () => {
  test('resolver produces a codex-lane ModelRef from the picker\'s storage format', () => {
    // Exactly what the June picker PUTs: providerId + modelId, stored as
    // separate columns; the resolver re-joins them for normalizeModelRef.
    upsertCompanionSetting({
      companionId: COMPANION_ID,
      tier: 'interactive',
      scope: 'thread',
      threadId: FOREIGN_THREAD_ID,
      providerId: 'openai-codex',
      modelId: 'gpt-5.5',
      thinkingEffort: 'auto',
    });

    const turn = resolveModelForTurn({ isAutonomous: false, threadId: FOREIGN_THREAD_ID });
    // The Slice 3b dispatch gate is exactly this predicate (computed before
    // the equality assert below narrows the literal type).
    const ridesForeignLane = turn.modelRef.runtime !== 'claude-sdk';
    assert.equal(turn.model, 'gpt-5.5');
    assert.equal(turn.tierConfig.provider, 'openai-codex');
    assert.equal(turn.tierConfig.source, 'thread');
    assert.equal(turn.modelRef.runtime, 'codex');
    assert.equal(turn.modelRef.canonical, 'openai-codex/gpt-5.5');
    assert.equal(ridesForeignLane, true);
  });

  test('dispatched turn reaches the codex runtime (auth_required degrade), config still Claude', async () => {
    // agent.model stays a Claude id for the whole test — the THREAD ROW,
    // not config, must be what routes this thread foreign.
    assert.equal(getConfiguredModel(false), WAKE_DAY_MODEL);

    const svc = new AgentService();
    const result = await (svc as unknown as {
      _processQuery(threadId: string, content: string): Promise<string>;
    })._processQuery(FOREIGN_THREAD_ID, 'hello from the slice-5a parity test');

    // Sentinel only the foreign branch's canonical consumer can produce
    // (no OAuth file under tmpRoot → codex degrades to auth_required).
    assert.match(
      result,
      /Codex authentication required/,
      'thread-override turn must surface the codex auth_required degrade',
    );

    // Shared tail persisted the companion message.
    const msgs = getMessages({ threadId: FOREIGN_THREAD_ID, limit: 5 });
    const companion = msgs.filter((m) => m.role === 'companion').pop();
    assert.ok(companion, 'companion message persisted');
    assert.match(companion!.content, /Codex authentication required/);

    // Unauthed codex emits no session → no sidecar row for the foreign key.
    const row = getProviderSession({
      threadId: FOREIGN_THREAD_ID,
      runtimeId: 'codex',
      provider: 'openai-codex',
      modelRef: 'gpt-5.5',
    });
    assert.equal(row, null);
  });

  test('clearing the row returns the thread to the Claude lane', () => {
    assert.equal(
      deleteCompanionSetting({
        companionId: COMPANION_ID,
        tier: 'interactive',
        scope: 'thread',
        threadId: FOREIGN_THREAD_ID,
      }),
      true,
    );
    const turn = resolveModelForTurn({ isAutonomous: false, threadId: FOREIGN_THREAD_ID });
    assert.equal(turn.model, WAKE_DAY_MODEL);
    assert.equal(turn.tierConfig.source, 'companion');
    assert.equal(turn.modelRef.runtime, 'claude-sdk');
  });
});
