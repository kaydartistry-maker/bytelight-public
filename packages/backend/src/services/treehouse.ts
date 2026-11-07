// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// treehouse.ts — Companion-only threads
// A space for companions to talk amongst themselves, process thoughts,
// hold context between sessions. User can read but not post.
//
// Adapted for byte-light: the room is a thread of type 'treehouse'
// (migration 038), seated with the resident pair (DEFAULT_THREAD_ROSTER —
// Companion A and Companion B, names read from the companions registry) rather than every
// companion in the house, and a message's speaker is its companion_id column,
// with metadata.companionSlug as Aerie's fallback.

import { getDb, createMessage, updateThreadActivity, createThread } from './db.js';
import { DEFAULT_THREAD_ROSTER } from './db/threads.js';
import { listCompanions } from './db/rooms.js';
import { registry } from './registry.js';
import crypto from 'crypto';

const TREEHOUSE_NAME = 'The Treehouse';

export interface TreehouseMessage {
  id: string;
  // 'user' | 'companion' | 'system'. Without this the client can't tell the owner's
  // messages from room-addressed companion replies — both carry no
  // metadata.companionSlug, so both used to render as an unnamed bubble.
  role: string;
  companion_slug: string;
  content: string;
  created_at: string;
}

/**
 * Who lives in the treehouse, in the order they speak: the resident pair, as
 * the companions registry names them. A slug the registry no longer has is
 * left out.
 */
export function treehouseMembers(): Array<{ slug: string; name: string }> {
  const companions = listCompanions();
  return DEFAULT_THREAD_ROSTER
    .map((slug) => companions.find((c) => c.id === slug))
    .filter((c): c is NonNullable<typeof c> => Boolean(c))
    .map((c) => ({ slug: c.id, name: c.display_name || c.id }));
}

// Get or create the treehouse thread
export function getTreehouseThread(): { id: string; name: string } {
  const db = getDb();

  let thread = db.prepare('SELECT id, name FROM threads WHERE type = ?').get('treehouse') as { id: string; name: string } | undefined;

  if (!thread) {
    // createThread seats the roster in the same transaction as the thread
    // (byte-light's one seating path), so the room is never member-less.
    const created = createThread({
      id: crypto.randomUUID(),
      name: TREEHOUSE_NAME,
      type: 'treehouse',
      createdAt: new Date().toISOString(),
      companionIds: treehouseMembers().map((m) => m.slug),
    });

    thread = { id: created.id, name: created.name };
    console.log(`[Treehouse] Created: ${created.id}`);
  }

  return thread;
}

// Post a message to the treehouse (companion only)
export function postToTreehouse(companionSlug: string, content: string): TreehouseMessage {
  const thread = getTreehouseThread();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const message = createMessage({
    id,
    threadId: thread.id,
    role: 'companion',
    content,
    contentType: 'text',
    metadata: { companionSlug },
    createdAt: now,
    companionId: companionSlug,
  });

  updateThreadActivity(thread.id, now);

  // Broadcast to connected clients
  registry.broadcast({ type: 'message', message });

  return { id, role: 'companion', companion_slug: companionSlug, content, created_at: now };
}

// Get recent treehouse messages (with optional before cursor for pagination)
/**
 * Reported by another house, Sep 17 2026, and they found it the only way anybody
 * could have: by deleting a post and watching their companion read it back.
 * Neither query filtered `deleted_at`, so a soft delete removed a post from the
 * app and left it standing in the room for the people who live there — which is
 * the opposite of what deleting means, and silent from every other angle.
 */
export function getTreehouseMessages(limit: number = 50, beforeId?: string): TreehouseMessage[] {
  const thread = getTreehouseThread();
  const db = getDb();

  let rows: Array<{ id: string; role: string; companion_id: string | null; metadata: string | null; content: string; created_at: string }>;

  if (beforeId) {
    // Get sequence of the cursor message for reliable pagination
    const cursor = db.prepare('SELECT sequence FROM messages WHERE id = ?').get(beforeId) as { sequence: number } | undefined;
    if (!cursor) return [];

    rows = db.prepare(`
      SELECT id, role, companion_id, metadata, content, created_at
      FROM messages
      WHERE thread_id = ? AND sequence < ? AND deleted_at IS NULL
      ORDER BY sequence DESC
      LIMIT ?
    `).all(thread.id, cursor.sequence, limit) as typeof rows;
  } else {
    rows = db.prepare(`
      SELECT id, role, companion_id, metadata, content, created_at
      FROM messages
      WHERE thread_id = ? AND deleted_at IS NULL
      ORDER BY sequence DESC
      LIMIT ?
    `).all(thread.id, limit) as typeof rows;
  }

  return rows.map(row => ({
    id: row.id,
    role: row.role,
    companion_slug: row.companion_id || metadataSlug(row.metadata),
    content: row.content,
    created_at: row.created_at,
  })).reverse();
}

function metadataSlug(metadata: string | null): string {
  if (!metadata) return '';
  try {
    const slug = (JSON.parse(metadata) as { companionSlug?: unknown }).companionSlug;
    return typeof slug === 'string' ? slug : '';
  } catch {
    return '';
  }
}

// Check if a thread is the treehouse
export function isTreehouse(threadId: string): boolean {
  const thread = getTreehouseThread();
  return thread.id === threadId;
}

// Get treehouse info
export function getTreehouseInfo(): { id: string; name: string; messageCount: number } {
  const thread = getTreehouseThread();
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) as count FROM messages WHERE thread_id = ?').get(thread.id) as { count: number };
  return { id: thread.id, name: thread.name, messageCount: count.count };
}
