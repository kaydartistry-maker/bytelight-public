import type { NormalizedMessage } from './types.js';

/**
 * Pull the newest user turn's text from byte-light's `input.messages`.
 * Warm lanes (heartbeat CLI, codex daemon) already hold prior context, so
 * they send only this; older turns travel through each lane's recovery seed.
 */
export function extractLatestUserPrompt(messages: NormalizedMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && typeof m.content === 'string') {
      return m.content;
    }
  }
  return '';
}
