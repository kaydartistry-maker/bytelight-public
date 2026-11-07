// Tests for /api/models?provider=openai-codex catalog exposure and the
// Codex availability state on /api/models/status. 6B-C Slice 2.
//
// Test strategy:
//   - `computeCodexAvailability` is a pure function — driven directly with
//     synthesized CodexAuthSnapshot objects to exercise every reason branch
//     without touching the filesystem or OAuth substrate.
//   - The catalog branch is tested by invoking the express router with a
//     minimal fake request/response, since this codebase has no supertest
//     dep and existing tests use direct handler invocation patterns
//     elsewhere.
//
// Sentinels in security tests: any token-shaped string ("access-token-",
// "refresh-token-", "oauth-code-", "data/codex-auth.json") MUST NOT appear
// in any response surface. The pure function never sees a token; the route
// handler only ever sees the safe snapshot — but we assert the negative
// boundary explicitly so a future refactor that accidentally widens the
// snapshot shape fails loud.
//
// Run with:
//   npx tsx --test packages/backend/src/routes/models.codex.test.ts

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCodexAvailability,
  buildCodexCatalogEntries,
  buildCodexCliCatalogEntries,
  type CodexAvailabilityStatus,
  type ModelInfo,
} from './models.js';
import type { CodexAuthSnapshot } from '../services/auth/codex-oauth.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

const FIXED_NOW = 1_730_000_000_000; // arbitrary fixed clock for determinism

describe('buildCodexCliCatalogEntries — subscription catalog', () => {
  const entries = buildCodexCliCatalogEntries();

  test('surfaces GPT-6 Astra through the warm Codex CLI lane', () => {
    const astra = entries.find((entry) => entry.id === 'gpt-6-astra');
    assert.ok(astra, 'GPT-6 Astra should appear in the Codex CLI catalog');
    assert.equal(astra.provider, 'codex-cli');
    assert.equal(astra.runtime, 'codex-cli');
    assert.equal(astra.tier, 'included');
    assert.equal(astra.ref, 'codex-cli/gpt-6-astra');
    assert.equal(astra.supports_tools, true);
  });

  test('does not leak GPT-6 Astra into the OpenAI OAuth/API catalog', () => {
    assert.equal(buildCodexCatalogEntries().some((entry) => entry.id === 'gpt-6-astra'), false);
  });
});

function snapshot(overrides: Partial<CodexAuthSnapshot> = {}): CodexAuthSnapshot {
  return {
    loggedIn: false,
    expiresAt: null,
    refreshable: false,
    loginSession: { status: 'idle' },
    ...overrides,
  };
}

function assertNoTokenSentinels(payload: unknown, context: string): void {
  const serialized = JSON.stringify(payload);
  const sentinels = [
    'access-token-',
    'refresh-token-',
    'oauth-code-',
    'data/codex-auth.json',
    '/codex-auth.json',
    'authPath',
    'Bearer ',
  ];
  for (const sentinel of sentinels) {
    assert.ok(
      !serialized.includes(sentinel),
      `${context}: response unexpectedly contains "${sentinel}" — token/path leak suspected`,
    );
  }
}

// ─── computeCodexAvailability — reason branches ───────────────────────────

describe('computeCodexAvailability — connected (valid token, future expiry)', () => {
  const status = computeCodexAvailability(
    snapshot({
      loggedIn: true,
      expiresAt: FIXED_NOW + 60 * 60_000, // 1h in future
      refreshable: true,
    }),
    FIXED_NOW,
  );

  test('reason is "connected"', () => assert.equal(status.reason, 'connected'));
  test('available is true', () => assert.equal(status.available, true));
  test('connected is true', () => assert.equal(status.connected, true));
  test('needsAuth is false', () => assert.equal(status.needsAuth, false));
  test('provider is "openai-codex"', () => assert.equal(status.provider, 'openai-codex'));
  test('runtime is "codex"', () => assert.equal(status.runtime, 'codex'));
  test('expiresAt passthrough', () => assert.equal(status.expiresAt, FIXED_NOW + 60 * 60_000));
  test('refreshable passthrough', () => assert.equal(status.refreshable, true));
});

describe('computeCodexAvailability — expired + refreshable (optimistic per gate)', () => {
  const status = computeCodexAvailability(
    snapshot({
      loggedIn: true,
      expiresAt: FIXED_NOW - 5 * 60_000, // 5min past
      refreshable: true,
    }),
    FIXED_NOW,
  );

  test('reason is "expired"', () => assert.equal(status.reason, 'expired'));
  test('available is true (optimistic — refresh-on-use verified at codex.ts:674)', () =>
    assert.equal(status.available, true));
  test('connected is false (token strictly past expiry)', () => assert.equal(status.connected, false));
  test('needsAuth is false (refresh will succeed on next turn)', () => assert.equal(status.needsAuth, false));
  test('refreshable is true', () => assert.equal(status.refreshable, true));
  test('expiresAt passthrough', () => assert.equal(status.expiresAt, FIXED_NOW - 5 * 60_000));
});

describe('computeCodexAvailability — expired + NOT refreshable (manual reconnect)', () => {
  const status = computeCodexAvailability(
    snapshot({
      loggedIn: true,
      expiresAt: FIXED_NOW - 5 * 60_000,
      refreshable: false,
    }),
    FIXED_NOW,
  );

  test('reason is "needs_auth" (no refresh path available)', () =>
    assert.equal(status.reason, 'needs_auth'));
  test('available is false', () => assert.equal(status.available, false));
  test('needsAuth is true', () => assert.equal(status.needsAuth, true));
  test('refreshable is false', () => assert.equal(status.refreshable, false));
  test('expiresAt passthrough (file present)', () =>
    assert.equal(status.expiresAt, FIXED_NOW - 5 * 60_000));
});

describe('computeCodexAvailability — login_in_progress (OAuth flow active)', () => {
  const status = computeCodexAvailability(
    snapshot({
      loggedIn: false,
      loginSession: { status: 'awaiting_browser', url: 'https://chatgpt.com/oauth?...', startedAt: FIXED_NOW },
    }),
    FIXED_NOW,
  );

  test('reason is "login_in_progress"', () =>
    assert.equal(status.reason, 'login_in_progress'));
  test('available is false (not yet authed)', () => assert.equal(status.available, false));
  test('needsAuth is true', () => assert.equal(status.needsAuth, true));
  test('connected is false', () => assert.equal(status.connected, false));
  test('expiresAt is null (no credentials yet)', () => assert.equal(status.expiresAt, null));
});

describe('computeCodexAvailability — disconnected (no credentials, no active login)', () => {
  const status = computeCodexAvailability(
    snapshot({
      loggedIn: false,
      loginSession: { status: 'idle' },
    }),
    FIXED_NOW,
  );

  test('reason is "needs_auth"', () => assert.equal(status.reason, 'needs_auth'));
  test('available is false', () => assert.equal(status.available, false));
  test('needsAuth is true', () => assert.equal(status.needsAuth, true));
  test('expiresAt is null', () => assert.equal(status.expiresAt, null));
});

describe('computeCodexAvailability — terminal failure/cancellation state', () => {
  for (const terminal of ['failed', 'cancelled', 'complete'] as const) {
    const status = computeCodexAvailability(
      snapshot({
        loggedIn: false,
        loginSession: { status: terminal },
      }),
      FIXED_NOW,
    );
    test(`loginSession.status=${terminal} → reason needs_auth`, () => {
      assert.equal(status.reason, 'needs_auth');
      assert.equal(status.available, false);
      assert.equal(status.needsAuth, true);
    });
  }
});

// ─── Security: no token-adjacent fields leak through compute ─────────────

describe('computeCodexAvailability — security: no token/path/raw payload leakage', () => {
  // Synthesize the worst-case snapshot a future refactor might pass in:
  // include sentinels in every snapshot field — INCLUDING fields like
  // authPath that were removed from the snapshot type in Slice 3B-0 —
  // then assert none of them appear in the computed status. The cast is
  // intentional: even with the type guarantee, the runtime check is a
  // defense-in-depth assertion that catches a regression that re-widens
  // the snapshot shape.
  const dirtySnapshot = {
    loggedIn: true,
    expiresAt: FIXED_NOW + 60 * 60_000,
    refreshable: true,
    authPath: '/home/user/byte-light/data/codex-auth.json',
    loginSession: {
      status: 'awaiting_browser',
      url: 'https://chatgpt.com/oauth?code=oauth-code-deadbeef',
      error: 'access-token-leaked-into-error',
      startedAt: FIXED_NOW,
    },
  } as unknown as CodexAuthSnapshot;

  const status = computeCodexAvailability(dirtySnapshot, FIXED_NOW);

  test('no access-token sentinel in output', () =>
    assertNoTokenSentinels(status, 'computeCodexAvailability'));

  test('no authPath in output keys', () => {
    assert.ok(!('authPath' in status), 'authPath must never appear in availability status');
  });

  test('no loginSession in output keys', () => {
    assert.ok(!('loginSession' in status),
      'loginSession contains url/error fields that may carry oauth codes — must not pass through');
  });

  test('output keys are exactly the declared availability fields', () => {
    const allowed = new Set([
      'provider', 'runtime', 'available', 'connected', 'needsAuth',
      'reason', 'expiresAt', 'refreshable',
    ]);
    for (const key of Object.keys(status)) {
      assert.ok(allowed.has(key), `unexpected key in availability status: "${key}"`);
    }
  });
});

// ─── buildCodexCatalogEntries — pure catalog helper ──────────────────────
//
// Pure function; no I/O, no config dependency. Mirrors the
// computeCodexAvailability pattern so both halves of Slice 2 are testable
// without spinning up an express router.

describe('buildCodexCatalogEntries — Codex catalog exposure', () => {
  const entries = buildCodexCatalogEntries();
  const ids = entries.map((m) => m.id).sort();

  test('returns the Codex catalog (7 entries)', () => {
    assert.equal(entries.length, 7, `expected 7 Codex catalog rows, got ${entries.length}`);
  });

  test('contains every expected Codex model id', () => {
    // Sorted (ids is `.sort()`ed above) — mirrors pi-ai 0.80.6 openai-codex registry.
    assert.deepEqual(ids, [
      'gpt-5.3-codex-spark',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.5',
      'gpt-5.6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
    ]);
  });

  test('every entry declares provider="openai-codex" + runtime="codex"', () => {
    for (const entry of entries) {
      assert.equal(entry.provider, 'openai-codex', `${entry.id} provider drift`);
      assert.equal(entry.runtime, 'codex', `${entry.id} runtime drift`);
    }
  });

  test('every entry has canonical ref "openai-codex/<id>"', () => {
    for (const entry of entries) {
      assert.equal(entry.ref, `openai-codex/${entry.id}`, `${entry.id} ref drift`);
    }
  });

  test('every entry is tier="included" (ChatGPT subscription-backed)', () => {
    for (const entry of entries) {
      assert.equal(entry.tier, 'included', `${entry.id} should be tier=included`);
    }
  });

  test('gpt-5-nano is absent from the Codex catalog', () => {
    const nano = entries.find((m) => m.id === 'gpt-5-nano');
    assert.equal(nano, undefined,
      'gpt-5-nano must never appear as a Codex catalog entry');
  });

  test('catalog entries carry context_length sourced from pi-ai', () => {
    const gpt55 = entries.find((m) => m.id === 'gpt-5.5');
    assert.ok(gpt55, 'gpt-5.5 should be in the catalog');
    assert.equal(gpt55.context_length, 272000,
      'pi-ai registers gpt-5.5 with contextWindow 272000');
    const spark = entries.find((m) => m.id === 'gpt-5.3-codex-spark');
    assert.ok(spark, 'gpt-5.3-codex-spark should be in the catalog');
    assert.equal(spark.context_length, 128000,
      'pi-ai registers gpt-5.3-codex-spark with contextWindow 128000');
  });
});

describe('buildCodexCatalogEntries — catalog vs availability separation', () => {
  const entries = buildCodexCatalogEntries();

  test('no entry contains availability/selectability fields', () => {
    const forbiddenKeys = new Set([
      'available', 'connected', 'needsAuth', 'reason',
      'expiresAt', 'refreshable',
      'authPath', 'accessToken', 'refreshToken', 'token', 'oauthCode',
      'loginSession', 'snapshot',
    ]);
    for (const entry of entries) {
      for (const key of Object.keys(entry)) {
        assert.ok(!forbiddenKeys.has(key),
          `catalog entry "${entry.id}" leaked forbidden key "${key}" — catalog must be selectability-free`);
      }
    }
  });

  test('no entry contains token/path sentinels (security sweep)', () => {
    assertNoTokenSentinels(entries, 'buildCodexCatalogEntries');
  });

  test('entry key set is exactly the declared ModelInfo catalog fields', () => {
    const allowedKeys = new Set([
      'id', 'name', 'provider', 'runtime', 'tier',
      'context_length', 'supports_tools', 'ref',
      // optional curated metadata (not used by Codex today, but tolerated)
      'description', 'featured', 'sortPriority', 'badge',
    ]);
    for (const entry of entries) {
      for (const key of Object.keys(entry)) {
        assert.ok(allowedKeys.has(key),
          `catalog entry "${entry.id}" has unexpected key "${key}"`);
      }
    }
  });
});
