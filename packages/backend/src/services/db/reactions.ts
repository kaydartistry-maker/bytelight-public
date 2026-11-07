import { getDb } from './init.js';
import { getMessage } from './messages.js';

// Reaction operations
export function addReaction(messageId: string, emoji: string, user: 'companion' | 'user'): void {
  const msg = getMessage(messageId);
  if (!msg) return;

  const metadata = (msg.metadata && typeof msg.metadata === 'object') ? { ...msg.metadata } : {};
  const reactions: Array<{ emoji: string; user: string; created_at: string }> = Array.isArray(metadata.reactions) ? [...metadata.reactions] : [];

  // Deduplicate: same user + same emoji = no-op
  if (reactions.some(r => r.emoji === emoji && r.user === user)) return;

  reactions.push({ emoji, user, created_at: new Date().toISOString() });
  metadata.reactions = reactions;

  const stmt = getDb().prepare('UPDATE messages SET metadata = ? WHERE id = ?');
  stmt.run(JSON.stringify(metadata), messageId);
}

export function removeReaction(messageId: string, emoji: string, user: 'companion' | 'user'): void {
  const msg = getMessage(messageId);
  if (!msg) return;

  const metadata = (msg.metadata && typeof msg.metadata === 'object') ? { ...msg.metadata } : {};
  const reactions: Array<{ emoji: string; user: string; created_at: string }> = Array.isArray(metadata.reactions) ? [...metadata.reactions] : [];

  const filtered = reactions.filter(r => !(r.emoji === emoji && r.user === user));
  if (filtered.length === reactions.length) return; // Nothing to remove

  metadata.reactions = filtered;

  const stmt = getDb().prepare('UPDATE messages SET metadata = ? WHERE id = ?');
  stmt.run(JSON.stringify(metadata), messageId);
}
