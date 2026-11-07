import React, { useEffect, useState } from 'react';
import { Fingerprint, RefreshCw, Loader2, ChevronRight } from 'lucide-react';
import { AppShell } from './AppShell';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import { Paginator, usePaged } from './Paginator';
import { api } from '../bytelight';

interface IdentityAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  embedded?: boolean;
}

interface MemoryFile {
  name: string;
  path: string;
  content: string;
}

// Identity & memory file editors — CLAUDE.md (loaded by both the agent lane
// and the warm heartbeat session) and the warm lane's persistent memory
// files. Formerly the useful half of the X-Ray app.
export function IdentityApp({ onClose, themeConfig, themeMode, embedded }: IdentityAppProps) {
  const colors = themeConfig[themeMode];
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const [identity, setIdentity] = useState<{ content: string; path: string }>({ content: '', path: '' });
  const [memoryIndex, setMemoryIndex] = useState<string | null>(null);
  const [memoryFiles, setMemoryFiles] = useState<MemoryFile[]>([]);
  // Identity drew every memory file it had, with nothing holding it back.
  const memoryPage = usePaged(memoryFiles);
  const [memoryDir, setMemoryDir] = useState('');

  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [expandedMemory, setExpandedMemory] = useState<string | null>(null);
  const [identityOpen, setIdentityOpen] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [idRes, memRes] = await Promise.all([
        api.get('/api/xray/identity'),
        api.get('/api/xray/memory'),
      ]);
      if (!idRes.ok) throw new Error(`identity: ${idRes.status}`);
      if (!memRes.ok) throw new Error(`memory: ${memRes.status}`);
      const id = await idRes.json();
      const mem = await memRes.json();
      setIdentity({ content: id.content || '', path: id.path || '' });
      setMemoryIndex(mem.index ?? null);
      setMemoryFiles(mem.files || []);
      setMemoryDir(mem.memoryDir || '');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load identity data');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function flash(msg: string) {
    setSaveMessage(msg);
    setTimeout(() => setSaveMessage(null), 3000);
  }

  async function save(url: string, onOk: () => void) {
    setSaving(true);
    try {
      const res = await api.put(url, { content: draft });
      if (!res.ok) throw new Error('Failed to save');
      onOk();
      setEditing(null);
      flash('Saved (backup created)');
    } catch (e) {
      flash(`Error: ${e instanceof Error ? e.message : 'save failed'}`);
    } finally {
      setSaving(false);
    }
  }

  const card = cn('rounded-2xl border p-3 backdrop-blur-md', colors.panelBg, colors.panelBorder);
  const codeBlock = cn(
    'rounded-xl border p-2.5 text-[11px] font-mono whitespace-pre-wrap break-words max-h-80 overflow-y-auto',
    colors.panelBorder,
    colors.textMuted,
  );
  const editor = cn(
    'w-full rounded-xl border p-2.5 text-[11px] font-mono bg-transparent',
    colors.panelBorder,
    colors.textMain,
  );

  function editActions(url: string, onOk: () => void) {
    return (
      <div className="flex gap-2 mt-2">
        <button
          onClick={() => save(url, onOk)}
          disabled={saving}
          className="rounded-lg px-3 py-1.5 text-xs font-semibold bytelight-on-accent disabled:opacity-50"
          style={{ background: colors.accent }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={() => setEditing(null)} className={cn('px-2 py-1.5 text-xs', colors.textMuted)}>
          Cancel
        </button>
      </div>
    );
  }

  function editButton(key: string, content: string) {
    return (
      <button
        onClick={() => { setEditing(key); setDraft(content); }}
        className="rounded-lg px-3 py-1.5 text-xs font-semibold bytelight-on-accent mt-2"
        style={{ background: colors.accent }}
      >
        Edit
      </button>
    );
  }

  return (
    <AppShell
      embedded={embedded}
      title="Identity"
      icon={Fingerprint}
      onClose={onClose}
      themeConfig={themeConfig}
      themeMode={themeMode}
      headerRight={
        <button
          onClick={() => load()}
          className={cn('rounded-full p-2 transition-colors hover:bg-black/10 dark:hover:bg-white/10', colors.textMuted)}
          title="Refresh"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
        </button>
      }
    >
      {saveMessage && (
        <p
          className="text-xs mb-2"
          style={{ color: colors.accent, opacity: saveMessage.startsWith('Error') ? 0.8 : 1 }}
        >
          {saveMessage}
        </p>
      )}

      {loading ? (
        <div className={cn(card, 'text-xs py-6 text-center', colors.textMuted)}>Loading…</div>
      ) : error ? (
        <div className={cn(card, 'text-xs py-6 text-center')} style={{ color: colors.accent, opacity: 0.8 }}>{error}</div>
      ) : (
        <>
          {/* CLAUDE.md */}
          <div className={cn(card, 'mb-3')}>
            <button
              onClick={() => setIdentityOpen((o) => !o)}
              className="flex w-full items-center justify-between"
            >
              <div className="min-w-0 text-left">
                <div className={cn('text-sm font-medium', colors.textMain)}>CLAUDE.md</div>
                <div className={cn('text-[10px] font-mono truncate', colors.textMuted)}>{identity.path}</div>
              </div>
              <ChevronRight size={14} className={cn('shrink-0', colors.textMuted, identityOpen && 'rotate-90')} />
            </button>
            {identityOpen && (
              <div className="mt-2">
                {editing === 'identity' ? (
                  <>
                    <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={20} className={editor} />
                    {editActions('/api/xray/identity', () => setIdentity((p) => ({ ...p, content: draft })))}
                  </>
                ) : (
                  <>
                    <pre className={codeBlock}>{identity.content}</pre>
                    {editButton('identity', identity.content)}
                  </>
                )}
              </div>
            )}
          </div>

          {/* Memory files */}
          <div className={cn(card, 'mb-3')}>
            <div className={cn('text-[11px] font-bold uppercase tracking-[0.12em] mb-1', colors.textMuted)}>Warm-lane memory</div>
            <div className={cn('text-[10px] font-mono break-all', colors.textMuted)}>{memoryDir}</div>
          </div>
          {memoryIndex && (
            <div className={cn(card, 'mb-3')}>
              <div className={cn('text-[11px] font-bold uppercase tracking-wide mb-2', colors.textMuted)}>
                MEMORY.md Index
              </div>
              <pre className={codeBlock}>{memoryIndex}</pre>
            </div>
          )}
          {memoryFiles.length === 0 ? (
            <div className={cn(card, 'text-xs py-2 text-center', colors.textMuted)}>No memory files found.</div>
          ) : (
            <div className="space-y-1.5">
              {memoryPage.visible.map((file) => (
                <div key={file.name} className={cn('rounded-2xl border', colors.panelBg, colors.panelBorder)}>
                  <button
                    onClick={() => setExpandedMemory(expandedMemory === file.name ? null : file.name)}
                    className="flex w-full items-center justify-between p-3"
                  >
                    <span className={cn('text-xs font-mono', colors.textMain)}>{file.name}</span>
                    <ChevronRight size={14} className={cn(colors.textMuted, expandedMemory === file.name && 'rotate-90')} />
                  </button>
                  {expandedMemory === file.name && (
                    <div className="px-3 pb-3">
                      {editing === `memory:${file.name}` ? (
                        <>
                          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={14} className={editor} />
                          {editActions(`/api/xray/memory/${encodeURIComponent(file.name)}`, () =>
                            setMemoryFiles((prev) =>
                              prev.map((f) => (f.name === file.name ? { ...f, content: draft } : f)),
                            ),
                          )}
                        </>
                      ) : (
                        <>
                          <pre className={codeBlock}>{file.content}</pre>
                          {editButton(`memory:${file.name}`, file.content)}
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
              <Paginator page={memoryPage.page} pageCount={memoryPage.pageCount} onPage={memoryPage.setPage} colors={colors} />
            </div>
          )}
        </>
      )}
    </AppShell>
  );
}
