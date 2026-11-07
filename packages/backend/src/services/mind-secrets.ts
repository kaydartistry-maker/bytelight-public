import { getSecret } from './secrets.js';

// Mind Bridge endpoint + key, resolved per call through the BYOK secrets
// store (DB -> env), so a value saved via /api/secrets applies without restart.
export const mindUrl = (): string => getSecret('mind_api_url') || '';
export const mindKey = (): string => getSecret('mind_api_key') || '';
