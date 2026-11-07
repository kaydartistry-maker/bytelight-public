import React, { useMemo, useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Search, X, Plus, Pin, PinOff, Pencil, Archive, Trash2, MoreVertical, ChevronRight, Check, ArchiveRestore, Home } from 'lucide-react';
import { ThemeConfig, contrastTextColor } from '../lib/theme';
import { cn, withAlpha, stripMarkdown } from '../lib/utils';
import {
  useThreads,
  useActiveThreadId,
  switchThread,
  createThread,
  dropArchivedThread,
  useRoutingThreadId,
  setRoutingThreadId,
  pinThread,
  unpinThread,
  loadThreads,
  apiFetch,
  getState,
} from '../bytelight';
import type { ThreadSummary } from '../bytelight';

export interface CompanionOption {
  id: string;
  display_name: string;
  avatar_url: string | null;
  color: string | null;
  emoji: string | null;
}

interface ThreadSwitcherProps {
  isOpen: boolean;
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  companions?: CompanionOption[];
}

function monthKey(dateStr: string | null): string {
  const d = dateStr ? new Date(dateStr) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key: string): string {
  const [year, month] = key.split('-');
  const d = new Date(parseInt(year, 10), parseInt(month, 10) - 1, 1);
  return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

export function ThreadSwitcher({ isOpen, onClose, themeConfig, themeMode, companions }: ThreadSwitcherProps) {
  const colors = themeConfig[themeMode];
  const threads = useThreads();
  const activeThreadId = useActiveThreadId();

  const [filterQuery, setFilterQuery] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [menuThreadId, setMenuThreadId] = useState<string | null>(null);
  const [collapsedMonths, setCollapsedMonths] = useState<Set<string>>(new Set());
  // BL: the Named group folds like the months, closed by default
  const [namedCollapsed, setNamedCollapsed] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createValue, setCreateValue] = useState('');
  const [selectedCompanions, setSelectedCompanions] = useState<Set<string>>(new Set());
  const [showArchived, setShowArchived] = useState(false);
  const [archivedThreads, setArchivedThreads] = useState<ThreadSummary[]>([]);
  // Home thread (the house icon) — main's routing thread: where Discord,
  // Telegram and autonomous wakes land unless a lane is aimed elsewhere
  // (Integrations → Routing). Arrives on connect and stays live through
  // routing_thread_changed, so every device shows the same Home.
  const homeThreadId = useRoutingThreadId();
  const [homePrompt, setHomePrompt] = useState<{ id: string; name: string } | null>(null);
  async function confirmHome() {
    if (!homePrompt) return;
    try {
      const res = await apiFetch(`/api/threads/${homePrompt.id}/routing`, { method: 'POST' });
      if (res.ok) setRoutingThreadId(homePrompt.id);
    } catch { /* leave as-was */ }
    setHomePrompt(null);
  }

  const currentMonth = monthKey(null);

  const grouped = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    const source = q ? threads.filter((t) => t.name.toLowerCase().includes(q)) : threads;

    if (q) {
      return { filtered: source, pinned: [], today: [], months: [], named: [] };
    }

    const pinned: ThreadSummary[] = [];
    const today: ThreadSummary[] = [];
    const named: ThreadSummary[] = [];
    const monthMap = new Map<string, ThreadSummary[]>();
    const pinnedIds = new Set<string>();

    for (const t of source) {
      if (t.pinned_at) {
        pinned.push(t);
        pinnedIds.add(t.id);
      }
    }
    pinned.sort((a, b) => ((a.pinned_at || '') > (b.pinned_at || '') ? 1 : -1));

    for (const t of source) {
      if (pinnedIds.has(t.id)) continue;
      if (t.type === 'daily') {
        if (t.id === activeThreadId || today.length === 0) {
          today.push(t);
        } else {
          const key = monthKey(t.last_activity_at);
          if (!monthMap.has(key)) monthMap.set(key, []);
          monthMap.get(key)!.push(t);
        }
      } else {
        named.push(t);
      }
    }

    const months = Array.from(monthMap.entries()).sort((a, b) => b[0].localeCompare(a[0]));
    return { filtered: null as ThreadSummary[] | null, pinned, today, months, named };
  }, [threads, filterQuery, activeThreadId]);

  function select(threadId: string) {
    switchThread(threadId);
    onClose();
  }

  function toggleMonth(key: string) {
    setCollapsedMonths((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function commitCreate() {
    const name = createValue.trim();
    if (name) {
      const companionIds = Array.from(selectedCompanions);
      createThread(name, companionIds.length > 0 ? companionIds : undefined);
    }
    setCreateValue('');
    setSelectedCompanions(new Set());
    setCreating(false);
  }

  function startRename(thread: ThreadSummary) {
    setMenuThreadId(null);
    setRenamingId(thread.id);
    setRenameValue(thread.name);
  }

  async function commitRename(threadId: string) {
    const name = renameValue.trim();
    if (name) {
      try {
        await apiFetch(`/api/threads/${threadId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        await loadThreads();
      } catch (err) {
        console.error('Failed to rename thread:', err);
      }
    }
    setRenamingId(null);
  }

  async function confirmDelete(threadId: string) {
    setDeleteConfirmId(null);
    try {
      // Just fire the DELETE — the websocket handler receives thread_deleted
      // and manages thread switching + state cleanup. Doing it here too caused
      // a race condition that crashed React (Jun 21, 2026 bug).
      await apiFetch(`/api/threads/${threadId}`, { method: 'DELETE' });
    } catch (err) {
      console.error('Failed to delete thread:', err);
    }
  }

  async function archive(threadId: string) {
    setMenuThreadId(null);
    try {
      const res = await apiFetch(`/api/threads/${threadId}/archive`, { method: 'POST' });
      if (!res.ok) throw new Error(`Archive failed: ${res.status}`);
      // Main archives without broadcasting thread_archived, so this client
      // owns the switch off the thread (one place: dropArchivedThread).
      dropArchivedThread(threadId);
      await loadThreads();
    } catch (err) {
      console.error('Failed to archive thread:', err);
    }
  }

  // There was no way back. You could see an archived thread and open it, and
  // nothing anywhere put it back in the list.
  async function unarchive(threadId: string) {
    try {
      await apiFetch(`/api/threads/${threadId}/unarchive`, { method: 'POST' });
      setArchivedThreads((prev) => prev.filter((t) => t.id !== threadId));
      await loadThreads();
    } catch (err) {
      console.error('Failed to restore thread:', err);
    }
  }

  async function toggleArchived() {
    const next = !showArchived;
    setShowArchived(next);
    if (next) {
      try {
        const res = await apiFetch('/api/threads/archived');
        if (res.ok) {
          const data = await res.json();
          setArchivedThreads(data.threads || []);
        }
      } catch (err) {
        console.error('Failed to load archived threads:', err);
      }
    }
  }

  const accentHex = colors.accent;

  function renderThread(thread: ThreadSummary) {
    const isActive = thread.id === activeThreadId;

    if (renamingId === thread.id) {
      return (
        <div key={thread.id} className="px-3 py-1.5">
          <input
            autoFocus
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={() => commitRename(thread.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitRename(thread.id); }
              if (e.key === 'Escape') { e.preventDefault(); setRenamingId(null); }
            }}
            className={cn(
              'w-full rounded-xl px-3 py-2 text-sm outline-none border',
              colors.panelBg, colors.panelBorder, colors.textMain,
            )}
          />
        </div>
      );
    }

    if (deleteConfirmId === thread.id) {
      return (
        <div key={thread.id} className="mx-3 my-1.5 rounded-xl p-3" style={{ background: withAlpha(colors.accent, 0.10) }}>
          <p className={cn('text-xs mb-2', colors.textMain)}>Delete thread and all messages?</p>
          <div className="flex gap-2">
            <button
              onClick={() => confirmDelete(thread.id)}
              className="rounded-lg px-3 py-1.5 text-xs font-semibold"
              style={{ background: colors.accent, color: contrastTextColor(colors.accent) }}
            >
              Delete
            </button>
            <button
              onClick={() => setDeleteConfirmId(null)}
              className={cn('rounded-lg px-3 py-1.5 text-xs', colors.textMuted)}
            >
              Cancel
            </button>
          </div>
        </div>
      );
    }

    return (
      <div key={thread.id} className="px-2">
        <div
          className={cn(
            'group relative flex items-center gap-2 rounded-2xl px-3 py-2.5 transition-colors cursor-pointer',
            isActive ? 'bg-black/10 dark:bg-white/10' : 'hover:bg-black/5 dark:hover:bg-white/5',
          )}
          onClick={() => select(thread.id)}
        >
          {isActive && (
            <span className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-1 rounded-full" style={{ background: accentHex }} />
          )}
          {thread.id === homeThreadId && <Home size={12} className="shrink-0" style={{ color: colors.accent }} />}
          {thread.pinned_at && <Pin size={12} className={cn('shrink-0', colors.textMuted)} fill="currentColor" />}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={cn('truncate text-sm font-medium', colors.textMain)}>{thread.name}</span>
              {thread.unread_count > 0 && (
                <span
                  className="ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold"
                  style={{ background: accentHex, color: contrastTextColor(accentHex) }}
                >
                  {thread.unread_count}
                </span>
              )}
            </div>
            {thread.last_message_preview && (
              <p className={cn('truncate text-xs mt-0.5 opacity-70', colors.textMuted)}>
                {stripMarkdown(thread.last_message_preview)}
              </p>
            )}
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setMenuThreadId(menuThreadId === thread.id ? null : thread.id);
            }}
            className={cn('shrink-0 rounded-full p-1 opacity-40 hover:opacity-100 transition-opacity', colors.textMuted)}
          >
            <MoreVertical size={16} />
          </button>
        </div>
        {menuThreadId === thread.id && (
          <div className={cn('mx-3 mb-1 mt-0.5 rounded-xl border p-1', colors.panelBg, colors.panelBorder)}>
            <button
              onClick={() => { setMenuThreadId(null); if (thread.id !== homeThreadId) setHomePrompt({ id: thread.id, name: thread.name }); }}
              className={cn('flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs hover:bg-black/5 dark:hover:bg-white/5', colors.textMain)}
            >
              <Home size={14} style={thread.id === homeThreadId ? { color: colors.accent } : undefined} />
              {thread.id === homeThreadId ? 'Home thread' : 'Make this thread Home'}
            </button>
            <button
              onClick={() => { thread.pinned_at ? unpinThread(thread.id) : pinThread(thread.id); setMenuThreadId(null); }}
              className={cn('flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs hover:bg-black/5 dark:hover:bg-white/5', colors.textMain)}
            >
              {thread.pinned_at ? <PinOff size={14} /> : <Pin size={14} />}
              {thread.pinned_at ? 'Unpin' : 'Pin'}
            </button>
            {/* Every thread can be renamed. Daily threads used to be excluded
                here and nowhere else — the API never minded, and today's daily
                thread is found by its date and type rather than its name, so a
                rename sticks and breaks nothing. Tomorrow still gets a fresh
                one under the default name. */}
            <button
              onClick={() => startRename(thread)}
              className={cn('flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs hover:bg-black/5 dark:hover:bg-white/5', colors.textMain)}
            >
              <Pencil size={14} /> Rename
            </button>
            <button
              onClick={() => archive(thread.id)}
              className={cn('flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs hover:bg-black/5 dark:hover:bg-white/5', colors.textMain)}
            >
              <Archive size={14} /> Archive
            </button>
            <button
              onClick={() => { setMenuThreadId(null); setDeleteConfirmId(thread.id); }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs hover:bg-black/5 dark:hover:bg-white/5"
              style={{ color: colors.accent }}
            >
              <Trash2 size={14} /> Delete
            </button>
          </div>
        )}
      </div>
    );
  }

  function groupTitle(label: string, count?: number) {
    return (
      <div className="flex items-center gap-2 px-4 pt-3 pb-1">
        <span className={cn('text-[10px] font-bold uppercase tracking-[0.12em]', colors.textMuted)}>{label}</span>
        {count !== undefined && <span className={cn('text-[10px] opacity-60', colors.textMuted)}>{count}</span>}
      </div>
    );
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            key="ts-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-30 bg-black/40 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.aside
            key="ts-panel"
            initial={{ x: '-100%' }}
            animate={{ x: 0 }}
            exit={{ x: '-100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            className={cn('absolute inset-y-0 left-0 z-40 flex w-[85%] max-w-sm flex-col border-r', colors.panelBg, colors.panelBorder)}
          >
            <div className="flex items-center justify-between px-4 pb-2" style={{ paddingTop: 'calc(var(--sat) + 0.75rem)' }}>
              <h2 className={cn('text-base font-semibold', colors.textMain)}>Threads</h2>
              <button onClick={onClose} className={cn('rounded-full p-1.5 hover:bg-black/10 dark:hover:bg-white/10', colors.textMuted)}>
                <X size={18} />
              </button>
            </div>

            <div className="px-3 pb-2">
              <div className={cn('flex items-center rounded-xl border px-3 py-2', colors.panelBorder)}>
                <Search size={14} className={cn('mr-2 shrink-0', colors.textMuted)} />
                <input
                  type="text"
                  placeholder="Filter threads..."
                  value={filterQuery}
                  onChange={(e) => setFilterQuery(e.target.value)}
                  className={cn('w-full bg-transparent text-sm outline-none', colors.textMain)}
                />
                {filterQuery && (
                  <button onClick={() => setFilterQuery('')} className={colors.textMuted}>
                    <X size={14} />
                  </button>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto scrollbar-hide pb-2">
              {grouped.filtered ? (
                grouped.filtered.length === 0 ? (
                  <p className={cn('px-4 py-6 text-center text-sm', colors.textMuted)}>No matching threads</p>
                ) : (
                  grouped.filtered.map(renderThread)
                )
              ) : (
                <>
                  {grouped.pinned.length > 0 && (
                    <>
                      {groupTitle('Pinned')}
                      {grouped.pinned.map(renderThread)}
                    </>
                  )}
                  {grouped.today.length > 0 && (
                    <>
                      {groupTitle('Today')}
                      {grouped.today.map(renderThread)}
                    </>
                  )}
                  {grouped.months.map(([key, list]) => {
                    const collapsed = key !== currentMonth ? !collapsedMonths.has(`open:${key}`) : collapsedMonths.has(`closed:${key}`);
                    return (
                      <div key={key}>
                        <button
                          onClick={() => toggleMonth(key !== currentMonth ? `open:${key}` : `closed:${key}`)}
                          className="flex w-full items-center gap-2 px-4 pt-3 pb-1"
                        >
                          <ChevronRight
                            size={12}
                            className={cn('transition-transform', colors.textMuted, !collapsed && 'rotate-90')}
                          />
                          <span className={cn('text-[10px] font-bold uppercase tracking-[0.12em]', colors.textMuted)}>
                            {monthLabel(key)}
                          </span>
                          <span className={cn('text-[10px] opacity-60', colors.textMuted)}>{list.length}</span>
                        </button>
                        {!collapsed && list.map(renderThread)}
                      </div>
                    );
                  })}
                  {grouped.named.length > 0 && (
                    <div>
                      <button
                        onClick={() => setNamedCollapsed(!namedCollapsed)}
                        className="flex w-full items-center gap-2 px-4 pt-3 pb-1"
                      >
                        <ChevronRight
                          size={12}
                          className={cn('transition-transform', colors.textMuted, !namedCollapsed && 'rotate-90')}
                        />
                        <span className={cn('text-[10px] font-bold uppercase tracking-[0.12em]', colors.textMuted)}>
                          Named
                        </span>
                        <span className={cn('text-[10px] opacity-60', colors.textMuted)}>{grouped.named.length}</span>
                      </button>
                      {!namedCollapsed && grouped.named.map(renderThread)}
                    </div>
                  )}
                </>
              )}

              {showArchived && (
                <>
                  {groupTitle('Archived', archivedThreads.length)}
                  {archivedThreads.length === 0 ? (
                    <p className={cn('px-4 py-3 text-center text-xs', colors.textMuted)}>No archived threads</p>
                  ) : (
                    archivedThreads.map((t) => (
                      <div key={t.id} className="flex items-center gap-1 px-2">
                        <button
                          onClick={() => select(t.id)}
                          className={cn('flex min-w-0 flex-1 items-center rounded-2xl px-3 py-2.5 text-left text-sm italic opacity-60 hover:bg-black/5 dark:hover:bg-white/5', colors.textMain)}
                        >
                          <span className="truncate">{t.name}</span>
                        </button>
                        <button
                          onClick={() => unarchive(t.id)}
                          aria-label={`Put ${t.name} back in the list`}
                          title="Put back in the list"
                          className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl opacity-60 hover:bg-black/5 dark:hover:bg-white/5', colors.textMain)}
                        >
                          <ArchiveRestore size={16} />
                        </button>
                      </div>
                    ))
                  )}
                </>
              )}
            </div>

            <div className={cn('border-t', colors.panelBorder)}>
              {creating ? (
                <div className="p-3 space-y-3">
                  <input
                    autoFocus
                    type="text"
                    placeholder="Thread name..."
                    value={createValue}
                    onChange={(e) => setCreateValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); commitCreate(); }
                      if (e.key === 'Escape') { e.preventDefault(); setCreating(false); setCreateValue(''); setSelectedCompanions(new Set()); }
                    }}
                    className={cn('w-full rounded-xl border px-3 py-2 text-sm outline-none', colors.panelBorder, colors.textMain)}
                  />
                  {companions && companions.length > 0 && (
                    <div className="space-y-1.5">
                      <p className={cn('text-[10px] uppercase tracking-wider font-medium', colors.textMuted)}>Who's in this thread?</p>
                      <div className="flex flex-wrap gap-2">
                        {companions.map((companion) => {
                          const isSelected = selectedCompanions.has(companion.id);
                          const companionColor = companion.color || accentHex;
                          return (
                            <button
                              key={companion.id}
                              type="button"
                              onClick={() => {
                                setSelectedCompanions(prev => {
                                  const next = new Set(prev);
                                  if (next.has(companion.id)) next.delete(companion.id);
                                  else next.add(companion.id);
                                  return next;
                                });
                              }}
                              className={cn(
                                'relative flex items-center gap-2 rounded-full px-2 py-1.5 border transition-all',
                                isSelected ? 'border-current' : colors.panelBorder,
                                'hover:opacity-80'
                              )}
                              style={isSelected ? { borderColor: companionColor, color: companionColor } : undefined}
                            >
                              {companion.avatar_url ? (
                                <img
                                  src={companion.avatar_url}
                                  alt={companion.display_name}
                                  className="w-6 h-6 rounded-full object-cover"
                                />
                              ) : (
                                <span
                                  className="flex w-6 h-6 items-center justify-center rounded-full text-xs"
                                  style={{ background: withAlpha(companionColor, 0.2) }}
                                >
                                  {companion.emoji || companion.display_name.charAt(0)}
                                </span>
                              )}
                              <span className={cn('text-xs font-medium', isSelected ? '' : colors.textMain)}>
                                {companion.display_name}
                              </span>
                              {isSelected && (
                                <Check size={12} className="ml-0.5" />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={() => { setCreating(false); setCreateValue(''); setSelectedCompanions(new Set()); }}
                      className={cn('flex-1 rounded-xl py-2 text-xs font-medium', colors.textMuted)}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={commitCreate}
                      disabled={!createValue.trim()}
                      className="flex-1 rounded-xl py-2 text-xs font-semibold disabled:opacity-50"
                      style={{ backgroundColor: accentHex, color: contrastTextColor(accentHex) }}
                    >
                      Create
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex">
                  <button
                    onClick={toggleArchived}
                    className={cn('flex-1 py-3.5 text-xs transition-colors hover:bg-black/5 dark:hover:bg-white/5', colors.textMuted)}
                  >
                    {showArchived ? 'Hide Archive' : 'Archive'}
                  </button>
                  <button
                    onClick={() => setCreating(true)}
                    className={cn('flex flex-1 items-center justify-center gap-1.5 border-l py-3.5 text-xs font-semibold transition-colors hover:bg-black/5 dark:hover:bg-white/5', colors.panelBorder)}
                    style={{ color: accentHex }}
                  >
                    <Plus size={16} /> New Thread
                  </button>
                </div>
              )}
            </div>
            {homePrompt && (
              <div
                className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 px-6"
                onClick={() => setHomePrompt(null)}
              >
                <div
                  className={cn('w-full max-w-xs rounded-2xl border p-5 shadow-2xl', colors.panelBg, colors.panelBorder)}
                  onClick={(e) => e.stopPropagation()}
                >
                  <h3 className={cn('mb-1 text-sm font-bold', colors.textMain)}>Make this thread Home?</h3>
                  <p className={cn('mb-4 text-xs leading-relaxed', colors.textMuted)}>
                    Discord, Telegram and autonomous wakes will land in "{homePrompt.name}" unless a lane is aimed elsewhere in Integrations → Routing.
                  </p>
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => setHomePrompt(null)}
                      className={cn('rounded-lg border px-3 py-1.5 text-xs font-semibold', colors.panelBorder, colors.textMain)}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={confirmHome}
                      className="rounded-lg px-3 py-1.5 text-xs font-bold bytelight-on-accent"
                      style={{ background: colors.accent }}
                    >
                      Make Home
                    </button>
                  </div>
                </div>
              </div>
            )}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
