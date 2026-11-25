/**
 * The house's own brain id (Phase 1.2).
 *
 * Every companion row carries a `brain`. The brain this backend runs turns for
 * is the "local" brain; any other brain seated in a thread is a remote node
 * reached over the Living Room bridge. Before Phase 1 this was a constant in
 * agent.ts. It is now configuration, read in this order:
 *
 *   1. env BYTELIGHT_LOCAL_BRAIN_ID
 *   2. bytelight.yaml `identity.local_brain_id`
 *   3. DEFAULT_LOCAL_BRAIN_ID
 *
 * The default is the id existing houses were built around, so a house with no
 * new config keeps resolving every override, author stamp and dispatch exactly
 * as before. Read per call (cheap) so a config reload is honored.
 */
import { getBytelightConfig } from '../config.js';

export const DEFAULT_LOCAL_BRAIN_ID = 'companion-a-b';

export function getLocalBrainId(): string {
  const fromEnv = process.env.BYTELIGHT_LOCAL_BRAIN_ID?.trim();
  if (fromEnv) return fromEnv;
  try {
    const configured = (getBytelightConfig().identity as { local_brain_id?: unknown }).local_brain_id;
    if (typeof configured === 'string' && configured.trim()) return configured.trim();
  } catch {
    // Config not loaded (unit tests, early boot) — the default stands.
  }
  return DEFAULT_LOCAL_BRAIN_ID;
}

/** True when `brain` is the brain this backend runs turns for. */
export function isLocalBrain(brain: string | null | undefined): boolean {
  return !!brain && brain === getLocalBrainId();
}
