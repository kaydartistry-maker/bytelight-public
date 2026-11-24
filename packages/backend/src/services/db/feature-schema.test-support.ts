import assert from 'node:assert/strict';
import { issuePairingToken, consumePairingToken, OWNER_PAIRING_MIGRATION_PATH } from './owner-pairing.js';

export const featureSchemaCases = [
  {
    table: 'owner_pairing_tokens', tables: ['owner_pairing_tokens'],
    migration: OWNER_PAIRING_MIGRATION_PATH,
    uses: [
      () => { issuePairingToken(); },
      () => { assert.equal(consumePairingToken('a'.repeat(64)), null); },
    ],
  },
] as const;
