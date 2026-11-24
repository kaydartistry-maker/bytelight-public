// memory-blocks.ts — Letta-style in-place memory editing
// Companion-scoped labeled blocks the agents can view and modify during conversation.
// scope = a companion slug ('companion-a', 'companion-b') or 'shared' (visible to all companions)
//
// Ported from the reference implementation fork, Apache 2.0 — adapted for byte-light.
// Adaptations vs. reference implementation:
//   (a) DDL ownership moved to migrations/013_memory.sql (byte-light's canonical
//       numbered-migration pattern). initMemoryBlocks drops reference implementation's legacy
//       label-only self-migration (greenfield here) and stays exported as a
//       belt-and-braces CREATE TABLE IF NOT EXISTS no-op so later slices port
//       cleanly against the same surface.
//   (b) Companion scopes come from a module constant COMPANION_SCOPES instead of
//       a db/companions module byte-light doesn't have. Valid scope = 'shared' |
//       'companion-a' | 'companion-b'. resolveScope / validScopesHint / ensureCompanionBlocks
//       adapted accordingly.
//   (c) seedDefaultBlocks defaults mirror reference implementation's structure for THIS house
//       (user "the operator", companions Companion A and Companion B).

import { getDb } from './db.js';
import { memoryReceipt } from './memory-ledger.js';
import { randomUUID } from 'node:crypto';
import { renderSelfKnowledgeForPrompt } from './self-knowledge-carry.js';

export const SHARED_SCOPE = 'shared';

// Companion slugs for this house. Memory-block scopes are 'shared' plus these.
// (reference implementation derived these from a db/companions module; byte-light has no such
// module, so the set is a static constant here.)
export const COMPANION_SCOPES = ['companion-a', 'companion-b'] as const;
export type CompanionScope = (typeof COMPANION_SCOPES)[number];

/** Whether a block rides into every session in full, or waits on the shelf. */
export type BlockCarry = 'always' | 'on_demand';

export interface MemoryBlock {
  scope: string;
  label: string;
  content: string;
  description?: string;
  updated_at: string;
  /** migrations/053. Absent (a database from before it) reads as 'always'. */
  carry?: BlockCarry;
}

/** True unless the block has been put on the shelf. */
export function isCarried(block: { carry?: string | null }): boolean {
  return block.carry !== 'on_demand';
}

export interface MemoryBlockIdentity {
  id: string;
  scope: string;
  canonical_label: string;
}

export interface MemoryBlockAlias {
  scope: string;
  alias: string;
  block_id: string;
}

const TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS memory_blocks (
    scope TEXT NOT NULL DEFAULT 'shared',
    label TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    description TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (scope, label)
  )
`;

// Belt-and-braces: the table is owned by migrations/013_memory.sql, but keep this
// exported and idempotent so later slices can call it as a no-op guarantee.
export function initMemoryBlocks(): void {
  getDb().exec(TABLE_DDL);
}

// All blocks across every scope (admin / UI)
export function getAllBlocks(): MemoryBlock[] {
  return getDb()
    .prepare('SELECT * FROM memory_blocks ORDER BY scope, label')
    .all() as MemoryBlock[];
}

// The blocks a session is handed in full. The session upkeep that reasons about
// what a room is holding (the launch baseline, drift after a compaction, the
// over-budget nudge) asks for these, never for every block: a shelved block was
// never in the room, so it can neither go stale there nor weigh on it.
export function getCarriedBlocks(): MemoryBlock[] {
  return getAllBlocks().filter(isCarried);
}

// Blocks visible to a set of scopes, in the order the scopes are given
export function getBlocksForScopes(scopes: string[]): MemoryBlock[] {
  if (scopes.length === 0) return [];
  const placeholders = scopes.map(() => '?').join(', ');
  const rows = getDb()
    .prepare(`SELECT * FROM memory_blocks WHERE scope IN (${placeholders}) ORDER BY label`)
    .all(...scopes) as MemoryBlock[];
  rows.sort((a, b) => scopes.indexOf(a.scope) - scopes.indexOf(b.scope) || a.label.localeCompare(b.label));
  return rows;
}

function getBlockExact(scope: string, label: string): MemoryBlock | null {
  return getDb()
    .prepare('SELECT * FROM memory_blocks WHERE scope = ? AND label = ?')
    .get(scope, label) as MemoryBlock | null;
}

// Alias keys are deliberately normalization, not a nickname enum. The table is
// open-ended; this only folds representation differences that cannot carry
// identity (case/spacing/Unicode presentation and HTML-escaped ampersands).
export function normalizeBlockAlias(label: string): string {
  return label
    .normalize('NFKC')
    .replace(/&(?:amp|#38|#x26);/gi, '&')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('en-US');
}

function identityByAlias(scope: string, label: string): MemoryBlockIdentity | null {
  return getDb().prepare(`
    SELECT i.id, i.scope, i.canonical_label
    FROM memory_block_aliases a
    JOIN memory_block_identities i ON i.id = a.block_id
    WHERE a.scope = ? AND a.alias_key = ?
  `).get(scope, normalizeBlockAlias(label)) as MemoryBlockIdentity | null;
}

function identityByCanonicalLabel(scope: string, label: string): MemoryBlockIdentity | null {
  return getDb().prepare(`
    SELECT id, scope, canonical_label
    FROM memory_block_identities
    WHERE scope = ? AND canonical_label = ?
  `).get(scope, label) as MemoryBlockIdentity | null;
}

function insertAlias(identity: MemoryBlockIdentity, alias: string): void {
  const aliasKey = normalizeBlockAlias(alias);
  const existing = getDb().prepare(`
    SELECT block_id FROM memory_block_aliases WHERE scope = ? AND alias_key = ?
  `).get(identity.scope, aliasKey) as { block_id: string } | undefined;
  if (existing && existing.block_id !== identity.id) {
    throw new Error(`Alias '${alias}' already belongs to another block in scope '${identity.scope}'`);
  }
  getDb().prepare(`
    INSERT OR IGNORE INTO memory_block_aliases (scope, alias_key, alias, block_id)
    VALUES (?, ?, ?, ?)
  `).run(identity.scope, aliasKey, alias, identity.id);
}

function ensureIdentity(scope: string, canonicalLabel: string): MemoryBlockIdentity {
  let identity = identityByCanonicalLabel(scope, canonicalLabel);
  if (!identity) {
    getDb().prepare(`
      INSERT INTO memory_block_identities (id, scope, canonical_label)
      VALUES (?, ?, ?)
    `).run(`mb-${randomUUID()}`, scope, canonicalLabel);
    identity = identityByCanonicalLabel(scope, canonicalLabel);
  }
  if (!identity) throw new Error(`Failed to establish identity for '${scope}/${canonicalLabel}'`);
  insertAlias(identity, canonicalLabel);
  return identity;
}

// Resolve through aliases before the caller is allowed to create a block. The
// old lossy rendering is also recognized structurally so a pre-migration ghost
// spelling heals itself into an alias instead of creating another row.
function resolveBlockIdentity(scope: string, label: string, allowCreate: boolean): MemoryBlockIdentity | null {
  const aliased = identityByAlias(scope, label);
  if (aliased) return aliased;

  const candidates = getDb().prepare(`
    SELECT label, description
    FROM memory_blocks
    WHERE scope = ? AND description IS NOT NULL AND description <> ''
  `).all(scope) as Array<{ label: string; description: string }>;
  const recovered = candidates.find((block) => label === `${block.label} — ${block.description}`);
  if (recovered) {
    const identity = ensureIdentity(scope, recovered.label);
    insertAlias(identity, label);
    return identity;
  }

  const exact = getBlockExact(scope, label);
  if (exact) return ensureIdentity(scope, exact.label);

  if (!allowCreate) return null;
  return ensureIdentity(scope, label);
}

export function getBlock(scope: string, label: string): MemoryBlock | null {
  const identity = resolveBlockIdentity(scope, label, false);
  return identity ? getBlockExact(identity.scope, identity.canonical_label) : null;
}

export function addBlockAlias(scope: string, canonicalLabel: string, alias: string): MemoryBlockIdentity {
  if (!alias.trim()) throw new Error('Alias required');
  return getDb().transaction(() => {
    const identity = resolveBlockIdentity(scope, canonicalLabel, false);
    if (!identity) throw new Error(`Block '${canonicalLabel}' not found in scope '${scope}'`);
    insertAlias(identity, alias);
    return identity;
  })();
}

export function getBlockAliases(scope: string, label: string): MemoryBlockAlias[] {
  const identity = resolveBlockIdentity(scope, label, false);
  if (!identity) return [];
  return getDb().prepare(`
    SELECT scope, alias, block_id
    FROM memory_block_aliases
    WHERE block_id = ?
    ORDER BY alias
  `).all(identity.id) as MemoryBlockAlias[];
}

// Who is writing. Optional on every write entry point, so existing callers are
// unaffected; a lane that knows its own name should say so, since the receipt
// row is the only place that attribution survives.
export interface BlockWriteMeta {
  /** Writing lane: 'mcp' | 'cli' | 'api' | 'extraction' | a companion slug. */
  actor?: string;
  /** Anything else worth keeping on the receipt. */
  metadata?: Record<string, unknown>;
}

// What kind of write is about to happen, for the version history.
export type BlockVersionOp = 'set' | 'rethink' | 'replace' | 'insert' | 'delete' | 'restore';

interface WriteWhy {
  op: BlockVersionOp;
  actor?: string;
}

// Keep the block exactly as it stands, before a write that would lose some of
// it (migrations/052). Advisory in the same way a receipt is: a history row
// that cannot be filed is logged loudly and the write still goes through,
// because a memory edit must never fail on its own paper trail.
function keepVersion(before: MemoryBlock, why: WriteWhy): void {
  try {
    getDb()
      .prepare(`
        INSERT INTO memory_block_versions (scope, label, content, description, op, actor, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        before.scope,
        before.label,
        before.content,
        before.description ?? null,
        why.op,
        why.actor || 'house',
        new Date().toISOString(),
      );
  } catch (err) {
    console.warn(
      `[MemoryBlocks] HISTORY NOT KEPT for ${before.scope}/${before.label} before a ${why.op} (the write itself goes ahead):`,
      err,
    );
  }
}

// A write loses nothing when the new text simply continues the old: the old
// text is still there, word for word, at the front.
function losesText(before: string, after: string): boolean {
  return before !== after && !after.startsWith(before);
}

// Raw upsert, no receipt. Every public writer below routes through here and
// then files exactly ONE receipt with its own verb — so a single logical edit
// never lands two rows in the ledger. A writer that can lose text says so with
// `why`, and the text it is about to replace is kept first.
function writeBlock(scope: string, label: string, content: string, description?: string, why?: WriteWhy): void {
  if (why) {
    const before = getBlockExact(scope, label);
    if (before && losesText(before.content, content)) keepVersion(before, why);
  }
  getDb()
    .prepare(`
      INSERT INTO memory_blocks (scope, label, content, description, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(scope, label) DO UPDATE SET
        content = excluded.content,
        description = COALESCE(excluded.description, memory_blocks.description),
        updated_at = datetime('now')
    `)
    .run(scope, label, content, description ?? null);
}

// File a receipt for a write that already succeeded. Fire-and-forget by
// contract: the ledger is a paper trail, and losing a receipt must never cost
// the owner the memory write it describes.
function receipt(
  action: string,
  scope: string,
  label: string,
  detail: string,
  meta?: BlockWriteMeta,
  extra?: Record<string, unknown>,
): void {
  try {
    memoryReceipt({
      actor: meta?.actor || 'house',
      action,
      subjectType: 'memory_block',
      subjectId: `${scope}/${label}`,
      detail,
      metadata: { scope, label, ...extra, ...(meta?.metadata ?? {}) },
    });
  } catch (err) {
    console.warn('[MemoryLedger] receipt failed (write itself succeeded):', err);
  }
}

export function setBlock(
  scope: string,
  label: string,
  content: string,
  description?: string,
  meta?: BlockWriteMeta,
): void {
  const identity = getDb().transaction(() => {
    const resolved = resolveBlockIdentity(scope, label, true)!;
    writeBlock(resolved.scope, resolved.canonical_label, content, description, { op: 'set', actor: meta?.actor });
    return resolved;
  })();
  receipt('memory.set', identity.scope, identity.canonical_label, `Set block to ${content.length} chars.`, meta, {
    block_chars: content.length,
  });
}

export function deleteBlock(scope: string, label: string, meta?: BlockWriteMeta): void {
  const deleted = getDb().transaction(() => {
    const identity = resolveBlockIdentity(scope, label, false);
    if (!identity) return null;
    const before = getBlockExact(identity.scope, identity.canonical_label);
    if (before) keepVersion(before, { op: 'delete', actor: meta?.actor });
    const info = getDb()
      .prepare('DELETE FROM memory_blocks WHERE scope = ? AND label = ?')
      .run(identity.scope, identity.canonical_label);
    if (info.changes === 0) return null;
    getDb().prepare('DELETE FROM memory_block_aliases WHERE block_id = ?').run(identity.id);
    getDb().prepare('DELETE FROM memory_block_identities WHERE id = ?').run(identity.id);
    return identity;
  })();
  if (deleted) receipt('memory.delete', deleted.scope, deleted.canonical_label, 'Deleted the block.', meta);
}

// Move a block between "carried in every session" and "on the shelf". The
// text is untouched, so nothing is kept in the version history and the
// block's updated_at does not move. Returns the block, or null if not found.
export function setBlockCarry(scope: string, label: string, carry: BlockCarry, meta?: BlockWriteMeta): MemoryBlock | null {
  if (carry !== 'always' && carry !== 'on_demand') throw new Error("carry must be 'always' or 'on_demand'");
  const identity = resolveBlockIdentity(scope, label, false);
  const block = identity ? getBlockExact(identity.scope, identity.canonical_label) : null;
  if (!block) return null;
  if ((block.carry ?? 'always') !== carry) {
    getDb()
      .prepare('UPDATE memory_blocks SET carry = ? WHERE scope = ? AND label = ?')
      .run(carry, block.scope, block.label);
    receipt(
      'memory.carry',
      block.scope,
      block.label,
      carry === 'on_demand'
        ? 'Put on the shelf: no longer carried in full, opened when needed.'
        : 'Taken off the shelf: carried in every session again.',
      meta,
      { carry, block_chars: block.content.length },
    );
  }
  return getBlockExact(block.scope, block.label);
}

// Append a line to a block, creating the block if it doesn't exist
export function appendToBlock(scope: string, label: string, content: string, meta?: BlockWriteMeta): string {
  const result = getDb().transaction(() => {
    const identity = resolveBlockIdentity(scope, label, true)!;
    const block = getBlockExact(identity.scope, identity.canonical_label);
    const newContent = block && block.content ? block.content + '\n' + content : content;
    writeBlock(identity.scope, identity.canonical_label, newContent);
    return { identity, newContent, created: !block };
  })();
  receipt('memory.append', result.identity.scope, result.identity.canonical_label, `Appended: ${content}`, meta, {
    added_chars: content.length,
    block_chars: result.newContent.length,
    created: result.created,
  });
  return result.newContent;
}

// Replace exact text in a block (errors when missing or ambiguous)
export function replaceInBlock(scope: string, label: string, oldText: string, newText: string, meta?: BlockWriteMeta): string {
  const identity = resolveBlockIdentity(scope, label, false);
  const block = identity ? getBlockExact(identity.scope, identity.canonical_label) : null;
  if (!block) throw new Error(`Block '${label}' not found in scope '${scope}'`);

  if (!block.content.includes(oldText)) {
    throw new Error(`Text not found in block '${scope}/${label}'`);
  }

  const escaped = oldText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const count = (block.content.match(new RegExp(escaped, 'g')) || []).length;
  if (count > 1) {
    throw new Error(`Multiple occurrences (${count}) found. Use more specific text.`);
  }

  const newContent = block.content.replace(oldText, newText);
  writeBlock(block.scope, block.label, newContent, undefined, { op: 'replace', actor: meta?.actor });
  receipt('memory.replace', block.scope, block.label, `Replaced "${oldText}" with "${newText}"`, meta, {
    block_chars: newContent.length,
  });
  return newContent;
}

// Insert text at a line index (-1 appends)
export function insertInBlock(scope: string, label: string, text: string, line: number = -1, meta?: BlockWriteMeta): string {
  const identity = resolveBlockIdentity(scope, label, true)!;
  const block = getBlockExact(identity.scope, identity.canonical_label);
  const lines = block && block.content ? block.content.split('\n') : [];

  if (line === -1 || line >= lines.length) {
    lines.push(text);
  } else {
    lines.splice(line, 0, text);
  }

  const newContent = lines.join('\n');
  writeBlock(identity.scope, identity.canonical_label, newContent, undefined, { op: 'insert', actor: meta?.actor });
  receipt('memory.insert', identity.scope, identity.canonical_label, `Inserted at line ${line}: ${text}`, meta, {
    line,
    block_chars: newContent.length,
  });
  return newContent;
}

// Rethink — complete rewrite of a block
export function rethinkBlock(scope: string, label: string, newContent: string, meta?: BlockWriteMeta): string {
  const identity = resolveBlockIdentity(scope, label, true)!;
  const block = getBlockExact(identity.scope, identity.canonical_label);
  writeBlock(identity.scope, identity.canonical_label, newContent, undefined, { op: 'rethink', actor: meta?.actor });
  receipt('memory.rethink', identity.scope, identity.canonical_label, `Rewrote the whole block (${newContent.length} chars).`, meta, {
    previous_chars: block?.content.length ?? 0,
    block_chars: newContent.length,
  });
  return newContent;
}

// ─── Version history (migrations/052) ───────────────────────────────

export interface BlockVersion {
  id: number;
  scope: string;
  label: string;
  /** The block as it stood BEFORE the write named by `op`. */
  content: string;
  description: string | null;
  op: BlockVersionOp;
  actor: string;
  created_at: string;
}

/** A history row without its full text, for a list. */
export interface BlockVersionSummary extends Omit<BlockVersion, 'content'> {
  chars: number;
  preview: string;
}

const VERSION_PREVIEW_CHARS = 160;

function summarizeVersion(row: BlockVersion): BlockVersionSummary {
  const { content, ...rest } = row;
  const flat = content.replace(/\s+/g, ' ').trim();
  return {
    ...rest,
    chars: content.length,
    preview: flat.length > VERSION_PREVIEW_CHARS ? flat.slice(0, VERSION_PREVIEW_CHARS).trimEnd() + '…' : flat,
  };
}

// The label history is filed under: the block's real label when it is still
// reachable (so an alias finds the same history), else the label as given (a
// deleted block has no identity left to resolve through).
function historyLabel(scope: string, label: string): string {
  return resolveBlockIdentity(scope, label, false)?.canonical_label ?? label;
}

/** Earlier versions of one block, newest first. */
export function listBlockVersions(scope: string, label: string, limit = 50): BlockVersionSummary[] {
  const rows = getDb()
    .prepare(`SELECT * FROM memory_block_versions WHERE scope = ? AND label = ? ORDER BY id DESC LIMIT ?`)
    .all(scope, historyLabel(scope, label), Math.max(1, Math.min(limit, 500))) as BlockVersion[];
  return rows.map(summarizeVersion);
}

/** One earlier version, with its full text. */
export function getBlockVersion(id: number): BlockVersion | null {
  return (getDb().prepare('SELECT * FROM memory_block_versions WHERE id = ?').get(id) as BlockVersion | undefined) ?? null;
}

/** Blocks that were deleted and have not been made again: the newest row of each. */
export function listDeletedBlocks(): BlockVersionSummary[] {
  const rows = getDb()
    .prepare(`
      SELECT v.* FROM memory_block_versions v
      WHERE v.op = 'delete'
        AND v.id = (SELECT MAX(id) FROM memory_block_versions x WHERE x.scope = v.scope AND x.label = v.label)
        AND NOT EXISTS (SELECT 1 FROM memory_blocks b WHERE b.scope = v.scope AND b.label = v.label)
      ORDER BY v.id DESC
    `)
    .all() as BlockVersion[];
  return rows.map(summarizeVersion);
}

/**
 * Put a block back the way an earlier version had it. The text it has now is
 * kept first, so a restore can itself be undone. A deleted block is made again
 * with the description it had. Returns null when there is no such version.
 */
export function restoreBlockVersion(id: number, meta?: BlockWriteMeta): MemoryBlock | null {
  const version = getBlockVersion(id);
  if (!version) return null;
  const restored = getDb().transaction(() => {
    const identity = resolveBlockIdentity(version.scope, version.label, true)!;
    const existing = getBlockExact(identity.scope, identity.canonical_label);
    writeBlock(
      identity.scope,
      identity.canonical_label,
      version.content,
      existing ? undefined : version.description ?? undefined,
      { op: 'restore', actor: meta?.actor },
    );
    return identity;
  })();
  receipt(
    'memory.restore',
    restored.scope,
    restored.canonical_label,
    `Restored the block to how it stood before the ${version.op} of ${version.created_at} (${version.content.length} chars).`,
    meta,
    { version_id: version.id, block_chars: version.content.length },
  );
  return getBlockExact(restored.scope, restored.canonical_label);
}

const SHELF_DESCRIPTION_CHARS = 180;

// One line per shelved block: enough to know what it holds and how to open it.
//
// Like the self-knowledge section this sits inside the core-memory span AHEAD
// of the first block, under a heading that is not a block heading, so the
// readers that pull blocks back out of a session document skip it
// (heartbeat/block-drift.ts parseInjectedBlocks).
function renderShelfIndex(shelved: MemoryBlock[]): string {
  if (shelved.length === 0) return '';
  let out =
    '## On the shelf\n' +
    'These blocks are yours too, but they are not carried in full: each line below says what one holds. ' +
    'When its subject comes up, open it with core_memory_view (give its scope and label) before you answer from memory. ' +
    'You can append to one without opening it.\n';
  for (const block of shelved) {
    const about = (block.description ?? '').replace(/\s+/g, ' ').trim();
    const shortAbout = about.length > SHELF_DESCRIPTION_CHARS ? about.slice(0, SHELF_DESCRIPTION_CHARS).trimEnd() + '…' : about;
    const day = (block.updated_at ?? '').slice(0, 10);
    out += `- [${block.scope}] ${JSON.stringify(block.label)}${shortAbout ? ` — ${shortAbout}` : ''}`;
    out += ` (${block.content.length} chars${day ? `, updated ${day}` : ''})\n`;
  }
  return out + '\n';
}

// Format blocks for system prompt injection.
// scopes should be ['shared', ...companion slugs active in the thread].
//
// Carried blocks ride in full. Shelved blocks ('on_demand', migrations/053)
// ride as one index line each.
export function formatBlocksForPrompt(scopes: string[]): string {
  const blocks = getBlocksForScopes(scopes);
  if (blocks.length === 0) return '';
  const carried = blocks.filter(isCarried);
  const shelved = blocks.filter((block) => !isCarried(block));

  let output = '\n<core-memory>\n';
  output +=
    'Persistent memory blocks. Edit them in place with the core_memory_append / core_memory_replace / core_memory_rethink tools. ' +
    "Blocks scoped 'shared' are visible to every companion; blocks scoped to a companion slug belong to that companion alone. " +
    'Keep them current — when you learn something durable, write it down. ' +
    'The core-memory-label-json comment carries the exact label; descriptions are separate and are never part of the label.\n\n';
  // Both ahead of the first block on purpose: see renderSelfKnowledgeForPrompt.
  output += renderSelfKnowledgeForPrompt(scopes);
  output += renderShelfIndex(shelved);
  for (const block of carried) {
    output += `## [${block.scope}] ${block.label}\n`;
    output += `<!-- core-memory-label-json: ${JSON.stringify(block.label)} -->\n`;
    if (block.description) output += `<!-- ${block.description} -->\n`;
    output += (block.content.trim() ? block.content : '(empty)') + '\n\n';
  }
  output += '</core-memory>\n';
  return output;
}

// The delimiters formatBlocksForPrompt wraps the core-memory span in. Kept here,
// next to the writer, so any reader that needs to locate/lift that span shares
// one source of truth for the markers (heartbeat/provision.ts re-declares its
// own copy for the CLAUDE.md path; codex-daemon reads these).
export const CORE_MEMORY_OPEN = '<core-memory>';
export const CORE_MEMORY_CLOSE = '</core-memory>';

/**
 * Split the `<core-memory>…</core-memory>` span out of an orientation string.
 *
 * Pure string surgery — no DB access — so lanes that carry memory somewhere
 * other than the per-turn payload (the Claude CLI lane parks it in CLAUDE.md;
 * the codex warm-daemon lane parks it in the thread's baseInstructions) can
 * strip it from the per-turn orientation while still getting the exact block
 * text back to place at their once-per-session seam.
 *
 * Returns the orientation with the span removed (seam collapsed the same way
 * heartbeat's stripCoreMemoryFromOrientation does) plus the extracted span
 * text (empty when there is no span → pass-through).
 */
export function splitCoreMemoryFromOrientation(orientation: string): {
  withoutMemory: string;
  memory: string;
} {
  const open = orientation.indexOf(CORE_MEMORY_OPEN);
  if (open === -1) return { withoutMemory: orientation, memory: '' };
  const close = orientation.indexOf(CORE_MEMORY_CLOSE, open);
  if (close === -1) return { withoutMemory: orientation, memory: '' };
  const end = close + CORE_MEMORY_CLOSE.length;
  const memory = orientation.slice(open, end);
  // Collapse the seam the removal leaves (the span arrives newline-padded on
  // both sides) without touching newlines elsewhere — mirrors runtime.ts.
  const before = orientation.slice(0, open).replace(/\n+$/, '\n');
  const after = orientation.slice(end).replace(/^\n+/, '\n');
  return { withoutMemory: before + after, memory };
}

// The Archivist gets the same field boundary as the interactive context, with
// JSON quoting to make labels containing punctuation/newlines round-trip too.
export function formatBlocksForExtractionPrompt(blocks: Array<{
  scope: string;
  label: string;
  description?: string;
  content: string;
}>): string {
  if (blocks.length === 0) return '(no blocks yet)';
  return blocks.map((block) => [
    `[${block.scope}] label: ${JSON.stringify(block.label)}`,
    ...(block.description ? [`description: ${JSON.stringify(block.description)}`] : []),
    block.content || '(empty)',
  ].join('\n')).join('\n\n');
}

// The shared block about the person the companions live with.
export const HUMAN_BLOCK_LABEL = 'human';
const HUMAN_BLOCK_DESCRIPTION = 'Information about the user, shared across companions';

// Seed default blocks for a brand-new installation
export function seedDefaultBlocks(
  userName: string,
  companions: { slug: string; display_name: string }[]
): void {
  const existing = getAllBlocks();
  if (existing.length > 0) return;

  setBlock(SHARED_SCOPE, HUMAN_BLOCK_LABEL, `Name: ${userName}`, HUMAN_BLOCK_DESCRIPTION);
  setBlock(SHARED_SCOPE, 'status', '', 'Current status, ongoing projects, open questions');
  for (const c of companions) {
    setBlock(c.slug, 'persona', `I am ${c.display_name}.`, `${c.display_name}'s self-authored persona and continuity`);
  }
}

// Non-destructive: make sure the shared block about the user exists. The seed
// above only runs on an empty install, so a house whose blocks predate it (or
// that lost the block since) never got one, and the Archivist had nowhere to
// file what it learned about the person. An existing block, under its label or
// an alias, is left exactly as it is. Returns true when it created the block.
export function ensureHumanBlock(userName: string): boolean {
  if (getBlock(SHARED_SCOPE, HUMAN_BLOCK_LABEL)) return false;
  setBlock(SHARED_SCOPE, HUMAN_BLOCK_LABEL, `Name: ${userName}`, HUMAN_BLOCK_DESCRIPTION);
  return true;
}

// Non-destructive: make sure every companion has its own persona block
export function ensureCompanionBlocks(companions: { slug: string; display_name: string }[]): void {
  for (const c of companions) {
    if (!getBlock(c.slug, 'persona')) {
      setBlock(c.slug, 'persona', `I am ${c.display_name}.`, `${c.display_name}'s self-authored persona and continuity`);
    }
  }
}

// Validate a scope string: 'shared' or a known companion slug.
// Returns the normalized scope, or null if unknown.
export function resolveScope(scope: string): string | null {
  const s = scope.trim().toLowerCase();
  if (s === SHARED_SCOPE) return SHARED_SCOPE;
  return (COMPANION_SCOPES as readonly string[]).includes(s) ? s : null;
}

export function validScopesHint(): string {
  const slugs = COMPANION_SCOPES.map((s) => `'${s}'`).join(', ');
  return `'${SHARED_SCOPE}'${slugs ? ', ' + slugs : ''}`;
}
