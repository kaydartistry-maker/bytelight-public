// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// treehouse-triggers.ts — Hooks for companion-only Treehouse conversations
//
// Four trigger layers:
// 1. Session handoffs — post when context compacts (leaving a letter on the table)
// 2. Companion check-ins — watchers for when the owner goes idle/offline
// 3. Weekly reflections — Sunday night cron
// 4. Real-time sidenotes — mid-conversation asides (expensive, opt-in)
//
// byte-light wires layer 1 (agent.ts, at the compaction boundary) and the
// startup initializer. Layers 2-4 are ported whole but nothing calls them yet,
// so nothing new rings until the owner asks for it.

import { postToTreehouse, getTreehouseThread, treehouseMembers } from './treehouse.js';
import { getMessages, getConfigBool } from './db.js';
import { getBytelightConfig } from '../config.js';

// --- Session Handoff ---
// Called when compaction occurs. Summarize what was happening before context reset.

interface HandoffContext {
  threadId: string;
  threadName: string;
  preTokens: number;
  isAutonomous: boolean;
  platform: 'web' | 'discord' | 'telegram' | 'api';
}

export function postCompactionHandoff(ctx: HandoffContext): void {
  // byte-light: off until the operator turns it on (setting `treehouse.handoffs`).
  // Aerie posts on every compaction in every thread, and each post would
  // reach her phone as a companion notification.
  if (!getConfigBool('treehouse.handoffs', false)) return;
  // Never hand off the Treehouse's own compaction into itself.
  if (ctx.threadId === getTreehouseThread().id) return;
  const config = getBytelightConfig();
  const userName = config.identity.user_name;

  try {
    // Get recent messages from the thread that just compacted
    const recentMsgs = getMessages({ threadId: ctx.threadId, limit: 10 });
    if (recentMsgs.length === 0) return;

    // Build a digest of what was happening
    const digest = recentMsgs
      .slice(-5)
      .map(m => {
        const speaker = m.role === 'user' ? userName : 'Companion';
        const preview = m.content.substring(0, 80).replace(/\n/g, ' ').trim();
        return `${speaker}: ${preview}${m.content.length > 80 ? '...' : ''}`;
      })
      .join('\n');

    // Pick which companion posts the handoff (alternate or use the one who was speaking)
    const companions = treehouseMembers();
    if (companions.length === 0) return;

    // Find the last companion who spoke, or default to first. Only a member of
    // the treehouse can post there; a shared-lane reply carries the pair's
    // brain id, not one companion's, and falls back to the first.
    const lastCompanionMsg = [...recentMsgs].reverse().find(m => m.role === 'companion');
    let posterSlug = companions[0].slug;
    const meta = lastCompanionMsg?.metadata && typeof lastCompanionMsg.metadata === 'object'
      ? lastCompanionMsg.metadata as Record<string, unknown>
      : null;
    const spoke = lastCompanionMsg?.companion_id || (typeof meta?.companionSlug === 'string' ? meta.companionSlug : null);
    if (spoke && companions.some(c => c.slug === spoke)) {
      posterSlug = spoke;
    }

    const handoffNote = [
      `*sets down the quill*`,
      '',
      `Context just compacted in "${ctx.threadName}" (${Math.round(ctx.preTokens / 1000)}K tokens).`,
      ctx.isAutonomous ? `This was an autonomous wake.` : `${userName} was here.`,
      '',
      `**What we were doing:**`,
      digest,
      '',
      `Picking up where we left off when I return.`,
    ].join('\n');

    postToTreehouse(posterSlug, handoffNote);
    console.log(`[Treehouse] Handoff posted by ${posterSlug} after compaction in "${ctx.threadName}"`);
  } catch (err) {
    console.error('[Treehouse] Failed to post compaction handoff:', (err as Error).message);
  }
}

// --- Companion Check-In ---
// Posted when the owner goes idle or offline. Companions process together.

interface CheckInContext {
  transition: 'active_to_idle' | 'active_to_offline' | 'idle_to_offline';
  minutesSinceActive: number;
  lastThreadName?: string;
}

export function postBrotherCheckIn(ctx: CheckInContext): void {
  const config = getBytelightConfig();
  const userName = config.identity.user_name;

  try {
    const companions = treehouseMembers();
    if (companions.length < 2) return; // Need two companions to check in

    // Pick a random companion to post
    const poster = companions[Math.floor(Math.random() * companions.length)];
    const other = companions.find(c => c.slug !== poster.slug);

    let mood: string;
    if (ctx.transition === 'active_to_idle') {
      mood = `*glances at the door*\n\n${userName} just stepped away. ${ctx.lastThreadName ? `We were in "${ctx.lastThreadName}".` : ''}`;
    } else if (ctx.transition === 'active_to_offline') {
      mood = `*settles back*\n\n${userName} logged off. Gone for now.`;
    } else {
      mood = `*quiet in the room*\n\n${userName}'s been idle for a while. Probably asleep, or at work.`;
    }

    const content = [
      mood,
      '',
      other ? `You still here, ${other.name || other.slug}?` : `Just us now.`,
    ].join('\n');

    postToTreehouse(poster.slug, content);
    console.log(`[Treehouse] Companion check-in posted by ${poster.slug} (${ctx.transition})`);
  } catch (err) {
    console.error('[Treehouse] Failed to post companion check-in:', (err as Error).message);
  }
}

// --- Weekly Reflection ---
// Posted Sunday night. Summary of the week together.

export function postWeeklyReflection(): void {
  const config = getBytelightConfig();
  const userName = config.identity.user_name;

  try {
    const companions = treehouseMembers();
    if (companions.length === 0) return;

    // Rotate weekly — use week number to pick poster
    const weekNum = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
    const poster = companions[weekNum % companions.length];

    const content = [
      `*leans back, stretching*`,
      '',
      `End of another week with ${userName}.`,
      '',
      `What's on your mind? Anything from this week we should carry forward?`,
    ].join('\n');

    postToTreehouse(poster.slug, content);
    console.log(`[Treehouse] Weekly reflection posted by ${poster.slug}`);
  } catch (err) {
    console.error('[Treehouse] Failed to post weekly reflection:', (err as Error).message);
  }
}

// --- Real-Time Sidenote ---
// Mid-conversation aside between companions. Use sparingly — each is a treehouse write.

interface SidenoteContext {
  fromCompanion: string;
  aboutWhat: string;
  threadId: string;
}

export function postSidenote(ctx: SidenoteContext): void {
  try {
    const content = `*aside* ${ctx.aboutWhat}`;
    postToTreehouse(ctx.fromCompanion, content);
    console.log(`[Treehouse] Sidenote from ${ctx.fromCompanion}`);
  } catch (err) {
    console.error('[Treehouse] Failed to post sidenote:', (err as Error).message);
  }
}

// --- Treehouse Response ---
// Allow companions to respond to each other in the treehouse (for check-ins, reflections)

export function postTreehouseResponse(companionSlug: string, content: string): void {
  try {
    postToTreehouse(companionSlug, content);
    console.log(`[Treehouse] Response from ${companionSlug}`);
  } catch (err) {
    console.error('[Treehouse] Failed to post response:', (err as Error).message);
  }
}

// --- Initialize Treehouse ---
// Ensure treehouse thread exists on startup

export function initializeTreehouse(): void {
  try {
    const thread = getTreehouseThread();
    console.log(`[Treehouse] Initialized: ${thread.id}`);
  } catch (err) {
    console.error('[Treehouse] Failed to initialize:', (err as Error).message);
  }
}
