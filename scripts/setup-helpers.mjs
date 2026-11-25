// Pure helpers for the setup wizard (scripts/setup.mjs), kept apart so they
// can be tested without a terminal.

/** True when `tz` is a time zone this machine's Intl knows (e.g. "America/New_York"). */
export function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

/**
 * The machine's own zone, or null when it can't be trusted as the person's.
 * Cloud VMs almost always report UTC, which is nobody's real clock, so UTC
 * counts as "unknown" and the wizard asks instead of guessing.
 */
export function trustedDetectedTimezone(detected) {
  if (!isValidTimezone(detected)) return null;
  const tz = detected.trim();
  if (tz === 'UTC' || tz === 'Etc/UTC' || tz === 'Etc/Universal' || tz === 'Universal' || tz === 'Zulu') return null;
  return tz;
}

/**
 * A house name turned into a pm2 process name: lowercase letters, digits and
 * single dashes. Two houses on one machine need different names, or pm2 treats
 * them as the same app.
 */
export function processNameFor(houseName) {
  const slug = String(houseName ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'bytelight';
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names) {
  const list = names.filter(Boolean);
  if (list.length <= 1) return list[0] ?? '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}
