import React, { useState, useEffect, useCallback } from 'react';
import { Brain, Search, Database, Activity, Trash2, Edit3, Check, X, RefreshCw, Zap, Shield, Archive, Wrench, Network, ChevronDown, ChevronUp, ScrollText } from 'lucide-react';
import { AppShell } from './AppShell';
import { ThemeConfig } from '../lib/theme';
import { Paginator, usePaged } from './Paginator';
import { cn } from '../lib/utils';
import { CortexUrl } from './CortexUrl';

interface CortexAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  embedded?: boolean;
}

type Tab = 'dashboard' | 'vault' | 'ledger' | 'cortex';

interface LedgerEntry {
  id: number; actor: string; action: string; detail: string; metadata_json?: string | null;
  seen_at?: string | null; created_at: string;
}

interface Memory {
  id: string;
  content: string;
  domain?: string;
  created_at: string;
  similarity?: number;
}

interface Principle {
  name: string;
  description: string;
}

interface DomainEntry {
  domain: string;
  count: number;
}

interface BrainStats {
  memoryCount?: number;
  totalMemories?: number;
  conversations?: number;
  totalConversations?: number;
  domains?: Array<DomainEntry | string>;
  lastActivity?: string;
  activeTunnels?: Array<{ concepts: string[] }>;
  principles?: Principle[];
}

interface McpTool {
  name: string;
  description?: string;
}

// Cortex MCP tools — static list from the worker
const CORTEX_TOOLS: McpTool[] = [
  { name: 'remember_thought', description: 'Save a thought, memory, or piece of context to the brain. Use domain to categorize.' },
  { name: 'recall_memories', description: 'Search persistent memory for relevant past thoughts or context.' },
  { name: 'tunnel_state', description: 'Load the current state of a domain — like loading a save game. Shows stage, open questions, decisions made, and last activity.' },
  { name: 'context_recovery', description: 'Full re-entry brief for a domain. Summaries, open questions, recent decisions, recent memories. Use when returning to a topic after time away.' },
  { name: 'switching_cost', description: 'Quantify the cost of switching from one domain to another. Shows open threads and unresolved context.' },
  { name: 'open_threads', description: 'Lists open questions and unresolved threads across all domains.' },
  { name: 'dormant_contexts', description: 'Lists domains that haven\'t been touched in a while.' },
  { name: 'cognitive_patterns', description: 'Analyzes all tunnels and returns a summary of thinking patterns.' },
  { name: 'tunnel_history', description: 'Returns the history of tunnel states for a domain.' },
  { name: 'unified_search', description: 'Search across memories, tunnels, and conversations at once.' },
  { name: 'search_conversations', description: 'Search through raw conversation logs.' },
  { name: 'search_summaries', description: 'Search through tunnel states and summaries.' },
  { name: 'what_do_i_think', description: 'Synthesizes the user\'s opinion on a topic based on memories.' },
  { name: 'what_was_i_thinking', description: 'Explains the rationale behind a past decision.' },
  { name: 'thinking_trajectory', description: 'Shows how the user\'s thinking on a topic has evolved over time.' },
  { name: 'alignment_check', description: 'Checks if a proposed decision aligns with past decisions and principles.' },
  { name: 'brain_stats', description: 'Returns overall statistics about the brain storage.' },
  { name: 'list_principles', description: 'Lists core principles and rules the user has defined.' },
  { name: 'delete_memory', description: 'Remove a specific memory from the persistent brain.' },
  { name: 'update_memory', description: 'Modify an existing memory in the persistent brain.' },
];

export function CortexApp({ onClose, themeConfig, themeMode, embedded }: CortexAppProps) {
  const colors = themeConfig[themeMode];
  const [tab, setTab] = useState<Tab>('dashboard');
  const [isLoading, setIsLoading] = useState(false);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  // The receipts fetch 200 at a time and every one of them rendered.
  const ledgerPage = usePaged(ledger);
  const [roundsRunning, setRoundsRunning] = useState(false);

  // Dashboard state
  const [stats, setStats] = useState<BrainStats | null>(null);
  const [isOnline, setIsOnline] = useState(false);

  // Vault state
  const [memories, setMemories] = useState<Memory[]>([]);
  const [totalMemories, setTotalMemories] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchDomain, setSearchDomain] = useState('');
  const [searchResults, setSearchResults] = useState<Memory[] | null>(null);
  const [searchTotal, setSearchTotal] = useState<number | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const PAGE_SIZE = 20;


  const fetchStats = useCallback(async () => {
    try {
      const [healthRes, statsRes] = await Promise.all([
        fetch('/api/cortex/health', { credentials: 'include' }),
        fetch('/api/cortex/stats', { credentials: 'include' }),
      ]);
      const health = await healthRes.json();
      setIsOnline(health.online);
      if (statsRes.ok) {
        const data = await statsRes.json();
        setStats(data);
      }
    } catch (err) {
      console.error('[Cortex] Failed to fetch stats:', err);
    }
  }, []);

  const fetchMemories = useCallback(async () => {
    setIsLoading(true);
    try {
      // Use direct HTTP endpoint for raw SQL listing (not semantic search)
      const res = await fetch('/api/cortex/memories?limit=500', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        const mems = data.results || [];
        setMemories(mems);
        setTotalMemories(data.total ?? mems.length);
      }
    } catch (err) {
      console.error('[Cortex] Failed to fetch memories:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  useEffect(() => {
    if (tab === 'vault') fetchMemories();
  }, [tab, fetchMemories]);

  const fetchLedger = useCallback(async () => {
    const res = await fetch('/api/cortex/ledger?limit=200', { credentials: 'include' });
    if (res.ok) {
      const entries: LedgerEntry[] = (await res.json()).entries || [];
      setLedger(entries);
      if (entries[0]?.id) void fetch('/api/cortex/ledger/seen', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ throughId: entries[0].id }),
      });
    }
  }, []);

  useEffect(() => { if (tab === 'ledger') void fetchLedger(); }, [tab, fetchLedger]);

  const handleSearch = async (e?: React.FormEvent, domainOverride?: string) => {
    e?.preventDefault();
    const domain = domainOverride ?? searchDomain;
    if (!searchQuery.trim() && !domain.trim()) return;
    setIsSearching(true);
    vaultPage.setPage(1);
    try {
      // Use type=memories for semantic search; use common word "the" as catch-all when no query
      // (Cortex doesn't support * wildcards — it's semantic search, so "the" matches most entries)
      const q = searchQuery.trim() || 'the';
      let url = `/api/cortex/search?type=memories&q=${encodeURIComponent(q)}&limit=100`;
      if (domain.trim()) url += `&domain=${encodeURIComponent(domain)}`;
      const res = await fetch(url, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setSearchResults(Array.isArray(data) ? data : (data.results || data.memories || []));
      }
    } catch (err) {
      console.error('[Cortex] Search failed:', err);
    } finally {
      setIsSearching(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this memory?')) return;
    try {
      await fetch(`/api/cortex/memory/${id}`, { method: 'DELETE', credentials: 'include' });
      setMemories((prev) => prev.filter((m) => m.id !== id));
      if (searchResults) setSearchResults((prev) => prev?.filter((m) => m.id !== id) || null);
      fetchStats();
    } catch (err) {
      console.error('[Cortex] Delete failed:', err);
    }
  };

  const handleSaveEdit = async (id: string) => {
    try {
      await fetch(`/api/cortex/memory/${id}`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editContent }),
      });
      setMemories((prev) => prev.map((m) => (m.id === id ? { ...m, content: editContent } : m)));
      setEditingId(null);
    } catch (err) {
      console.error('[Cortex] Edit failed:', err);
    }
  };

  const handleDomainClick = async (domain: string) => {
    setSearchDomain(domain);
    setSearchQuery('');
    setIsSearching(true);
    vaultPage.setPage(1);
    try {
      // Use direct HTTP endpoint for raw SQL listing (not semantic search)
      const res = await fetch(`/api/cortex/domain/${encodeURIComponent(domain)}/memories?limit=500`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setSearchResults(data.results || []);
        setSearchTotal(data.total ?? (data.results?.length || 0));
      }
    } catch (err) {
      console.error('[Cortex] Domain fetch failed:', err);
    } finally {
      setIsSearching(false);
    }
  };

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Extract active concepts from stats
  const activeConcepts = stats?.activeTunnels?.flatMap((t) => t.concepts).slice(0, 15) || [];

  // Normalize domains to include counts
  const domains: DomainEntry[] = (stats?.domains || []).map((d) =>
    typeof d === 'string' ? { domain: d, count: 0 } : d
  );

  // Entries to display (search results or all memories) with pagination
  const allEntries = searchResults ?? memories;
  // Use real total from API for display; entries.length for pagination of loaded data
  const displayTotal = searchResults !== null ? (searchTotal ?? searchResults.length) : totalMemories;
  // The vault had its own Previous/Next from before the shared paginator existed —
  // the last screen in the house stepping one page at a time rather than offering
  // numbers to jump between. Same component as everywhere else now.
  const vaultPage = usePaged(allEntries, PAGE_SIZE);
  const totalPages = vaultPage.pageCount;
  const displayEntries = vaultPage.visible;

  const TABS: { id: Tab; label: string; icon: typeof Brain }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: Activity },
    { id: 'vault', label: 'Vault', icon: Database },
    { id: 'ledger', label: 'Ledger', icon: ScrollText },
    { id: 'cortex', label: 'Tools', icon: Wrench },
  ];

  const renderMemoryCard = (m: Memory) => {
    const isExpanded = expandedIds.has(m.id);
    const needsTruncate = m.content.length > 200;
    const displayContent = isExpanded || !needsTruncate ? m.content : `${m.content.substring(0, 200)}...`;

    return (
      <div key={m.id} className={cn('p-3 rounded-lg border', colors.panelBorder, colors.panelBg)}>
        {editingId === m.id ? (
          <div className="space-y-2">
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="w-full p-2 rounded border bg-transparent text-sm"
              rows={5}
            />
            <div className="flex gap-2">
              <button onClick={() => handleSaveEdit(m.id)} className="p-1.5 rounded" style={{ backgroundColor: colors.accent, color: 'var(--bytelight-on-accent)' }}>
                <Check size={14} />
              </button>
              <button onClick={() => setEditingId(null)} className="p-1.5 rounded opacity-60" style={{ backgroundColor: colors.accent, color: 'var(--bytelight-on-accent)' }}>
                <X size={14} />
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm whitespace-pre-wrap leading-relaxed">{displayContent}</p>

            {needsTruncate && (
              <button
                onClick={() => toggleExpand(m.id)}
                className="flex items-center gap-1 mt-2 text-xs opacity-70 hover:opacity-100"
                style={{ color: colors.accent }}
              >
                {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                {isExpanded ? 'Show Less' : 'Show More'}
              </button>
            )}

            {/* ID + Domain + Date row */}
            <div className="flex flex-wrap items-center gap-2 mt-3 text-[10px] opacity-60 uppercase tracking-wider">
              <span className="px-1.5 py-0.5 rounded" style={{ background: 'rgba(127,127,127,0.2)' }}>
                ID: {m.id.substring(0, 8)}...
              </span>
              <span>•</span>
              <span style={{ color: colors.accent }}>Domain: {m.domain || 'general'}</span>
              {m.created_at && (
                <>
                  <span>•</span>
                  <span>{new Date(m.created_at.replace(' ', 'T') + 'Z').toLocaleString()}</span>
                </>
              )}
            </div>

            {/* Edit/Delete buttons */}
            <div className="flex gap-2 mt-2 pt-2 border-t border-white/10">
              <button
                onClick={() => { setEditingId(m.id); setEditContent(m.content); }}
                className="p-1.5 rounded hover:bg-white/10 transition-colors"
                title="Edit"
              >
                <Edit3 size={14} />
              </button>
              <button
                onClick={() => handleDelete(m.id)}
                className="p-1.5 rounded hover:bg-red-500/20 transition-colors"
                style={{ color: colors.accent }}
                title="Delete"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <AppShell embedded={embedded} title="Cortex" icon={Brain} onClose={onClose} themeConfig={themeConfig} themeMode={themeMode}>
      {/* Tab bar */}
      <div className={cn("p-3 rounded-2xl border backdrop-blur-md mb-4 flex justify-center", colors.panelBg, colors.panelBorder)}>
        <div className="flex gap-1.5 overflow-x-auto scrollbar-hide">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn('shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors border flex items-center gap-1.5', colors.panelBorder, tab !== t.id && colors.panelBg)}
              style={tab === t.id ? { background: colors.accent, color: 'var(--bytelight-on-accent)', borderColor: colors.accent } : undefined}
            >
              <t.icon size={14} />
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Dashboard */}
      {tab === 'dashboard' && (
        <div className={cn("space-y-4 p-4 rounded-2xl border backdrop-blur-md", colors.panelBg, colors.panelBorder)}>
          {/* Connection status */}
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: colors.accent, opacity: isOnline ? 1 : 0.4 }} />
            <span className="text-sm">{isOnline ? 'Connected' : 'Offline'}</span>
            <button onClick={fetchStats} className="ml-auto p-1.5 rounded hover:bg-white/10">
              <RefreshCw size={14} />
            </button>
          </div>

          <CortexUrl themeConfig={themeConfig} themeMode={themeMode} onSaved={fetchStats} />

          {stats && (
            <>
              {/* Stats cards */}
              <div className="grid grid-cols-2 gap-3">
                <div className={cn('p-3 rounded-lg border', colors.panelBorder, colors.panelBg)}>
                  <div className="text-2xl font-bold">{stats.memoryCount ?? stats.totalMemories ?? 0}</div>
                  <div className="text-xs opacity-70">Memories</div>
                </div>
                <div className={cn('p-3 rounded-lg border', colors.panelBorder, colors.panelBg)}>
                  <div className="text-2xl font-bold">{stats.conversations ?? stats.totalConversations ?? 0}</div>
                  <div className="text-xs opacity-70">Conversations</div>
                </div>
              </div>

              {/* Domains tag cloud */}
              {domains.length > 0 && (
                <div className={cn('p-3 rounded-lg border', colors.panelBorder, colors.panelBg)}>
                  <div className="text-xs opacity-70 mb-2">Domains</div>
                  <div className="flex flex-wrap gap-1">
                    {domains.map((d, i) => (
                      <span key={i} className="px-2 py-0.5 text-xs rounded-full" style={{ background: colors.accent + '30' }}>
                        {d.domain}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Active Concepts */}
              {activeConcepts.length > 0 && (
                <div className={cn('p-3 rounded-lg border', colors.panelBorder, colors.panelBg)}>
                  <div className="flex items-center gap-1.5 mb-2 text-xs opacity-70">
                    <Zap size={12} />
                    <span>Active Concepts</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {activeConcepts.map((concept, i) => (
                      <button
                        key={i}
                        onClick={() => {
                          setSearchQuery(concept);
                          setTab('vault');
                        }}
                        className="px-2 py-0.5 text-xs rounded-full transition-colors hover:opacity-80 border"
                        style={{ borderColor: colors.accent + '50' }}
                      >
                        {concept}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Principles */}
              {stats.principles && stats.principles.length > 0 && (
                <div className={cn('p-3 rounded-lg border', colors.panelBorder, colors.panelBg)}>
                  <div className="flex items-center gap-1.5 mb-2 text-xs opacity-70">
                    <Shield size={12} />
                    <span>Principles</span>
                  </div>
                  <div className="space-y-2">
                    {stats.principles.map((p, i) => (
                      <div key={i}>
                        <div className="text-xs font-medium" style={{ color: colors.accent }}>{p.name}</div>
                        <div className="text-[10px] opacity-70 leading-relaxed">{p.description}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Vault — Search + Entries + Domain Explorer */}
      {tab === 'vault' && (
        <div className="space-y-4">
          {/* Search */}
          <div className={cn('p-3 rounded-lg border', colors.panelBorder, colors.panelBg)}>
            <div className="flex items-center gap-1.5 mb-2 text-xs opacity-70">
              <Search size={12} />
              <span>Search Knowledge Base</span>
            </div>
            <form onSubmit={handleSearch} className="space-y-2">
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search past thoughts, decisions, or context..."
                className={cn('w-full px-3 py-2 rounded-lg border bg-transparent text-sm', colors.panelBorder)}
              />
              <div className="flex gap-2">
                <input
                  value={searchDomain}
                  onChange={(e) => setSearchDomain(e.target.value)}
                  placeholder="Domain (optional)..."
                  className={cn('flex-1 px-3 py-2 rounded-lg border bg-transparent text-sm', colors.panelBorder)}
                />
                <button
                  type="submit"
                  disabled={isSearching || (!searchQuery.trim() && !searchDomain.trim())}
                  className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
                  style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}
                >
                  {isSearching ? '...' : 'Search'}
                </button>
              </div>
            </form>
            {searchResults !== null && (
              <button
                onClick={() => { setSearchResults(null); setSearchTotal(null); setSearchQuery(''); setSearchDomain(''); }}
                className="mt-2 text-xs opacity-70 hover:opacity-100"
              >
                Clear search
              </button>
            )}
          </div>

          {/* Memory count + pagination info */}
          <div className={cn('rounded-2xl border p-3 backdrop-blur-md text-xs flex items-center justify-between', colors.panelBg, colors.panelBorder, colors.textMuted)}>
            <span>{displayTotal} {searchResults !== null ? 'results' : 'memories'}</span>
            {totalPages > 1 && (
              <span>Page {vaultPage.page} of {totalPages}</span>
            )}
          </div>

          {/* Entries */}
          <div className="space-y-2">
            {isLoading ? (
              <div className="text-center py-8 opacity-50">Loading memories...</div>
            ) : displayEntries.length === 0 ? (
              <div className="text-center py-8 opacity-50">
                {searchResults !== null ? 'No results found' : 'No memories yet'}
              </div>
            ) : (
              displayEntries.map(renderMemoryCard)
            )}
          </div>

          <Paginator page={vaultPage.page} pageCount={vaultPage.pageCount} onPage={vaultPage.setPage} colors={colors} />

          {/* Domain Explorer */}
          {domains.length > 0 && (
            <div className={cn('p-3 rounded-lg border', colors.panelBorder, colors.panelBg)}>
              <div className="flex items-center gap-1.5 mb-3 text-xs opacity-70">
                <Database size={12} />
                <span>Domain Explorer</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {domains.map((d, i) => (
                  <button
                    key={i}
                    onClick={() => handleDomainClick(d.domain)}
                    className={cn('p-3 rounded-lg border text-center transition-all hover:scale-[1.02]', colors.panelBorder)}
                  >
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center mx-auto mb-1.5" style={{ background: colors.accent + '20' }}>
                      <Archive size={14} style={{ color: colors.accent }} />
                    </div>
                    <div className="text-xs font-medium truncate">{d.domain}</div>
                    {d.count > 0 && (
                      <div className="text-[10px] opacity-50">{d.count} entries</div>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'ledger' && (
        <div className="space-y-3">
          <div className={cn('p-3 rounded-2xl border flex items-center gap-3', colors.panelBg, colors.panelBorder)}>
            <div className="flex-1">
              <div className="text-sm font-medium">Memory receipts</div>
              <div className="text-xs opacity-60">What surfaced, changed, or was checked—without copying memory bodies.</div>
            </div>
            <button
              disabled={roundsRunning}
              onClick={async () => {
                setRoundsRunning(true);
                try { await fetch('/api/cortex/rounds', { method: 'POST', credentials: 'include' }); await fetchLedger(); }
                finally { setRoundsRunning(false); }
              }}
              className="px-3 py-2 rounded-lg text-xs font-medium disabled:opacity-50"
              style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}
            >{roundsRunning ? 'Walking…' : 'Run rounds'}</button>
          </div>
          {ledger.length === 0 ? <div className="text-center py-8 opacity-50">No receipts yet</div> : ledgerPage.visible.map(entry => (
            <div key={entry.id} className={cn('p-3 rounded-xl border', colors.panelBg, colors.panelBorder)}>
              <div className="flex items-center justify-between gap-2">
                <code className="text-xs" style={{ color: colors.accent }}>{entry.action}</code>
                <span className="text-[10px] opacity-50">{new Date(entry.created_at).toLocaleString()}</span>
              </div>
              <div className="text-xs mt-1.5 leading-relaxed">{entry.detail}</div>
              <div className="text-[10px] opacity-50 mt-1">{entry.actor}</div>
            </div>
          ))}
          <Paginator page={ledgerPage.page} pageCount={ledgerPage.pageCount} onPage={ledgerPage.setPage} colors={colors} />
        </div>
      )}

      {/* Cortex — Tools & System Info */}
      {tab === 'cortex' && (
        <div className="space-y-4">
          {/* System Capabilities — moved above MCP tools */}
          <div className={cn('p-3 rounded-2xl border backdrop-blur-md space-y-3', colors.panelBg, colors.panelBorder)}>
            <div className={cn('p-3 rounded-xl border', colors.panelBorder)}>
              <Brain size={16} style={{ color: colors.accent }} className="mb-2" />
              <div className="text-sm font-medium mb-1">Cognitive Memory</div>
              <div className="text-xs opacity-70 leading-relaxed">
                The system uses vector embeddings to understand the semantic meaning of your thoughts, allowing for context-aware recall.
              </div>
            </div>

            <div className={cn('p-3 rounded-xl border', colors.panelBorder)}>
              <Network size={16} style={{ color: colors.accent }} className="mb-2" />
              <div className="text-sm font-medium mb-1">Domain Tunnels</div>
              <div className="text-xs opacity-70 leading-relaxed">
                Information is automatically grouped into "tunnels" to maintain focus and reduce cognitive switching costs.
              </div>
            </div>

            <div className={cn('p-3 rounded-xl border', colors.panelBorder)}>
              <Shield size={16} style={{ color: colors.accent }} className="mb-2" />
              <div className="text-sm font-medium mb-1">Principle Extraction</div>
              <div className="text-xs opacity-70 leading-relaxed">
                The system identifies recurring patterns and core principles in your thinking to build a more robust mental model.
              </div>
            </div>
          </div>

          {/* Available MCP Tools */}
          <div className={cn('p-3 rounded-2xl border backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-1.5 text-xs opacity-70">
                <Wrench size={12} />
                <span>Available MCP Tools</span>
              </div>
              <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px]" style={{ background: colors.accent + '20', color: colors.accent }}>
                <div className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: colors.accent }} />
                System Active
              </div>
            </div>
            <div className="space-y-2">
              {CORTEX_TOOLS.map((tool) => (
                <div key={tool.name} className={cn('p-3 rounded-xl border', colors.panelBorder)} style={{ background: 'rgba(127,127,127,0.05)' }}>
                  <code className="text-xs font-mono px-1.5 py-0.5 rounded" style={{ background: colors.accent + '20', color: colors.accent }}>
                    {tool.name}
                  </code>
                  {tool.description && (
                    <p className="text-xs opacity-70 mt-1.5 leading-relaxed">{tool.description}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
