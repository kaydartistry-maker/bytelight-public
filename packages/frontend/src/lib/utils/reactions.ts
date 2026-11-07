export interface Reaction { emoji: string; user: string; created_at: string }
export interface ReactionGroup { emoji: string; count: number; users: string[] }

/** Collapse raw reactions into one chip per emoji, in first-seen order. */
export function groupReactions(reactions: Reaction[]): ReactionGroup[] {
  const map = new Map<string, ReactionGroup>();
  for (const r of reactions) {
    const entry = map.get(r.emoji);
    if (entry) {
      entry.count++;
      entry.users.push(r.user);
    } else {
      map.set(r.emoji, { emoji: r.emoji, count: 1, users: [r.user] });
    }
  }
  return Array.from(map.values());
}
