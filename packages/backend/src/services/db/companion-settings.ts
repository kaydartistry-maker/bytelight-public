/**
 * Per-companion (provider, model, thinking_effort) overrides.
 *
 * Backs the resolver in services/companion-resolver.ts. Schema lives in
 * migrations/007_companion_settings.sql. companion_id is a string identifier
 * validated at the service layer — byte-light has NO `companions` table, so
 * the FK is to threads(id) only (for thread-scope rows).
 *
 * Style matches byte-light's existing flat-service pattern in services/db.ts:
 * prepared statements per call (better-sqlite3 caches them internally), plain
 * row → typed object casts at the boundary. No transaction wrappers in P0 —
 * single-row writes are atomic in SQLite.
 */

import type { ProviderId, TierHint } from '@bytelight/shared';
import type { ThinkingEffort } from '@bytelight/shared';
import { getDb } from './init.js';

export type CompanionSettingsScope = 'system' | 'companion' | 'thread';

/** Row shape as stored in the `companion_settings` table. */
export interface CompanionSettingsRow {
  companion_id: string;
  tier: TierHint;
  provider_id: ProviderId;
  model_id: string;
  thinking_effort: ThinkingEffort | null;
  is_default: number;
  scope: CompanionSettingsScope;
  thread_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Lookup key for a single resolver-style read. */
export interface CompanionSettingsKey {
  companionId: string;
  tier: TierHint;
  scope: CompanionSettingsScope;
  /** Required when scope='thread', ignored otherwise. */
  threadId?: string | null;
}

/**
 * Validate companion_id at the service layer. Today this is purely a
 * non-empty / printable check — there's no `companions` table to FK
 * against. If/when byte-light grows one, replace with an existence check.
 */
function assertCompanionId(companionId: string): void {
  if (typeof companionId !== 'string' || companionId.trim().length === 0) {
    throw new Error('companion_settings: companionId must be a non-empty string');
  }
}

/**
 * Single-row lookup for the resolver. Returns null on miss. Thread-scope
 * reads require a threadId; passing scope='thread' with no threadId is a
 * usage error.
 */
export function getCompanionSetting(key: CompanionSettingsKey): CompanionSettingsRow | null {
  assertCompanionId(key.companionId);
  if (key.scope === 'thread' && !key.threadId) {
    throw new Error('companion_settings: scope=thread requires a threadId');
  }

  const threadId = key.scope === 'thread' ? key.threadId! : null;
  const stmt = getDb().prepare(`
    SELECT companion_id, tier, provider_id, model_id, thinking_effort,
           is_default, scope, thread_id, created_at, updated_at
    FROM companion_settings
    WHERE companion_id = ? AND tier = ? AND scope = ?
      AND (
        (? IS NULL AND thread_id IS NULL)
        OR (? IS NOT NULL AND thread_id = ?)
      )
    LIMIT 1
  `);
  const row = stmt.get(key.companionId, key.tier, key.scope, threadId, threadId, threadId);
  return row ? (row as unknown as CompanionSettingsRow) : null;
}

/** Parameters for upsert. `threadId` required iff scope='thread'. */
export interface UpsertCompanionSettingParams {
  companionId: string;
  tier: TierHint;
  providerId: ProviderId;
  modelId: string;
  thinkingEffort?: ThinkingEffort | null;
  isDefault?: boolean;
  scope: CompanionSettingsScope;
  threadId?: string | null;
}

/**
 * Insert-or-update by the unique scope key (companion_id, tier, scope,
 * COALESCE(thread_id, '')). Uses ON CONFLICT to keep semantics atomic.
 */
export function upsertCompanionSetting(params: UpsertCompanionSettingParams): CompanionSettingsRow {
  assertCompanionId(params.companionId);
  if (params.scope === 'thread' && !params.threadId) {
    throw new Error('companion_settings: scope=thread requires a threadId');
  }
  if (params.scope !== 'thread' && params.threadId) {
    throw new Error(`companion_settings: scope=${params.scope} must not set threadId`);
  }

  const now = new Date().toISOString();
  const threadId = params.threadId ?? null;
  const isDefault = params.isDefault ? 1 : 0;
  const effort = params.thinkingEffort ?? null;

  // ON CONFLICT clause references the unique index's expression
  // (companion_id, tier, scope, COALESCE(thread_id, '')) — SQLite matches
  // by the same expression list.
  const stmt = getDb().prepare(`
    INSERT INTO companion_settings (
      companion_id, tier, provider_id, model_id, thinking_effort,
      is_default, scope, thread_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(companion_id, tier, scope, COALESCE(thread_id, '')) DO UPDATE SET
      provider_id     = excluded.provider_id,
      model_id        = excluded.model_id,
      thinking_effort = excluded.thinking_effort,
      is_default      = excluded.is_default,
      updated_at      = excluded.updated_at
  `);
  stmt.run(
    params.companionId,
    params.tier,
    params.providerId,
    params.modelId,
    effort,
    isDefault,
    params.scope,
    threadId,
    now,
    now,
  );

  const fetched = getCompanionSetting({
    companionId: params.companionId,
    tier: params.tier,
    scope: params.scope,
    threadId,
  });
  if (!fetched) {
    throw new Error('companion_settings: upsert succeeded but row not found on re-read');
  }
  return fetched;
}

/** Delete by primary scope key. Returns true if a row was removed. */
export function deleteCompanionSetting(key: CompanionSettingsKey): boolean {
  assertCompanionId(key.companionId);
  if (key.scope === 'thread' && !key.threadId) {
    throw new Error('companion_settings: scope=thread requires a threadId');
  }

  const threadId = key.scope === 'thread' ? key.threadId! : null;
  const stmt = getDb().prepare(`
    DELETE FROM companion_settings
    WHERE companion_id = ? AND tier = ? AND scope = ?
      AND (
        (? IS NULL AND thread_id IS NULL)
        OR (? IS NOT NULL AND thread_id = ?)
      )
  `);
  const result = stmt.run(key.companionId, key.tier, key.scope, threadId, threadId, threadId);
  return result.changes > 0;
}
