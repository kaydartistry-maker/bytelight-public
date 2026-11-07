import React, { useState } from 'react';
import { ChevronRight, Plus, Trash2 } from 'lucide-react';
import { ThemeConfig } from '../lib/theme';
import { Paginator, usePaged } from './Paginator';
import { cn } from '../lib/utils';
import { apiFetch } from '../bytelight';
import { Toggle } from './Toggle';

interface DiscordRulesProps {
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

type RuleType = 'server' | 'channel' | 'user';
const TYPES: { id: RuleType; label: string }[] = [
  { id: 'server', label: 'Servers' },
  { id: 'channel', label: 'Channels' },
  { id: 'user', label: 'Users' },
];

interface RulesData {
  servers: Record<string, any>;
  channels: Record<string, any>;
  users: Record<string, any>;
}

// One gate per room (the operator's house gates). Channel beats server; with neither,
// the gateway's "Require @mention in guilds" toggle decides.
type GateMode = 'tag-only' | 'chime-in' | 'read-only' | 'ignore';
const GATES: { id: GateMode; label: string; hint: string }[] = [
  { id: 'tag-only', label: 'Tag only', hint: 'Answers only when tagged or replied to.' },
  { id: 'chime-in', label: 'Chime in', hint: 'Answers tags, and joins the conversation when there is something to add. Trust levels decide who.' },
  { id: 'read-only', label: 'Read-only', hint: 'Never answers here. Mentions of you still reach your phone.' },
  { id: 'ignore', label: 'Ignore', hint: "Doesn't read this room at all." },
];

function isGate(value: unknown): value is GateMode {
  return GATES.some((g) => g.id === value);
}

// The gate a saved rule asks for, read the way the backend reads it
// (services/discord/rules.ts legacyGateMode): gateMode first, then the old
// toggles, so rules saved before the picker show what they actually do.
function ruleGate(rule: any): GateMode | undefined {
  if (!rule) return undefined;
  if (isGate(rule.gateMode)) return rule.gateMode;
  if (rule.ignore === true) return 'ignore';
  if (rule.readOnly === true) return 'read-only';
  if (rule.requireMention === true) return 'tag-only';
  if (rule.requireMention === false) return 'chime-in';
  if (rule.alwaysListen === true) return 'chime-in';
  return undefined;
}

// The server/channel/user rules editor for the Discord panel.
export function DiscordRules({ themeConfig, themeMode }: DiscordRulesProps) {
  const colors = themeConfig[themeMode];
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState<RulesData | null>(null);
  const [tab, setTab] = useState<RuleType>('server');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, any>>({});
  const [adding, setAdding] = useState(false);
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  // The gateway's "Require @mention in guilds" toggle: the gate a room falls
  // back to when neither it nor its server sets one.
  const [requireMentionDefault, setRequireMentionDefault] = useState(true);

  async function loadRules() {
    try {
      const [res, settingsRes] = await Promise.all([
        apiFetch('/api/discord/rules'),
        apiFetch('/api/discord/settings'),
      ]);
      if (res.ok) setRules(await res.json());
      if (settingsRes.ok) {
        const settings = await settingsRes.json();
        if (typeof settings.requireMentionInGuilds === 'boolean') setRequireMentionDefault(settings.requireMentionInGuilds);
      }
    } catch {
      /* ignore */
    }
  }

  // What a room's picker shows: its own gate, else its server's, else the gateway default.
  function shownGate(rule: any): GateMode {
    const fallback: GateMode = requireMentionDefault ? 'tag-only' : 'chime-in';
    if (tab === 'server') return ruleGate(rule) ?? fallback;
    return ruleGate(rule) ?? ruleGate(rules?.servers?.[rule?.serverId]) ?? fallback;
  }

  function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next && !rules) loadRules();
  }

  function collection(): Record<string, any> {
    if (!rules) return {};
    return tab === 'server' ? rules.servers : tab === 'channel' ? rules.channels : rules.users;
  }

  function draftFor(id: string, rule: any) {
    return drafts[`${tab}:${id}`] ?? rule;
  }

  function setField(id: string, key: string, value: unknown) {
    setDrafts((d) => ({ ...d, [`${tab}:${id}`]: { ...draftFor(id, collection()[id]), [key]: value } }));
  }

  async function saveRule(id: string) {
    const rule = draftFor(id, collection()[id]);
    try {
      const res = await apiFetch(`/api/discord/rules/${tab}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rule),
      });
      if (res.ok) {
        setDrafts((d) => {
          const next = { ...d };
          delete next[`${tab}:${id}`];
          return next;
        });
        await loadRules();
      }
    } catch {
      /* ignore */
    }
  }

  async function deleteRule(id: string) {
    try {
      const res = await apiFetch(`/api/discord/rules/${tab}/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setExpanded(null);
        await loadRules();
      }
    } catch {
      /* ignore */
    }
  }

  async function addRule() {
    if (!newId.trim() || !newName.trim()) return;
    const base: any =
      tab === 'server'
        ? { id: newId.trim(), name: newName.trim(), context: '', gateMode: 'tag-only' }
        : tab === 'channel'
          ? { id: newId.trim(), name: newName.trim(), serverId: '' }
          : { id: newId.trim(), name: newName.trim(), trustLevel: 'standard' };
    try {
      const res = await apiFetch(`/api/discord/rules/${tab}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(base),
      });
      if (res.ok) {
        setNewId('');
        setNewName('');
        setAdding(false);
        setExpanded(`${tab}:${base.id}`);
        await loadRules();
      }
    } catch {
      /* ignore */
    }
  }

  const card = cn('rounded-2xl border p-3 mb-3', colors.panelBg, colors.panelBorder);
  const sectionTitle = cn('text-[11px] font-bold uppercase tracking-[0.12em]', colors.textMuted);
  const input = cn('w-full rounded-lg border px-2.5 py-1.5 text-xs bg-transparent', colors.panelBorder, colors.textMain);
  const fieldLabel = cn('text-[11px] mb-1', colors.textMuted);

  function toggle(on: boolean, onClick: () => void) {
    return <Toggle on={on} onClick={onClick} colors={colors} />;
  }

  // One Gate picker, styled like the Trust level dropdown, with a plain line under it.
  function gatePicker(id: string, label: string, d: any) {
    const value = shownGate(d);
    const hint = GATES.find((g) => g.id === value)?.hint;
    return (
      <>
        <div className={cn(fieldLabel, 'mt-2')}>{label}</div>
        <select className={input} value={value} onChange={(e) => setField(id, 'gateMode', e.target.value)}>
          {GATES.map((g) => (
            <option key={g.id} value={g.id}>
              {g.label}
            </option>
          ))}
        </select>
        {hint && <div className={cn('text-[11px] mt-1', colors.textMuted)}>{hint}</div>}
      </>
    );
  }

  function toggleRow(label: string, on: boolean, onClick: () => void) {
    return (
      <div className="flex items-center justify-between py-1">
        <span className={cn('text-xs', colors.textMain)}>{label}</span>
        {toggle(on, onClick)}
      </div>
    );
  }

  // Comma-list field: backend stores a JSON array of IDs, UI edits a
  // comma-separated text input. Split + trim + drop empties on every keystroke.
  function commaListRow(id: string, fieldKey: string, label: string, hint: string, value: string[] | undefined) {
    const text = (value || []).join(', ');
    return (
      <>
        <div className={cn(fieldLabel, 'mt-2')}>{label}</div>
        <input
          className={input}
          placeholder={hint}
          value={text}
          onChange={(e) =>
            setField(id, fieldKey, e.target.value.split(',').map((s) => s.trim()).filter(Boolean))
          }
        />
      </>
    );
  }

  function ruleEditor(id: string, rule: any) {
    const d = draftFor(id, rule);
    return (
      <div className={cn('mt-1 rounded-xl border p-2.5', colors.panelBorder)}>
        <div className={fieldLabel}>Name</div>
        <input className={input} value={d.name || ''} onChange={(e) => setField(id, 'name', e.target.value)} />
        {tab === 'channel' && (
          <>
            <div className={cn(fieldLabel, 'mt-2')}>Server ID</div>
            <input className={input} value={d.serverId || ''} onChange={(e) => setField(id, 'serverId', e.target.value)} />
          </>
        )}
        {tab === 'user' && (
          <>
            <div className={cn(fieldLabel, 'mt-2')}>Trust level</div>
            <select className={input} value={d.trustLevel || 'standard'} onChange={(e) => setField(id, 'trustLevel', e.target.value)}>
              <option value="full">Full</option>
              <option value="standard">Standard</option>
              <option value="limited">Limited</option>
            </select>
            <div className={cn(fieldLabel, 'mt-2')}>Relationship</div>
            <input className={input} value={d.relationship || ''} onChange={(e) => setField(id, 'relationship', e.target.value)} />
          </>
        )}
        <div className={cn(fieldLabel, 'mt-2')}>Context</div>
        <textarea
          className={cn(input, 'font-mono')}
          rows={3}
          value={d.context || ''}
          onChange={(e) => setField(id, 'context', e.target.value)}
        />
        {tab === 'server' &&
          commaListRow(
            id,
            'ignoredChannels',
            'Ignored channels',
            'Channel IDs, comma-separated',
            d.ignoredChannels,
          )}
        {tab === 'user' && (
          <>
            {commaListRow(
              id,
              'allowedServers',
              'Allowed servers',
              'Server IDs, comma-separated (allowlist)',
              d.allowedServers,
            )}
            {commaListRow(
              id,
              'blockedServers',
              'Blocked servers',
              'Server IDs, comma-separated (blocklist)',
              d.blockedServers,
            )}
          </>
        )}
        {tab === 'server' && gatePicker(id, 'Default for channels', d)}
        {tab === 'channel' && gatePicker(id, 'Gate', d)}
        <div className="mt-2">
          {tab === 'server' &&
            toggleRow('Allow public responses', d.allowPublicResponses ?? false, () =>
              setField(id, 'allowPublicResponses', !(d.allowPublicResponses ?? false)),
            )}
        </div>
        <div className="flex gap-2 mt-2">
          <button
            onClick={() => saveRule(id)}
            className="rounded-lg px-3 py-1.5 text-xs font-semibold bytelight-on-accent"
            style={{ background: colors.accent }}
          >
            Save
          </button>
          <button
            onClick={() => deleteRule(id)}
            className="rounded-lg border px-3 py-1.5 text-xs font-semibold"
            style={{ color: colors.accent, borderColor: colors.accent }}
          >
            <Trash2 size={12} className="inline" /> Delete
          </button>
        </div>
      </div>
    );
  }

  const items = Object.entries(collection());
  // Twenty rules a page. `items` is derived, not state — usePaged does not care.
  const rulesPage = usePaged(items);

  return (
    <div className={card}>
      <button onClick={toggleOpen} className="flex w-full items-center justify-between">
        <span className={sectionTitle}>Rules</span>
        <ChevronRight size={14} className={cn(colors.textMuted, open && 'rotate-90')} />
      </button>

      {open && (
        <div className="mt-3">
          <div className="flex gap-1.5 mb-3">
            {TYPES.map((t) => (
              <button
                key={t.id}
                onClick={() => { setTab(t.id); setExpanded(null); }}
                className={cn('flex-1 rounded-lg py-1.5 text-xs font-medium border', colors.panelBorder)}
                style={tab === t.id ? { background: colors.accent, color: 'var(--bytelight-on-accent)' } : undefined}
              >
                {t.label}
              </button>
            ))}
          </div>

          {!rules ? (
            <div className={cn('text-xs py-3 text-center', colors.textMuted)}>Loading rules…</div>
          ) : (
            <>
              {items.length === 0 && (
                <div className={cn('text-xs py-2 text-center', colors.textMuted)}>No {tab} rules.</div>
              )}
              {rulesPage.visible.map(([id, rule]) => {
                const key = `${tab}:${id}`;
                return (
                  <div key={key} className="mb-1.5">
                    <button
                      onClick={() => setExpanded(expanded === key ? null : key)}
                      className={cn('flex w-full items-center gap-2 rounded-xl border px-2.5 py-2', colors.panelBorder)}
                    >
                      <span className={cn('flex-1 text-left text-sm truncate', colors.textMain)}>{rule.name || id}</span>
                      <span className={cn('text-[10px] font-mono', colors.textMuted)}>{id}</span>
                      <ChevronRight size={13} className={cn(colors.textMuted, expanded === key && 'rotate-90')} />
                    </button>
                    {expanded === key && ruleEditor(id, rule)}
                  </div>
                );
              })}
              <Paginator page={rulesPage.page} pageCount={rulesPage.pageCount} onPage={rulesPage.setPage} colors={colors} />

              {adding ? (
                <div className={cn('mt-1 rounded-xl border p-2.5 flex flex-col gap-2', colors.panelBorder)}>
                  <input className={input} placeholder={`${tab} ID`} value={newId} onChange={(e) => setNewId(e.target.value)} />
                  <input className={input} placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} />
                  <div className="flex gap-2">
                    <button onClick={addRule} className="rounded-lg px-3 py-1.5 text-xs font-semibold bytelight-on-accent" style={{ background: colors.accent }}>
                      Add
                    </button>
                    <button onClick={() => setAdding(false)} className={cn('px-2 py-1.5 text-xs', colors.textMuted)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => { setAdding(true); setNewId(''); setNewName(''); }}
                  className={cn('mt-1 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed py-2 text-xs', colors.panelBorder, colors.textMuted)}
                >
                  <Plus size={13} /> Add {tab} rule
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
