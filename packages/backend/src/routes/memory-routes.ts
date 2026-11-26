// routes/memory-routes.ts — authenticated Memory Blocks API (the operator's window).
//
// Ported from the reference implementation fork, Apache 2.0 — adapted for byte-light.
// Adaptations vs. reference implementation's routes/memory-blocks.ts:
//   (a) Wrapped in byte-light's createXRoutes(): Router factory convention
//       (reference implementation exported a bare `default router`; here it mirrors
//       mind-routes.ts / the other panel routers so it mounts the same way).
//   (b) Every successful write broadcasts a `memory_block_updated`
//       { scope, label } over the WS registry so an open Memory panel (or the
//       chat) re-fetches when a companion — or the operator — edits a block. The panel
//       stays minimal: it just re-fetches on the event.
//   (c) Scope is validated against 'shared' | 'companion-a' | 'companion-b' via the
//       slice-1 service's resolveScope / validScopesHint (reference implementation shared the
//       same service surface).
//   (d) agentService for the manual Archivist run is read from
//       req.app.locals.agentService — byte-light's idiom (server.ts:222),
//       same as internal-routes.ts and messages.ts. reference implementation read it from the
//       identical app.locals slot, so no reshaping was needed.

import { Router } from 'express';
import * as memoryBlocks from '../services/memory-blocks.js';
import { getMemoryExtractionStatus, runMemoryExtraction } from '../services/memory-extraction.js';
import {
  listProposals,
  listForOwnerReview,
  countForOwnerReview,
  countPending,
  approveProposalForOwner,
  rejectProposalForOwner,
  type ProposalStatus,
} from '../services/memory-proposals.js';
import { getBytelightConfig } from '../config.js';
import { listMemoryLedger, markMemoryLedgerSeen } from '../services/memory-ledger.js';
import { runMemoryDiet } from '../services/memory-diet.js';
import { registry } from '../services/registry.js';
import { OLD_WINDOWS_KEY, oldWindowsEnabled, historyIndexStats } from '../services/history-recall.js';
import { setConfig } from '../services/db/config.js';
import type { AgentService } from '../services/agent.js';

// Announce a block write to every connected client so open panels re-fetch.
function broadcastBlockUpdated(scope: string, label: string): void {
  registry.broadcast({ type: 'memory_block_updated', scope, label });
}

// Ledger attribution: everything through these routes is the owner acting
// directly in the memory UI, not a companion writing to itself.
const API_WRITE = { actor: 'api' } as const;

export function createMemoryRoutes(): Router {
  const router = Router();

  // Validate a raw scope; on failure, write the 400 and return null so the
  // handler can early-return. Mirrors reference implementation's checkScope helper.
  function checkScope(raw: string, res: import('express').Response): string | null {
    const scope = memoryBlocks.resolveScope(raw);
    if (!scope) {
      res.status(400).json({ error: `Unknown scope '${raw}'. Valid scopes: ${memoryBlocks.validScopesHint()}` });
      return null;
    }
    return scope;
  }

  // List all blocks (optional ?scope= filter), shared-first then by label.
  router.get('/memory/blocks', (req, res) => {
    const scopeFilter = req.query.scope as string | undefined;
    let blocks = memoryBlocks.getAllBlocks();
    if (scopeFilter) blocks = blocks.filter((b) => b.scope === scopeFilter);
    res.json(blocks);
  });

  // One block by scope + label.
  router.get('/memory/blocks/:scope/:label', (req, res) => {
    const block = memoryBlocks.getBlock(req.params.scope, req.params.label);
    if (!block) {
      res.status(404).json({ error: 'Block not found' });
      return;
    }
    res.json(block);
  });

  // Open alias registry. Aliases are data, never a hardcoded nickname enum.
  router.get('/memory/blocks/:scope/:label/aliases', (req, res) => {
    const aliases = memoryBlocks.getBlockAliases(req.params.scope, req.params.label);
    if (aliases.length === 0 && !memoryBlocks.getBlock(req.params.scope, req.params.label)) {
      res.status(404).json({ error: 'Block not found' });
      return;
    }
    res.json(aliases);
  });

  router.post('/memory/blocks/:scope/:label/aliases', (req, res) => {
    try {
      const scope = checkScope(req.params.scope, res);
      if (!scope) return;
      const alias = req.body?.alias;
      if (typeof alias !== 'string' || !alias.trim()) {
        res.status(400).json({ error: 'Alias required' });
        return;
      }
      const identity = memoryBlocks.addBlockAlias(scope, req.params.label, alias);
      res.json({ success: true, blockId: identity.id, scope, label: identity.canonical_label, alias });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Create (or upsert) a block.
  router.post('/memory/blocks', (req, res) => {
    const { scope: rawScope, label, content, description } = req.body;
    if (!label || typeof label !== 'string') {
      res.status(400).json({ error: 'Label required' });
      return;
    }
    const scope = checkScope(rawScope || memoryBlocks.SHARED_SCOPE, res);
    if (!scope) return;
    memoryBlocks.setBlock(scope, label, content || '', description, API_WRITE);
    broadcastBlockUpdated(scope, label);
    res.json({ success: true });
  });

  // Replace a block's content/description in place.
  router.put('/memory/blocks/:scope/:label', (req, res) => {
    const scope = checkScope(req.params.scope, res);
    if (!scope) return;
    const { content, description } = req.body;
    memoryBlocks.setBlock(scope, req.params.label, content || '', description, API_WRITE);
    broadcastBlockUpdated(scope, req.params.label);
    res.json({ success: true });
  });

  // Delete a block.
  router.delete('/memory/blocks/:scope/:label', (req, res) => {
    const scope = checkScope(req.params.scope, res);
    if (!scope) return;
    memoryBlocks.deleteBlock(scope, req.params.label, API_WRITE);
    broadcastBlockUpdated(scope, req.params.label);
    res.json({ success: true });
  });

  // Carry the block in every session, or keep it on the shelf (migrations/053).
  router.put('/memory/blocks/:scope/:label/carry', (req, res) => {
    try {
      const scope = checkScope(req.params.scope, res);
      if (!scope) return;
      const carry = req.body?.carry;
      if (carry !== 'always' && carry !== 'on_demand') {
        res.status(400).json({ error: "carry must be 'always' or 'on_demand'" });
        return;
      }
      const block = memoryBlocks.setBlockCarry(scope, req.params.label, carry, API_WRITE);
      if (!block) {
        res.status(404).json({ error: 'Block not found' });
        return;
      }
      broadcastBlockUpdated(block.scope, block.label);
      res.json({ success: true, block });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Append a line.
  router.post('/memory/blocks/:scope/:label/append', (req, res) => {
    try {
      const scope = checkScope(req.params.scope, res);
      if (!scope) return;
      const { content } = req.body;
      const result = memoryBlocks.appendToBlock(scope, req.params.label, content, API_WRITE);
      broadcastBlockUpdated(scope, req.params.label);
      res.json({ success: true, content: result });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Replace exact text.
  router.post('/memory/blocks/:scope/:label/replace', (req, res) => {
    try {
      const scope = checkScope(req.params.scope, res);
      if (!scope) return;
      const { oldText, newText } = req.body;
      const result = memoryBlocks.replaceInBlock(scope, req.params.label, oldText, newText, API_WRITE);
      broadcastBlockUpdated(scope, req.params.label);
      res.json({ success: true, content: result });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Rethink — full rewrite.
  router.post('/memory/blocks/:scope/:label/rethink', (req, res) => {
    try {
      const scope = checkScope(req.params.scope, res);
      if (!scope) return;
      const { content } = req.body;
      const result = memoryBlocks.rethinkBlock(scope, req.params.label, content, API_WRITE);
      broadcastBlockUpdated(scope, req.params.label);
      res.json({ success: true, content: result });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // --- Version history (migrations/052) -------------------------------------
  //
  // The text a block held before each write that would have lost some of it.
  // Reading is free; restoring is itself a write (and itself kept), so a
  // restore can be undone the same way.

  // Earlier versions of one block, newest first (no full text).
  router.get('/memory/blocks/:scope/:label/history', (req, res) => {
    const rawLimit = parseInt(String(req.query.limit ?? '50'), 10);
    res.json({
      success: true,
      versions: memoryBlocks.listBlockVersions(
        req.params.scope,
        req.params.label,
        Number.isFinite(rawLimit) ? rawLimit : 50,
      ),
    });
  });

  // Blocks that were deleted and not made again.
  router.get('/memory/history/deleted', (_req, res) => {
    res.json({ success: true, versions: memoryBlocks.listDeletedBlocks() });
  });

  // One earlier version, with its full text.
  router.get('/memory/history/:id', (req, res) => {
    const id = Number(req.params.id);
    const version = Number.isInteger(id) && id > 0 ? memoryBlocks.getBlockVersion(id) : null;
    if (!version) {
      res.status(404).json({ error: 'No such version' });
      return;
    }
    res.json({ success: true, version });
  });

  // Put the block back the way that version had it.
  router.post('/memory/history/:id/restore', (req, res) => {
    try {
      const id = Number(req.params.id);
      const block = Number.isInteger(id) && id > 0 ? memoryBlocks.restoreBlockVersion(id, API_WRITE) : null;
      if (!block) {
        res.status(404).json({ error: 'No such version' });
        return;
      }
      broadcastBlockUpdated(block.scope, block.label);
      res.json({ success: true, block });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // The receipts ledger — one row per memory write / surface, newest first.
  // Owner data: mounted after authMiddleware (api.ts), same as the block
  // routes above. The receipts drawer (Command Center) reads this.
  router.get('/memory/ledger', (req, res) => {
    const rawLimit = parseInt(String(req.query.limit ?? '100'), 10);
    const rawOffset = parseInt(String(req.query.offset ?? '0'), 10);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 100;
    const offset = Number.isFinite(rawOffset) ? rawOffset : 0;
    // listMemoryLedger clamps limit to 1..500 and offset to >=0 internally.
    res.json(listMemoryLedger(limit, offset));
  });

  // Mark everything up to (and including) `throughId` as seen — lets the
  // drawer clear its unseen indicator. First stamp wins (COALESCE, service-side).
  router.post('/memory/ledger/seen', (req, res) => {
    const throughId = Number(req.body?.throughId);
    if (!Number.isFinite(throughId) || throughId < 0) {
      res.status(400).json({ error: 'throughId (number) required' });
      return;
    }
    markMemoryLedgerSeen(throughId);
    res.json({ success: true });
  });

  // Old windows: pieces of imported chats surfacing in the person's own turns
  // (services/history-recall.ts, heartbeat/whisper.ts). On unless turned off.
  router.get('/memory/old-windows', (_req, res) => {
    res.json({ enabled: oldWindowsEnabled(), indexed: historyIndexStats() });
  });

  router.put('/memory/old-windows', (req, res) => {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled (true or false) is required' });
      return;
    }
    setConfig(OLD_WINDOWS_KEY, enabled ? 'true' : 'false');
    res.json({ enabled: oldWindowsEnabled(), indexed: historyIndexStats() });
  });

  // Archivist health for the banner on the Memory Blocks screen (Aerie's
  // routes/memory-blocks.ts). The phone already called this; it 404'd before.
  router.get('/memory/extraction/status', (_req, res) => {
    try {
      res.json(getMemoryExtractionStatus());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // --- The Archivist's proposals ------------------------------------------
  //
  // Every Archivist edit lands in memory_proposals (see memory-proposals.ts).
  // The operator's window onto the proposals, which are offered to the
  // companions and not to the operator (services/memory-proposals.ts). The
  // operator can list them, file one directly (written onto its block, closed
  // as 'filed'), or drop one ('dropped'). ?status=review (default) is the live
  // ones only; faded rows are under 'faded' or 'all', and stay fileable.
  const PROPOSAL_STATUSES = new Set(['pending', 'filed', 'dropped', 'faded']);
  const ownerSlug = () => getBytelightConfig().identity.user_name.trim().toLowerCase() || 'owner';

  router.get('/memory/proposals', (req, res) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : 'review';
      let proposals: ReturnType<typeof listProposals>;
      if (status === 'review') proposals = listForOwnerReview(200);
      else if (status === 'all') proposals = listProposals(undefined, 200);
      else if (PROPOSAL_STATUSES.has(status)) proposals = listProposals(status as ProposalStatus, 200);
      else {
        res.status(400).json({ error: "status must be review, all, pending, filed, dropped or faded" });
        return;
      }
      res.json({ success: true, proposals, review: countForOwnerReview(), pending: countPending() });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/memory/proposals/:id/:decision', (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    const decision = req.params.decision;
    if (!Number.isFinite(id) || (decision !== 'approve' && decision !== 'reject')) {
      res.status(404).json({ error: 'Use POST /memory/proposals/<id>/approve or /reject' });
      return;
    }
    try {
      const result = decision === 'approve'
        ? approveProposalForOwner(id, ownerSlug())
        : rejectProposalForOwner(id, ownerSlug());
      if (!result.ok) {
        res.status(result.reason === 'not_found' ? 404 : 409).json({
          error: result.reason === 'not_found' ? 'No such proposal' : 'Already decided',
          proposal: result.proposal,
        });
        return;
      }
      if (decision === 'approve') broadcastBlockUpdated(result.proposal.scope, result.proposal.label);
      res.json({ success: true, proposal: result.proposal });
    } catch (err) {
      // A write that could not apply (e.g. replace text no longer on the
      // block) leaves the proposal open; say why.
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Manually trigger the Archivist — whole sweep, or one thread via { threadId }.
  router.post('/memory/extract', async (req, res) => {
    try {
      const { threadId } = req.body || {};
      const agent = req.app.locals.agentService as AgentService | undefined;
      const scopedThread = typeof threadId === 'string' && threadId.trim() ? threadId.trim() : undefined;
      const result = await runMemoryExtraction(agent, scopedThread);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Run one conservative diet pass. The route is mounted after auth in api.ts.
  router.post('/memory/diet/run', async (req, res) => {
    try {
      const dryRun = req.query.dryRun === '1' || req.body?.dryRun === true;
      res.json({ success: true, dryRun, ...(await runMemoryDiet(undefined, new Date(), { dryRun })) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
