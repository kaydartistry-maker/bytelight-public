import React, { useEffect, useState } from 'react';
import { ScanSearch } from 'lucide-react';
import { AppShell } from './AppShell';
import { ThemeConfig } from '../lib/theme';
import { apiFetch } from '../bytelight';

// X-RAY — a TRANSLATION of BL main's XRayPanel.svelte, not a reinterpretation.
// Same six sections (Identity / Memory / Wakes / Context / Hooks / Activity),
// same class vocabulary (.xray-panel, .nav-btn, .collapse-block, .hook-item,
// .audit-row …) so the ported stylesheet and the Cosmos glass block land
// exactly as they did in the Svelte house. Only the framework syntax changed.

interface MemoryFile { name: string; path: string; content: string }
interface WakePrompts { rawContent: string | null; prompts: Record<string, string>; path: string }
interface OrientationPart { label: string; content: string }
interface ContextInfo {
  parts: OrientationPart[];
  raw: string;
  identity: { companion_name: string; user_name: string; timezone: string };
  meta: { threadName: string; platform: string; includeStatic: boolean; generatedAt: string };
}
type TriggerCondition =
  | { type: 'presence_state'; state: string }
  | { type: 'presence_transition'; from: string; to: string }
  | { type: 'agent_free' }
  | { type: 'time_window'; after: string; before?: string }
  | { type: 'routine_missing'; routine: string; after_hour: number };
interface Trigger {
  id: string; kind: 'impulse' | 'watcher'; label: string; conditions: string;
  prompt: string | null; thread_id: string | null; cooldown_minutes: number;
  status: 'pending' | 'waiting' | 'fired' | 'cancelled';
  last_fired_at: string | null; fire_count: number; created_at: string; fired_at: string | null;
}
interface AuditEntry {
  id: string; session_id: string; thread_id: string; tool_name: string;
  tool_input: string | null; tool_output: string | null;
  triggering_message_id: string | null; created_at: string;
}

type Section = 'identity' | 'memory' | 'wakes' | 'context' | 'hooks' | 'activity';
const COLLAPSE_PREFIX = 'xray:collapse:';

function smartCollapsedDefault(content: string): boolean {
  return content.length > 150 || content.split('\n').length > 3;
}
function summaryLine(content: string): string {
  const first = content.split('\n').find((l) => l.trim().length > 0) ?? '';
  return first.length > 60 ? first.slice(0, 60) + '…' : first;
}
function auditStatus(output: string | null): 'ok' | 'error' | 'neutral' {
  if (!output || output.trim() === '') return 'neutral';
  return output.startsWith('[ERROR]') ? 'error' : 'ok';
}
function parseToolName(raw: string): { server: string | null; tool: string } {
  const m = raw.match(/^mcp__(.+?)__(.+)$/);
  if (m) return { server: m[1], tool: m[2] };
  return { server: null, tool: raw };
}
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
function errorSummary(output: string): string {
  const body = output.replace(/^\[ERROR\]\s*/, '');
  const firstLine = body.split('\n').find((l) => l.trim().length > 0) ?? body;
  const trimmed = firstLine.trim();
  return trimmed.length > 80 ? trimmed.slice(0, 80) + '…' : trimmed;
}
function parseConditions(json: string): TriggerCondition[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
function describeCondition(c: TriggerCondition): string {
  switch (c.type) {
    case 'presence_state': return `presence is ${c.state}`;
    case 'presence_transition': return `presence goes ${c.from} → ${c.to}`;
    case 'agent_free': return 'agent is free';
    case 'time_window': return c.before ? `between ${c.after} and ${c.before}` : `after ${c.after}`;
    case 'routine_missing': return `routine "${c.routine}" missing after ${c.after_hour}:00`;
    default: return JSON.stringify(c);
  }
}
function conditionSummary(json: string): string {
  const cs = parseConditions(json);
  return cs.length ? cs.map(describeCondition).join(' AND ') : 'no conditions';
}
function lastFired(t: Trigger): string {
  const v = t.last_fired_at ?? t.fired_at;
  return v ? new Date(v).toLocaleString() : 'never';
}
async function fetchXray(path: string) {
  const res = await apiFetch(`/api/xray/${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

interface XRayAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

export function XRayApp({ onClose, themeConfig, themeMode }: XRayAppProps) {
  const [activeSection, setActiveSection] = useState<Section>('identity');

  const [identityContent, setIdentityContent] = useState('');
  const [identityPath, setIdentityPath] = useState('');
  const [identityEditing, setIdentityEditing] = useState(false);
  const [identityDraft, setIdentityDraft] = useState('');

  const [memoryIndex, setMemoryIndex] = useState<string | null>(null);
  const [memoryFiles, setMemoryFiles] = useState<MemoryFile[]>([]);
  const [memoryDir, setMemoryDir] = useState('');
  const [nativeMemoryIndex, setNativeMemoryIndex] = useState<string | null>(null);
  const [nativeMemoryFiles, setNativeMemoryFiles] = useState<MemoryFile[]>([]);
  const [nativeMemoryDir, setNativeMemoryDir] = useState('');
  const [expandedMemory, setExpandedMemory] = useState<string | null>(null);
  const [memoryEditing, setMemoryEditing] = useState<string | null>(null);
  const [memoryDraft, setMemoryDraft] = useState('');

  const [wakesData, setWakesData] = useState<WakePrompts | null>(null);
  const [wakesEditing, setWakesEditing] = useState(false);
  const [wakesDraft, setWakesDraft] = useState('');

  const [contextInfo, setContextInfo] = useState<ContextInfo | null>(null);
  const [contextView, setContextView] = useState<'structured' | 'raw'>('structured');
  const [contextPlatform, setContextPlatform] = useState<'web' | 'telegram' | 'discord'>('web');
  const [contextStatic, setContextStaticState] = useState(true);
  const [contextLoading, setContextLoading] = useState(false);

  const [collapseState, setCollapseState] = useState<Record<string, boolean>>({});

  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [expandedTrigger, setExpandedTrigger] = useState<string | null>(null);
  const [rawConditions, setRawConditions] = useState<Set<string>>(new Set());

  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [auditLimit, setAuditLimit] = useState(100);
  const [auditFilter, setAuditFilter] = useState<'all' | 'errors'>('all');
  const [auditSearch, setAuditSearch] = useState('');
  const [expandedAudit, setExpandedAudit] = useState<string | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  function isCollapsed(key: string, content: string): boolean {
    const explicit = collapseState[key];
    return explicit === undefined ? smartCollapsedDefault(content) : explicit;
  }
  function toggleCollapse(key: string, content: string) {
    const next = !isCollapsed(key, content);
    setCollapseState((prev) => ({ ...prev, [key]: next }));
    try { localStorage.setItem(COLLAPSE_PREFIX + key, next ? '1' : '0'); } catch {}
  }
  function hydrateCollapse() {
    try {
      const next: Record<string, boolean> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(COLLAPSE_PREFIX)) next[k.slice(COLLAPSE_PREFIX.length)] = localStorage.getItem(k) === '1';
      }
      setCollapseState(next);
    } catch {}
  }

  async function loadContext(platform = contextPlatform, includeStatic = contextStatic) {
    setContextLoading(true);
    try {
      setContextInfo(await fetchXray(`context?platform=${platform}&includeStatic=${includeStatic}`));
    } catch (e: any) { setError(e.message); }
    setContextLoading(false);
  }
  function setPlatform(p: 'web' | 'telegram' | 'discord') { setContextPlatform(p); loadContext(p, contextStatic); }
  function setContextStatic(s: boolean) { setContextStaticState(s); loadContext(contextPlatform, s); }

  async function loadAudit(limit = auditLimit) {
    setAuditLoading(true);
    try {
      const res = await apiFetch(`/api/audit?limit=${limit}`);
      if (!res.ok) throw new Error(`audit: ${res.status}`);
      setAuditEntries((await res.json()).entries || []);
    } catch (e: any) { setError(e.message); }
    setAuditLoading(false);
  }
  function loadMoreAudit() { const n = auditLimit + 100; setAuditLimit(n); loadAudit(n); }

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const [identity, memory, wakes, context, hooks, audit] = await Promise.all([
        fetchXray('identity'),
        fetchXray('memory'),
        fetchXray('wakes'),
        fetchXray(`context?platform=${contextPlatform}&includeStatic=${contextStatic}`),
        fetchXray('hooks'),
        apiFetch(`/api/audit?limit=${auditLimit}`).then((r) => r.json()),
      ]);
      setIdentityContent(identity.content || '');
      setIdentityPath(identity.path || '');
      setMemoryIndex(memory.index);
      setMemoryFiles(memory.files || []);
      setMemoryDir(memory.memoryDir || '');
      setNativeMemoryIndex(memory.native?.index ?? null);
      setNativeMemoryFiles(memory.native?.files || []);
      setNativeMemoryDir(memory.native?.memoryDir || '');
      setWakesData(wakes);
      setContextInfo(context);
      setTriggers(hooks.triggers || []);
      setAuditEntries(audit.entries || []);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  }

  useEffect(() => {
    hydrateCollapse();
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function putXray(url: string, content: string, after: () => void) {
    setSaving(true);
    setSaveMessage(null);
    try {
      const res = await apiFetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) throw new Error('Failed to save');
      after();
      setSaveMessage('Saved (backup created)');
      setTimeout(() => setSaveMessage(null), 3000);
    } catch (e: any) { setSaveMessage(`Error: ${e.message}`); }
    setSaving(false);
  }

  const filteredAudit = auditEntries.filter((e) => {
    const q = auditSearch.trim().toLowerCase();
    if (auditFilter === 'errors' && auditStatus(e.tool_output) !== 'error') return false;
    if (q && !e.tool_name.toLowerCase().includes(q)) return false;
    return true;
  });

  // BL's reusable collapsible block, snippet → component
  function CollapsibleBlock({ k, label, content }: { k: string; label: string; content: string }) {
    const collapsed = isCollapsed(k, content);
    return (
      <div className="collapse-block">
        <button type="button" className="collapse-header" onClick={() => toggleCollapse(k, content)}>
          <span className="collapse-label">{label}</span>
          <span className="collapse-right">
            {collapsed && <span className="collapse-summary">{summaryLine(content)}</span>}
            <span className="collapse-chevron">{collapsed ? '▶' : '▼'}</span>
          </span>
        </button>
        {!collapsed && <pre className="code-block small">{content}</pre>}
      </div>
    );
  }

  return (
    <AppShell title="X-Ray" icon={ScanSearch} onClose={onClose} themeConfig={themeConfig} themeMode={themeMode}>
      <div className="xray-panel">
        <nav className="xray-nav">
          {(['identity', 'memory', 'wakes', 'context', 'hooks', 'activity'] as Section[]).map((s) => (
            <button key={s} type="button" className={`nav-btn${activeSection === s ? ' active' : ''}`} onClick={() => setActiveSection(s)}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </nav>

        {loading ? (
          <div className="loading">Loading X-Ray data...</div>
        ) : error ? (
          <div className="error">{error}</div>
        ) : (
          <>
            {saveMessage && <div className={`save-message${saveMessage.startsWith('Error') ? ' error' : ''}`}>{saveMessage}</div>}

            {activeSection === 'identity' && (
              <section className="section">
                <div className="section-header">
                  <h3 className="section-title">CLAUDE.md</h3>
                  <span className="section-path">{identityPath}</span>
                </div>
                {identityEditing ? (
                  <>
                    <textarea className="code-editor" value={identityDraft} onChange={(e) => setIdentityDraft(e.target.value)} rows={25} />
                    <div className="edit-actions">
                      <button className="res-btn res-btn--primary" onClick={() => putXray('/api/xray/identity', identityDraft, () => { setIdentityContent(identityDraft); setIdentityEditing(false); })} disabled={saving}>
                        {saving ? 'Saving...' : 'Save'}
                      </button>
                      <button className="res-btn res-btn--ghost" onClick={() => setIdentityEditing(false)}>Cancel</button>
                    </div>
                  </>
                ) : (
                  <>
                    <pre className="code-block">{identityContent}</pre>
                    <button className="res-btn res-btn--primary" onClick={() => { setIdentityDraft(identityContent); setIdentityEditing(true); }}>Edit</button>
                  </>
                )}
              </section>
            )}

            {activeSection === 'memory' && (
              <section className="section">
                <div className="section-header">
                  <h3 className="section-title">Native Claude Memory</h3>
                  <span className="section-path">{nativeMemoryDir}</span>
                </div>
                <p className="description">This is Claude's file-backed memory for this project. It lives outside the repository and is the memory Claude can update across native Claude sessions.</p>
                {nativeMemoryIndex ? (
                  <div className="memory-index">
                    <h4>MEMORY.md Index</h4>
                    <pre className="code-block small">{nativeMemoryIndex}</pre>
                  </div>
                ) : (
                  <p className="muted">No MEMORY.md index file yet.</p>
                )}
                {nativeMemoryFiles.length === 0 ? (
                  <p className="muted">No memory files found.</p>
                ) : (
                  <div className="memory-list">
                    {nativeMemoryFiles.map((file) => (
                      <div key={file.name} className="memory-item">
                        <button className="memory-header" onClick={() => setExpandedMemory(expandedMemory === file.name ? null : file.name)}>
                          <span className="memory-name">{file.name}</span>
                          <span className="memory-toggle">{expandedMemory === file.name ? '▼' : '▶'}</span>
                        </button>
                        {expandedMemory === file.name && (
                          <div className="memory-content">
                            <pre className="code-block small">{file.content}</pre>
                            <span className="muted">Read-only view</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <div className="section-header" style={{ marginTop: '2rem' }}>
                  <h3 className="section-title">Repo / Plugin Memory</h3>
                  <span className="section-path">{memoryDir}</span>
                </div>
                <p className="description">These are ByteLight's checked-out skills and plugin memory files. They are separate from native Claude memory.</p>
                {memoryIndex && (
                  <div className="memory-index">
                    <h4>MEMORY.md Index</h4>
                    <pre className="code-block small">{memoryIndex}</pre>
                  </div>
                )}
                {memoryFiles.map((file) => (
                  <div key={file.name} className="memory-item">
                    <button className="memory-header" onClick={() => setExpandedMemory(expandedMemory === `repo:${file.name}` ? null : `repo:${file.name}`)}>
                      <span className="memory-name">{file.name}</span>
                      <span className="memory-toggle">{expandedMemory === `repo:${file.name}` ? '▼' : '▶'}</span>
                    </button>
                    {expandedMemory === `repo:${file.name}` && (
                      <div className="memory-content">
                        {memoryEditing === file.name ? (
                          <>
                            <textarea className="code-editor" value={memoryDraft} onChange={(e) => setMemoryDraft(e.target.value)} rows={15} />
                            <div className="edit-actions">
                              <button className="res-btn res-btn--primary" onClick={() => putXray(`/api/xray/memory/${encodeURIComponent(file.name)}`, memoryDraft, () => { setMemoryFiles(memoryFiles.map((f) => f.name === file.name ? { ...f, content: memoryDraft } : f)); setMemoryEditing(null); })} disabled={saving}>
                                {saving ? 'Saving...' : 'Save'}
                              </button>
                              <button className="res-btn res-btn--ghost" onClick={() => setMemoryEditing(null)}>Cancel</button>
                            </div>
                          </>
                        ) : (
                          <>
                            <pre className="code-block small">{file.content}</pre>
                            <button className="res-btn res-btn--ghost res-btn--sm" onClick={() => { setMemoryDraft(file.content); setMemoryEditing(file.name); }}>Edit</button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </section>
            )}

            {activeSection === 'wakes' && (
              <section className="section">
                <div className="section-header">
                  <h3 className="section-title">Wake Prompts</h3>
                  <span className="section-path">{wakesData?.path}</span>
                </div>
                {wakesEditing ? (
                  <>
                    <textarea className="code-editor" value={wakesDraft} onChange={(e) => setWakesDraft(e.target.value)} rows={25} />
                    <div className="edit-actions">
                      <button className="res-btn res-btn--primary" onClick={() => putXray('/api/xray/wakes', wakesDraft, () => { if (wakesData) setWakesData({ ...wakesData, rawContent: wakesDraft }); setWakesEditing(false); })} disabled={saving}>
                        {saving ? 'Saving...' : 'Save'}
                      </button>
                      <button className="res-btn res-btn--ghost" onClick={() => setWakesEditing(false)}>Cancel</button>
                    </div>
                  </>
                ) : wakesData?.rawContent ? (
                  <>
                    <pre className="code-block">{wakesData.rawContent}</pre>
                    <button className="res-btn res-btn--primary" onClick={() => { setWakesDraft(wakesData?.rawContent || ''); setWakesEditing(true); }}>Edit</button>
                  </>
                ) : (
                  <p className="muted">No wake prompts file found.</p>
                )}
                {wakesData?.prompts && Object.keys(wakesData.prompts).length > 0 && (
                  <div className="wake-sections">
                    <h4>Parsed Sections</h4>
                    {Object.entries(wakesData.prompts).map(([key, value]) => (
                      <div key={key} className="wake-item">
                        <span className="wake-key">{key}</span>
                        <span className="wake-preview">{value.slice(0, 100)}...</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {activeSection === 'context' && (
              <section className="section">
                <div className="section-header">
                  <h3 className="section-title">Context Injection</h3>
                  {contextInfo && <span className="section-path">live · "{contextInfo.meta.threadName}" · {contextInfo.meta.platform}</span>}
                </div>
                {contextInfo && (
                  <>
                    <p className="description">
                      The exact context delivered with the most recent turn — read from the warm lane's delivery journal, not a static legend.
                    </p>
                    <div className="context-controls">
                      <div className="context-view-toggle">
                        <button type="button" className={`nav-btn${contextView === 'structured' ? ' active' : ''}`} onClick={() => setContextView('structured')}>Structured</button>
                        <button type="button" className={`nav-btn${contextView === 'raw' ? ' active' : ''}`} onClick={() => setContextView('raw')}>Raw</button>
                      </div>
                      <div className="context-view-toggle">
                        <button type="button" className={`nav-btn${contextStatic ? ' active' : ''}`} onClick={() => setContextStatic(true)}>First message</button>
                        <button type="button" className={`nav-btn${!contextStatic ? ' active' : ''}`} onClick={() => setContextStatic(false)}>Mid-thread</button>
                      </div>
                      <select className="context-select" value={contextPlatform} onChange={(e) => setPlatform(e.target.value as any)} aria-label="Preview platform">
                        <option value="web">web</option>
                        <option value="telegram">telegram</option>
                        <option value="discord">discord</option>
                      </select>
                      {contextLoading && <span className="muted context-updating">updating…</span>}
                    </div>
                    {contextPlatform === 'telegram' && (
                      <p className="muted context-note">telegram has no dedicated channel block — it inherits web's framing. (The live channel-history tail is attached at send time and can't be reconstructed in a preview.)</p>
                    )}
                    {contextView === 'structured' ? (
                      contextInfo.parts.length === 0 ? (
                        <p className="muted">No context segments for this thread right now.</p>
                      ) : (
                        contextInfo.parts.map((part) => (
                          <CollapsibleBlock key={part.label} k={`context:${part.label}`} label={part.label} content={part.content} />
                        ))
                      )
                    ) : (
                      <pre className="code-block">{contextInfo.raw}</pre>
                    )}
                    <div className="context-block">
                      <h4>Current Identity</h4>
                      <div className="context-list">
                        <div className="context-item"><span className="context-key">companion_name</span><span className="context-value">{contextInfo.identity.companion_name}</span></div>
                        <div className="context-item"><span className="context-key">user_name</span><span className="context-value">{contextInfo.identity.user_name}</span></div>
                        <div className="context-item"><span className="context-key">timezone</span><span className="context-value">{contextInfo.identity.timezone}</span></div>
                      </div>
                    </div>
                  </>
                )}
              </section>
            )}

            {activeSection === 'hooks' && (
              <section className="section">
                <div className="section-header">
                  <h3 className="section-title">Triggers &amp; Watchers</h3>
                </div>
                {triggers.length === 0 ? (
                  <p className="muted">No active triggers or watchers.</p>
                ) : (
                  <div className="hooks-list">
                    {triggers.map((trigger) => (
                      <div key={trigger.id} className="hook-item">
                        <button className="hook-header" onClick={() => setExpandedTrigger(expandedTrigger === trigger.id ? null : trigger.id)}>
                          <span className="hook-head-left">
                            <span className="status-dot" data-status={trigger.status} title={trigger.status}></span>
                            <span className="hook-label">{trigger.label}</span>
                            <span className="hook-type">{trigger.kind}</span>
                          </span>
                          <span className="hook-head-right">
                            <span className="hook-summary">{conditionSummary(trigger.conditions)}</span>
                            <span className="memory-toggle">{expandedTrigger === trigger.id ? '▼' : '▶'}</span>
                          </span>
                        </button>
                        {expandedTrigger === trigger.id && (
                          <div className="hook-body">
                            <div className="hook-field">
                              <div className="hook-field-head">
                                <h4>Conditions</h4>
                                <button className="res-btn res-btn--ghost res-btn--sm" onClick={() => { const next = new Set(rawConditions); next.has(trigger.id) ? next.delete(trigger.id) : next.add(trigger.id); setRawConditions(next); }}>
                                  {rawConditions.has(trigger.id) ? 'Plain' : 'Raw JSON'}
                                </button>
                              </div>
                              {rawConditions.has(trigger.id) ? (
                                <pre className="code-block small">{trigger.conditions}</pre>
                              ) : (
                                <ul className="condition-list">
                                  {parseConditions(trigger.conditions).length === 0 ? (
                                    <li className="muted">no conditions</li>
                                  ) : (
                                    parseConditions(trigger.conditions).map((c, i) => <li key={i}>{describeCondition(c)}</li>)
                                  )}
                                </ul>
                              )}
                            </div>
                            <CollapsibleBlock k={`hook:${trigger.id}:prompt`} label="Prompt" content={trigger.prompt ?? '(no prompt)'} />
                            <div className="hook-meta">
                              <span>fired <strong>{trigger.fire_count}×</strong></span>
                              <span>last fired: {lastFired(trigger)}</span>
                              <span>cooldown: {trigger.cooldown_minutes}m</span>
                              <span>created: {new Date(trigger.created_at).toLocaleString()}</span>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {activeSection === 'activity' && (
              <section className="section">
                <div className="section-header">
                  <h3 className="section-title">Activity</h3>
                  <span className="section-path">what the companions actually did · {filteredAudit.length} of {auditEntries.length}</span>
                </div>
                <p className="description">
                  The real tool calls from <code>audit_log</code> — newest first. Outputs are capped at 1000 chars by the logger, and no timing is recorded (yet).
                </p>
                <div className="context-controls">
                  <div className="context-view-toggle">
                    <button type="button" className={`nav-btn${auditFilter === 'all' ? ' active' : ''}`} onClick={() => setAuditFilter('all')}>All</button>
                    <button type="button" className={`nav-btn${auditFilter === 'errors' ? ' active' : ''}`} onClick={() => setAuditFilter('errors')}>Errors</button>
                  </div>
                  <input className="audit-search" type="text" placeholder="filter by tool…" value={auditSearch} onChange={(e) => setAuditSearch(e.target.value)} aria-label="Filter activity by tool name" />
                  {auditLoading && <span className="muted context-updating">updating…</span>}
                </div>
                {filteredAudit.length === 0 ? (
                  <p className="muted">{auditEntries.length === 0 ? 'No tool activity recorded yet.' : 'No activity matches this filter.'}</p>
                ) : (
                  <>
                    <div className="hooks-list">
                      {filteredAudit.map((entry) => {
                        const parsed = parseToolName(entry.tool_name);
                        const status = auditStatus(entry.tool_output);
                        return (
                          <div key={entry.id} className="hook-item">
                            <button className="hook-header audit-row" onClick={() => setExpandedAudit(expandedAudit === entry.id ? null : entry.id)}>
                              <span className="status-dot" data-status={status === 'ok' ? 'fired' : status === 'error' ? 'cancelled' : 'pending'} title={status}></span>
                              <span className="audit-main">
                                <span className="audit-line1">
                                  <span className="audit-tool">{parsed.tool}</span>
                                  {parsed.server && <span className="hook-type audit-server">{parsed.server}</span>}
                                </span>
                                <span className={`audit-preview${status === 'error' ? ' error' : ''}`}>
                                  {status === 'error' ? errorSummary(entry.tool_output ?? '') : (entry.tool_input ? summaryLine(entry.tool_input) : '—')}
                                </span>
                              </span>
                              <span className="audit-meta-right">
                                <span className="audit-time">{relativeTime(entry.created_at)}</span>
                                <span className="memory-toggle">{expandedAudit === entry.id ? '▼' : '▶'}</span>
                              </span>
                            </button>
                            {expandedAudit === entry.id && (
                              <div className="hook-body audit-body">
                                <div className="audit-section">
                                  <h4>Input</h4>
                                  <pre className="code-block small">{entry.tool_input ?? '(no input)'}</pre>
                                </div>
                                <div className="audit-section">
                                  <h4>Output</h4>
                                  {status === 'error' && <p className="audit-error-line">{errorSummary(entry.tool_output ?? '')}</p>}
                                  <pre className="code-block small">{entry.tool_output ?? '(no output captured)'}</pre>
                                </div>
                                <div className="audit-section">
                                  <h4>Metadata</h4>
                                  <dl className="audit-meta-list">
                                    <div><dt>when</dt><dd>{new Date(entry.created_at).toLocaleString()}</dd></div>
                                    <div><dt>tool</dt><dd className="audit-meta-tool">{entry.tool_name}</dd></div>
                                    <div><dt>session</dt><dd>{entry.session_id.slice(0, 8)}</dd></div>
                                    <div><dt>thread</dt><dd>{entry.thread_id.slice(0, 8)}</dd></div>
                                    {entry.triggering_message_id && <div><dt>msg</dt><dd>{entry.triggering_message_id.slice(0, 8)}</dd></div>}
                                  </dl>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <button className="res-btn res-btn--ghost res-btn--sm audit-more" onClick={loadMoreAudit} disabled={auditLoading}>
                      {auditLoading ? 'Loading…' : 'Load more'}
                    </button>
                  </>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
