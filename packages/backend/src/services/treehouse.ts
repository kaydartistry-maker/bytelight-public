// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// treehouse.ts — Companion-only threads
// A space for companions to talk amongst themselves, process thoughts,
// hold context between sessions. User can read but not post.
//
// Adapted for byte-light: the room is a thread of type 'treehouse'.

import { getDb, createMessage, updateThreadActivity, createThread } from './db.js';
import { requireThreadRoster } from './db/threads.js';
import { residents } from './residents.js';
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

// Members are this house's residents only. A visitor from another node (a
// companion row on a different brain) can sit in shared rooms, but never gets
// a Treehouse seat, a Treehouse bell, or the right to post here.
export function treehouseMembers(): Array<{ slug: string; name: string }> {
  return residents().map((resident) => ({ slug: resident.id, name: resident.name }));
}

// Get or create the treehouse thread
export function getTreehouseThread(): { id: string; name: string } {
  const db = getDb();

  let thread = db.prepare('SELECT id, name FROM threads WHERE type = ?').get('treehouse') as { id: string; name: string } | undefined;

  if (!thread) {
    const members = treehouseMembers();
    if (members.length === 0) {
      throw new Error('The Treehouse needs at least one resident.');
    }
    const created = createThread({
      id: crypto.randomUUID(),
      name: TREEHOUSE_NAME,
      type: 'treehouse',
      createdAt: new Date().toISOString(),
      companionIds: requireThreadRoster(members.map((member) => member.slug)),
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
