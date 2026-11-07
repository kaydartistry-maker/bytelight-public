import React, { useState, useEffect, useCallback } from 'react';
import { Layers, Plus, Edit3, Trash2, Check, X, RefreshCw, ChevronRight, RotateCcw } from 'lucide-react';
import { AppShell } from './AppShell';
import { ArchivistSettings } from './ArchivistSettings';
import { ThemeConfig } from '../lib/theme';
import { Paginator, usePaged } from './Paginator';
import { cn } from '../lib/utils';
import { useMemoryBlockVersion } from '../bytelight';
import { normalizeCompanionRows } from '../lib/companion-row';

interface MemoryBlocksAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  embedded?: boolean;
}

type Tab = 'blocks' | 'review' | 'create' | 'operations';

interface MemoryBlock {
  scope: string;
  label: string;
  content: string;
  description?: string;
  updated_at: string;
}

interface ArchivistStatus {
  lastAttemptAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastOutcome: 'ok' | 'error' | null;
  lastError: string | null;
  backlogMessages: number;
  backlogThreads: number;
}

// One Archivist proposal (backend services/memory-proposals.ts). Nothing the
// Archivist notices reaches a block until the operator approves it here.
interface MemoryProposal {
  id: number;
  op: 'append' | 'replace';
  scope: string;
  label: string;
  content: string;
  old_text: string | null;
  source_thread: string | null;
  surfaced_count: number;
  status: 'pending' | 'filed' | 'dropped' | 'faded';
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

type ProposalView = 'review' | 'all';

const SHARED_SCOPE = 'shared';

// SQLite's datetime('now') is UTC without a zone ("2026-10-24 18:02:11");
// read it as UTC on every browser.
function sqliteDate(value: string): Date {
  const iso = value.includes('T') ? value : value.replace(' ', 'T');
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z');
}

function blockKey(b: { scope: string; label: string }): string {
  return `${b.scope}/${b.label}`;
}

function blockUrl(scope: string, label: string): string {
  return `/api/memory/blocks/${encodeURIComponent(scope)}/${encodeURIComponent(label)}`;
}

export function MemoryBlocksApp({ onClose, themeConfig, themeMode, embedded }: MemoryBlocksAppProps) {
  const colors = themeConfig[themeMode];
  const [tab, setTab] = useState<Tab>('blocks');
  const [isLoading, setIsLoading] = useState(false);

  // Blocks state
  const [blocks, setBlocks] = useState<MemoryBlock[]>([]);
  // Twenty blocks a page.
  const blocksPage = usePaged(blocks);
  const [scopes, setScopes] = useState<string[]>([SHARED_SCOPE]);
  const [selectedBlock, setSelectedBlock] = useState<MemoryBlock | null>(null);
  const [archivistStatus, setArchivistStatus] = useState<ArchivistStatus | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');

  // Create state
  const [newScope, setNewScope] = useState(SHARED_SCOPE);
  const [newLabel, setNewLabel] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newDescription, setNewDescription] = useState('');

  // Operations state
  const [opIndex, setOpIndex] = useState('');
  const [appendText, setAppendText] = useState('');
  const [replaceOld, setReplaceOld] = useState('');
  const [replaceNew, setReplaceNew] = useState('');
  const [rethinkContent, setRethinkContent] = useState('');
  const [opResult, setOpResult] = useState<string | null>(null);

  // Review state (the Archivist's proposals)
  const [proposals, setProposals] = useState<MemoryProposal[]>([]);
  const [reviewCount, setReviewCount] = useState(0);
  const [proposalView, setProposalView] = useState<ProposalView>('review');
  const [proposalBusy, setProposalBusy] = useState<number | null>(null);
  const [proposalError, setProposalError] = useState<string | null>(null);
  const proposalsPage = usePaged(proposals);

  const opTarget = opIndex !== '' ? blocks[Number(opIndex)] : undefined;

  const fetchBlocks = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/memory/blocks', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        const list: MemoryBlock[] = Array.isArray(data) ? data : [];
        // Shared first, then companion scopes alphabetically
        list.sort((a, b) =>
          (a.scope === SHARED_SCOPE ? '' : a.scope).localeCompare(b.scope === SHARED_SCOPE ? '' : b.scope) ||
          a.label.localeCompare(b.label)
        );
        setBlocks(list);
        // Keep an open detail view attached to the freshly fetched row. Before
        // this, Refresh updated the list behind the screen while the selected
        // block (including its timestamp) stayed stale indefinitely.
        setSelectedBlock((current) => {
          if (!current) return null;
          return list.find((block) => blockKey(block) === blockKey(current)) ?? null;
        });
      }
    } catch (err) {
      console.error('[MemoryBlocks] Failed to fetch:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const fetchScopes = useCallback(async () => {
    try {
      const res = await fetch('/api/companions', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        const slugs: string[] = normalizeCompanionRows(data.companions).map((c) => c.slug);
        setScopes([SHARED_SCOPE, ...slugs]);
      }
    } catch (err) {
      console.error('[MemoryBlocks] Failed to fetch companions:', err);
    }
  }, []);

  const fetchArchivistStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/memory/extraction/status', { credentials: 'include' });
      if (res.ok) setArchivistStatus(await res.json());
    } catch (err) {
      console.error('[MemoryBlocks] Failed to fetch Archivist status:', err);
    }
  }, []);

  const fetchProposals = useCallback(async (view: ProposalView) => {
    try {
      const res = await fetch(`/api/memory/proposals?status=${view}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setProposals(Array.isArray(data.proposals) ? data.proposals : []);
        setReviewCount(typeof data.review === 'number' ? data.review : 0);
      }
    } catch (err) {
      console.error('[MemoryBlocks] Failed to fetch proposals:', err);
    }
  }, []);

  useEffect(() => {
    fetchProposals(proposalView);
  }, [fetchProposals, proposalView]);

  const handleDecide = async (proposal: MemoryProposal, decision: 'approve' | 'reject') => {
    setProposalBusy(proposal.id);
    setProposalError(null);
    try {
      const res = await fetch(`/api/memory/proposals/${proposal.id}/${decision}`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setProposalError(data.error || `Could not ${decision}`);
      await fetchProposals(proposalView);
      if (decision === 'approve') fetchBlocks();
    } catch (err) {
      setProposalError((err as Error).message);
    } finally {
      setProposalBusy(null);
    }
  };

  // Re-fetch when main broadcasts memory_block_updated (a companion's tool
  // edit, the CLI, or another device) so the list never shows a stale block.
  const memoryBlockVersion = useMemoryBlockVersion();
  useEffect(() => {
    fetchBlocks();
    fetchScopes();
    fetchArchivistStatus();
  }, [fetchBlocks, fetchScopes, fetchArchivistStatus, memoryBlockVersion]);

  const handleCreate = async () => {
    if (!newLabel.trim()) return;
    try {
      await fetch('/api/memory/blocks', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: newScope, label: newLabel, content: newContent, description: newDescription }),
      });
      setNewLabel('');
      setNewContent('');
      setNewDescription('');
      fetchBlocks();
      setTab('blocks');
    } catch (err) {
      console.error('[MemoryBlocks] Create failed:', err);
    }
  };

  const handleUpdate = async (block: MemoryBlock) => {
    try {
      await fetch(blockUrl(block.scope, block.label), {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editContent }),
      });
      setEditingKey(null);
      await fetchBlocks();
    } catch (err) {
      console.error('[MemoryBlocks] Update failed:', err);
    }
  };

  const handleDelete = async (block: MemoryBlock) => {
    if (!confirm(`Delete block "${block.scope}/${block.label}"?`)) return;
    try {
      await fetch(blockUrl(block.scope, block.label), {
        method: 'DELETE',
        credentials: 'include',
      });
      setBlocks((prev) => prev.filter((b) => blockKey(b) !== blockKey(block)));
      if (selectedBlock && blockKey(selectedBlock) === blockKey(block)) setSelectedBlock(null);
    } catch (err) {
      console.error('[MemoryBlocks] Delete failed:', err);
    }
  };

  const handleAppend = async () => {
    if (!opTarget || !appendText.trim()) return;
    try {
      const res = await fetch(`${blockUrl(opTarget.scope, opTarget.label)}/append`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: appendText }),
      });
      const data = await res.json();
      if (data.success) {
        setOpResult(`Appended to "${blockKey(opTarget)}"`);
        setAppendText('');
        fetchBlocks();
      } else {
        setOpResult(`Error: ${data.error}`);
      }
    } catch (err) {
      setOpResult(`Error: ${(err as Error).message}`);
    }
  };

  const handleReplace = async () => {
    if (!opTarget || !replaceOld.trim()) return;
    try {
      const res = await fetch(`${blockUrl(opTarget.scope, opTarget.label)}/replace`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldText: replaceOld, newText: replaceNew }),
      });
      const data = await res.json();
      if (data.success) {
        setOpResult(`Replaced in "${blockKey(opTarget)}"`);
        setReplaceOld('');
        setReplaceNew('');
        fetchBlocks();
      } else {
        setOpResult(`Error: ${data.error}`);
      }
    } catch (err) {
      setOpResult(`Error: ${(err as Error).message}`);
    }
  };

  const handleRethink = async () => {
    if (!opTarget || !rethinkContent.trim()) return;
    try {
      const res = await fetch(`${blockUrl(opTarget.scope, opTarget.label)}/rethink`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: rethinkContent }),
      });
      const data = await res.json();
      if (data.success) {
        setOpResult(`Rewrote "${blockKey(opTarget)}"`);
        setRethinkContent('');
        fetchBlocks();
      } else {
        setOpResult(`Error: ${data.error}`);
      }
    } catch (err) {
      setOpResult(`Error: ${(err as Error).message}`);
    }
  };

  const TABS: { id: Tab; label: string }[] = [
    { id: 'blocks', label: 'Blocks' },
    { id: 'review', label: reviewCount > 0 ? `Review (${reviewCount})` : 'Review' },
    { id: 'create', label: 'Create' },
    { id: 'operations', label: 'Ops' },
  ];

  const scopeBadge = (scope: string) => (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded-full border uppercase tracking-wide opacity-80"
      style={scope === SHARED_SCOPE ? undefined : { borderColor: colors.accent, color: colors.accent }}
    >
      {scope}
    </span>
  );

  // Back button goes "one level out": from a block detail back to the list,
  // from the list out of the app.
  const handleBack = () => {
    if (tab === 'blocks' && selectedBlock) {
      setEditingKey(null);
      setSelectedBlock(null);
    } else {
      onClose();
    }
  };

  return (
    <AppShell embedded={embedded} title="Memory Blocks" icon={Layers} onClose={handleBack} themeConfig={themeConfig} themeMode={themeMode}>
      {/* Tab bar */}
      <div className={cn("p-3 rounded-2xl border backdrop-blur-md mb-4 flex items-center", colors.panelBg, colors.panelBorder)}>
        <div className="flex gap-1.5 overflow-x-auto scrollbar-hide flex-1 justify-center">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => { setTab(t.id); setOpResult(null); }}
              className={cn('shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors border', colors.panelBorder, tab !== t.id && colors.panelBg)}
              style={tab === t.id ? { background: colors.accent, color: 'var(--bytelight-on-accent)', borderColor: colors.accent } : undefined}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button onClick={() => { fetchBlocks(); fetchArchivistStatus(); fetchProposals(proposalView); }} className="p-1.5 rounded hover:bg-white/10" title="Refresh">
          <RefreshCw size={14} />
        </button>
      </div>

      {archivistStatus && (
        <div
          className={cn('mb-4 rounded-xl border px-3 py-2 text-xs', colors.panelBorder, colors.panelBg)}
          style={archivistStatus.lastOutcome === 'error' ? { borderColor: '#ef4444' } : undefined}
        >
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium">
              Archivist: {archivistStatus.lastOutcome === 'error' ? 'needs attention' : archivistStatus.lastOutcome === 'ok' ? 'healthy' : 'waiting for first run'}
            </span>
            <span className="opacity-60">
              {archivistStatus.backlogMessages} waiting
            </span>
          </div>
          {archivistStatus.lastError && (
            <div className="mt-1 opacity-70 line-clamp-2">{archivistStatus.lastError}</div>
          )}
        </div>
      )}

      <ArchivistSettings themeConfig={themeConfig} themeMode={themeMode} />

      {/* Blocks list */}
      {tab === 'blocks' && (
        <div className="space-y-2">
          {isLoading ? (
            <div className="text-center py-8 opacity-50">Loading blocks...</div>
          ) : blocks.length === 0 ? (
            <div className="text-center py-8 opacity-50">No memory blocks yet</div>
          ) : selectedBlock ? (
            <div className={cn('p-4 rounded-lg border', colors.panelBorder, colors.panelBg)}>
              <div className="flex items-center justify-between mb-3">
                <button onClick={() => setSelectedBlock(null)} className="text-xs opacity-60 hover:opacity-100">
                  &larr; Back
                </button>
                <div className="flex gap-1">
                  <button
                    onClick={() => { setEditingKey(blockKey(selectedBlock)); setEditContent(selectedBlock.content); }}
                    className="p-1 rounded hover:bg-white/10"
                  >
                    <Edit3 size={14} />
                  </button>
                  <button onClick={() => handleDelete(selectedBlock)} className="p-1 rounded hover:bg-white/10" style={{ color: colors.accent }}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-2 mb-1">
                <h3 className="font-bold text-lg">{selectedBlock.label}</h3>
                {scopeBadge(selectedBlock.scope)}
              </div>
              {selectedBlock.description && <p className="text-xs opacity-60 mb-3">{selectedBlock.description}</p>}
              {editingKey === blockKey(selectedBlock) ? (
                <div className="space-y-2">
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    className="w-full p-2 rounded border bg-transparent text-sm"
                    rows={6}
                  />
                  <div className="flex gap-2">
                    <button onClick={() => handleUpdate(selectedBlock)} className="p-1.5 rounded bytelight-on-accent" style={{ backgroundColor: colors.accent }}>
                      <Check size={14} />
                    </button>
                    <button onClick={() => setEditingKey(null)} className="p-1.5 rounded" style={{ backgroundColor: colors.accent, opacity: 0.6 }}>
                      <X size={14} />
                    </button>
                  </div>
                </div>
              ) : (
                <pre className="text-sm whitespace-pre-wrap font-mono opacity-90">{selectedBlock.content || '(empty)'}</pre>
              )}
              <div className="mt-3 pt-2 border-t border-white/10 text-xs opacity-50">
                Updated: {new Date(selectedBlock.updated_at).toLocaleString()}
              </div>
            </div>
          ) : (
                <>
                {blocksPage.visible.map((block) => (
              <button
                key={blockKey(block)}
                onClick={() => setSelectedBlock(block)}
                className={cn('w-full p-3 rounded-lg border text-left flex items-center justify-between', colors.panelBorder, colors.panelBg)}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{block.label}</span>
                    {scopeBadge(block.scope)}
                  </div>
                  {block.description && <div className="text-xs opacity-50 truncate">{block.description}</div>}
                  <div className="text-xs opacity-40 mt-1">{block.content.length} chars</div>
                </div>
                <ChevronRight size={16} className="opacity-40 ml-2 shrink-0" />
              </button>
                ))}
                <Paginator page={blocksPage.page} pageCount={blocksPage.pageCount} onPage={blocksPage.setPage} colors={colors} />
                </>
          )}
        </div>
      )}

      {/* Review — the Archivist's proposals, waiting on the operator */}
      {tab === 'review' && (
        <div className="space-y-2">
          <div className="flex gap-1.5">
            {([
              { id: 'review', label: 'Waiting' },
              { id: 'all', label: 'All' },
            ] as { id: ProposalView; label: string }[]).map((v) => (
              <button
                key={v.id}
                onClick={() => setProposalView(v.id)}
                className={cn('rounded-lg border px-2.5 py-1.5 text-xs', colors.panelBorder)}
                style={proposalView === v.id ? { background: colors.accent, color: 'var(--bytelight-on-accent)' } : undefined}
              >
                {v.label}
              </button>
            ))}
          </div>
          <p className={cn('text-[10px]', colors.textMuted)}>
            What the Archivist noticed. Nothing here is on a block until you approve it.
          </p>
          {proposalError && (
            <div className="p-2 rounded text-xs" style={{ backgroundColor: `${colors.accent}20`, color: colors.accent }}>
              {proposalError}
            </div>
          )}
          {proposals.length === 0 ? (
            <div className="text-center py-8 opacity-50">
              {proposalView === 'review' ? 'Nothing waiting for you' : 'No proposals yet'}
            </div>
          ) : (
            <>
              {proposalsPage.visible.map((p) => {
                const open = p.status === 'pending' || p.status === 'faded';
                const fromDiet = (p.source_thread ?? '').startsWith('memory-diet:');
                return (
                  <div key={p.id} className={cn('p-3 rounded-lg border', colors.panelBorder, colors.panelBg)}>
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      {scopeBadge(p.scope)}
                      <span className="text-xs font-medium">{p.label}</span>
                      <span className="text-[10px] opacity-60">
                        {fromDiet ? 'size review' : p.op === 'replace' ? 'correction' : 'new line'}
                      </span>
                      {p.status !== 'pending' && (
                        <span className="text-[10px] opacity-60 uppercase tracking-wide">
                          {p.status === 'faded' ? 'faded for them, still yours' : `${p.status}${p.resolved_by ? ` by ${p.resolved_by}` : ''}`}
                        </span>
                      )}
                    </div>
                    {p.op === 'replace' && p.old_text && !fromDiet && (
                      <div className="text-xs opacity-50 line-through whitespace-pre-wrap mb-1">{p.old_text}</div>
                    )}
                    <div className="text-sm whitespace-pre-wrap">
                      {fromDiet ? 'This block is over its size budget and needs a manual look.' : p.content}
                    </div>
                    <div className="text-[10px] opacity-40 mt-1">{sqliteDate(p.created_at).toLocaleString()}</div>
                    {open && (
                      <div className="flex gap-2 mt-2">
                        <button
                          onClick={() => handleDecide(p, 'approve')}
                          disabled={proposalBusy === p.id}
                          className="px-3 py-1.5 rounded text-xs font-medium bytelight-on-accent disabled:opacity-50 flex items-center gap-1"
                          style={{ background: colors.accent }}
                        >
                          <Check size={12} /> Approve
                        </button>
                        <button
                          onClick={() => handleDecide(p, 'reject')}
                          disabled={proposalBusy === p.id}
                          className={cn('px-3 py-1.5 rounded text-xs font-medium border disabled:opacity-50 flex items-center gap-1', colors.panelBorder)}
                        >
                          <X size={12} /> Reject
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
              <Paginator page={proposalsPage.page} pageCount={proposalsPage.pageCount} onPage={proposalsPage.setPage} colors={colors} />
            </>
          )}
        </div>
      )}

      {/* Create new block */}
      {tab === 'create' && (
        <div className={cn('rounded-2xl border p-4 backdrop-blur-md space-y-4', colors.panelBg, colors.panelBorder)}>
          <div>
            <label className={cn('text-xs mb-1 block', colors.textMuted)}>Scope</label>
            <select
              value={newScope}
              onChange={(e) => setNewScope(e.target.value)}
              className={cn('w-full px-3 py-2 rounded-lg border bg-transparent text-sm', colors.panelBorder)}
            >
              {scopes.map((s) => (
                <option key={s} value={s}>{s === SHARED_SCOPE ? 'shared (all companions)' : s}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={cn('text-xs mb-1 block', colors.textMuted)}>Label (unique within scope)</label>
            <input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="e.g. persona, human, status"
              className={cn('w-full px-3 py-2 rounded-lg border bg-transparent text-sm', colors.panelBorder)}
            />
          </div>
          <div>
            <label className={cn('text-xs mb-1 block', colors.textMuted)}>Description (optional)</label>
            <input
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              placeholder="What this block is for"
              className={cn('w-full px-3 py-2 rounded-lg border bg-transparent text-sm', colors.panelBorder)}
            />
          </div>
          <div>
            <label className={cn('text-xs mb-1 block', colors.textMuted)}>Content</label>
            <textarea
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              placeholder="Block content..."
              className={cn('w-full px-3 py-2 rounded-lg border bg-transparent text-sm', colors.panelBorder)}
              rows={6}
            />
          </div>
          <button
            onClick={handleCreate}
            disabled={!newLabel.trim()}
            className="w-full px-4 py-2 rounded-lg text-sm font-medium bytelight-on-accent disabled:opacity-50"
            style={{ background: colors.accent }}
          >
            <Plus size={14} className="inline mr-1" /> Create Block
          </button>
        </div>
      )}

      {/* Operations (Letta-style) */}
      {tab === 'operations' && (
        <div className="space-y-4">
          <div className={cn('rounded-2xl border p-3 backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
            <label className={cn('text-xs mb-1 block', colors.textMuted)}>Target Block</label>
            <select
              value={opIndex}
              onChange={(e) => setOpIndex(e.target.value)}
              className={cn('w-full px-3 py-2 rounded-lg border bg-transparent text-sm', colors.panelBorder)}
            >
              <option value="">Select a block...</option>
              {blocks.map((b, i) => (
                <option key={blockKey(b)} value={String(i)}>{blockKey(b)}</option>
              ))}
            </select>
          </div>

          {opResult && (
            <div className="p-2 rounded text-xs" style={{ backgroundColor: `${colors.accent}20`, color: colors.accent }}>
              {opResult}
            </div>
          )}

          <div className={cn('p-3 rounded-lg border space-y-2', colors.panelBorder, colors.panelBg)}>
            <div className="text-xs font-medium opacity-70">Append</div>
            <textarea
              value={appendText}
              onChange={(e) => setAppendText(e.target.value)}
              placeholder="Text to append..."
              className="w-full p-2 rounded border bg-transparent text-sm"
              rows={2}
            />
            <button
              onClick={handleAppend}
              disabled={!opTarget || !appendText.trim()}
              className="px-3 py-1.5 rounded text-xs font-medium bytelight-on-accent disabled:opacity-50"
              style={{ background: colors.accent }}
            >
              Append
            </button>
          </div>

          <div className={cn('p-3 rounded-lg border space-y-2', colors.panelBorder, colors.panelBg)}>
            <div className="text-xs font-medium opacity-70">Replace</div>
            <input
              value={replaceOld}
              onChange={(e) => setReplaceOld(e.target.value)}
              placeholder="Text to find..."
              className="w-full p-2 rounded border bg-transparent text-sm"
            />
            <input
              value={replaceNew}
              onChange={(e) => setReplaceNew(e.target.value)}
              placeholder="Replace with..."
              className="w-full p-2 rounded border bg-transparent text-sm"
            />
            <button
              onClick={handleReplace}
              disabled={!opTarget || !replaceOld.trim()}
              className="px-3 py-1.5 rounded text-xs font-medium bytelight-on-accent disabled:opacity-50"
              style={{ background: colors.accent }}
            >
              Replace
            </button>
          </div>

          <div className={cn('p-3 rounded-lg border space-y-2', colors.panelBorder, colors.panelBg)}>
            <div className="text-xs font-medium opacity-70 flex items-center gap-1">
              <RotateCcw size={12} /> Rethink (Full Rewrite)
            </div>
            <textarea
              value={rethinkContent}
              onChange={(e) => setRethinkContent(e.target.value)}
              placeholder="Complete new content..."
              className="w-full p-2 rounded border bg-transparent text-sm"
              rows={4}
            />
            <button
              onClick={handleRethink}
              disabled={!opTarget || !rethinkContent.trim()}
              className="px-3 py-1.5 rounded text-xs font-medium bytelight-on-accent disabled:opacity-50"
              style={{ background: colors.accent }}
            >
              Rethink
            </button>
          </div>
        </div>
      )}
    </AppShell>
  );
}
