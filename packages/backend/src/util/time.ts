// Shared date helpers pinned to the companion's configured timezone.
import { getBytelightConfig } from '../config.js';

/** Today's date as YYYY-MM-DD in the configured identity timezone. */
export function today(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: getBytelightConfig().identity.timezone });
}
