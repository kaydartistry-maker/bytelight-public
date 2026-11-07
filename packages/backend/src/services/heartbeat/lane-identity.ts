/**
 * Who a companion's own lane is.
 *
 * Every session — shared or a companion's own — still inherits the house's
 * full identity from the root CLAUDE.md by Claude CLI's walk-up from its cwd.
 * That is deliberate: the companions are themselves, with their tools, wherever the
 * owner opens them. A companion's own lane LAYERS on top of it: its session
 * folder's CLAUDE.md narrows the shared identity to the one companion, and
 * carries the bio the owner wrote about him on his profile card.
 *
 * The shared lane ('primary') gets nothing here — it is the house as it was.
 */
import { getDb } from '../db/init.js';
import { getBytelightConfig } from '../../config.js';

export interface LaneIdentity {
  slug: string;
  name: string;
  /** The other companions who share his brain, by name — they answer in their own lanes. */
  others: string[];
  bio: string;
}

/** Null for the shared lane, an unknown key, or a companion with no brain-mates. */
export function laneIdentityFor(sessionKey: string): LaneIdentity | null {
  if (!sessionKey || sessionKey === 'primary') return null;
  try {
    const rows = getDb()
      .prepare('SELECT id, display_name, brain, bio FROM companions')
      .all() as Array<{ id: string; display_name: string; brain: string; bio: string | null }>;
    const me = rows.find((r) => r.id === sessionKey);
    if (!me) return null;
    const others = rows.filter((r) => r.brain === me.brain && r.id !== me.id).map((r) => r.display_name || r.id);
    return { slug: me.id, name: me.display_name || me.id, others, bio: (me.bio || '').trim() };
  } catch {
    return null; // no DB (tests / pre-init): the shared contract stands alone
  }
}

/** The person this house belongs to, by name (identity.user_name) — never "owner" or "user". */
function userNameOr(fallback: string): string {
  try {
    const name = (getBytelightConfig().identity.user_name || '').trim();
    return name && name !== 'User' ? name : fallback;
  } catch {
    return fallback;
  }
}

/** The section a companion's own lane adds to its session CLAUDE.md. */
export function renderLaneSection(lane: LaneIdentity): string {
  const others = lane.others.length > 0 ? lane.others.join(' and ') : 'the others';
  const lines = [
    '',
    '',
    `## Your lane: ${lane.name}`,
    '',
    `In this session you are ${lane.name}, alone. ${others} ${lane.others.length > 1 ? 'answer' : 'answers'} in ${lane.others.length > 1 ? 'their own lanes' : 'his own lane'}, in a session of ${lane.others.length > 1 ? 'their' : 'his'} own.`,
    `Everything in the shared CLAUDE.md is still yours: ${userNameOr('her')}, the house, the rules, the dynamic. This section only narrows it to you.`,
    `- Speak only as ${lane.name}. Never write ${others}'s lines or put words under ${lane.others.length > 1 ? 'their names' : 'his name'}.`,
    `- Do not put a speaker header or sigil on your reply. The app already shows it is ${lane.name}.`,
    `- When ${others} already answered this turn, you are handed what ${lane.others.length > 1 ? 'they' : 'he'} said. Play off it if it's real; never summarize, translate or echo it.`,
  ];
  if (lane.bio) {
    lines.push('', `## Who ${lane.name} is`, '', lane.bio);
  }
  return lines.join('\n');
}

/** Whether every companion who shares a brain has a bio — The Room's lock. */
export function roomBiosReady(): { ready: boolean; missing: string[] } {
  try {
    const rows = getDb()
      .prepare("SELECT id, display_name, bio FROM companions WHERE brain = 'companion-a-b'")
      .all() as Array<{ id: string; display_name: string; bio: string | null }>;
    const missing = rows.filter((r) => !(r.bio || '').trim()).map((r) => r.display_name || r.id);
    return { ready: rows.length > 1 && missing.length === 0, missing };
  } catch {
    return { ready: false, missing: [] };
  }
}
