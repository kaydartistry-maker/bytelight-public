import React, { useState } from 'react';
import { ChevronRight, Plus, Trash2 } from 'lucide-react';
import { ThemeConfig } from '../lib/theme';
import { Paginator, usePaged } from './Paginator';
import { cn } from '../lib/utils';
import { apiFetch } from '../bytelight';
import { Toggle } from './Toggle';
import { NamePicker, useDiscordDirectory, guildOptions, channelOptions } from './DiscordPickers';

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

// What each trust level does, said under the picker. No level ever lets a
// guest's turn run commands, change files, use outside tools or read the
// owner's side notes. Full keeps its own meaning in this house (family: the
// judge and the bot allowance treat it apart from Standard), so it stays.
const TRUST_NOTES: Record<string, string> = {
  full: "Family. We talk builds and the house with them, and can read the house's public code while we do.",
  standard: "We answer them, friendly and general, and can read the house's public code while we do. For friends who build.",
  limited: 'We answer them briefly and see only the pictures they send. Where everyone new starts.',
  blocked: 'We never answer them, anywhere, and nothing they say reaches you.',
};

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
  // Our servers and rooms by name, so nothing here asks for an id.
  const directory = useDiscordDirectory();
  const [byId, setById] = useState(false);

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
    const rule = { ...draftFor(id, collection()[id]) };
    // Saved by the owner: no longer a new face the house added on its own.
    if (tab === 'user') delete rule.auto;
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

  async function addRule(picked?: { id: string; name: string; serverId?: string }) {
    const id = (picked?.id ?? newId).trim();
    const name = (picked?.name ?? newName).trim();
    if (!id || !name) return;
    const base: any =
      tab === 'server'
        ? { id, name, context: '', gateMode: 'tag-only' }
        : tab === 'channel'
          ? { id, name, serverId: picked?.serverId ?? '' }
          // A new person starts at Limited; raise them when they are a friend.
          : { id, name, trustLevel: 'limited' };
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
        setById(false);
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

  function ruleEditor(id: string, rule: any) {
    const d = draftFor(id, rule);
    return (
      <div className={cn('mt-1 rounded-xl border p-2.5', colors.panelBorder)}>
        <div className={fieldLabel}>Name</div>
        <input className={input} value={d.name || ''} onChange={(e) => setField(id, 'name', e.target.value)} />
        {tab === 'channel' && (
          <>
            <div className={cn(fieldLabel, 'mt-2')}>Server</div>
            <select className={input} value={d.serverId || ''} onChange={(e) => setField(id, 'serverId', e.target.value)}>
              <option value="">Pick a server…</option>
              {directory.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
              {d.serverId && !directory.some((g) => g.id === d.serverId) && <option value={d.serverId}>{d.serverId}</option>}
            </select>
          </>
        )}
        {tab === 'user' && (
          <>
            <div className={cn(fieldLabel, 'mt-2')}>Trust level</div>
            {/* A rule with no level is read as Limited by the backend, so it shows as Limited. */}
            <select className={input} value={d.trustLevel || 'limited'} onChange={(e) => setField(id, 'trustLevel', e.target.value)}>
              <option value="full">Full</option>
              <option value="standard">Standard</option>
              <option value="limited">Limited</option>
              <option value="blocked">Blocked</option>
            </select>
            <div className={cn('mt-1 text-[11px]', colors.textMuted)}>{TRUST_NOTES[d.trustLevel || 'limited'] ?? ''}</div>
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
        {tab === 'server' && (
          <div className="mt-2">
            <NamePicker
              label="Ignored channels"
              value={d.ignoredChannels || []}
              options={channelOptions(directory, id)}
              onChange={(v) => setField(id, 'ignoredChannels', v)}
              colors={colors}
              empty="None"
              noOptions="Turn the gateway on to see this server's channels."
            />
          </div>
        )}
        {tab === 'user' && (
          <>
            <div className="mt-2 flex flex-col gap-2">
              <NamePicker
                label="Only in these servers"
                value={d.allowedServers || []}
                options={guildOptions(directory)}
                onChange={(v) => setField(id, 'allowedServers', v)}
                colors={colors}
                empty="None picked: everywhere we are"
                noOptions="Turn the gateway on to see your servers."
              />
              <NamePicker
                label="Never in these servers"
                value={d.blockedServers || []}
                options={guildOptions(directory)}
                onChange={(v) => setField(id, 'blockedServers', v)}
                colors={colors}
                empty="None"
                noOptions="Turn the gateway on to see your servers."
              />
            </div>
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

  // New faces the house added on its own sit at the top of Users until the owner saves them.
  const items = Object.entries(collection()).sort(([, a], [, b]) =>
    tab === 'user' ? Number(!!b?.auto) - Number(!!a?.auto) : 0,
  );
  const newFaces = tab === 'user' ? items.filter(([, r]) => r?.auto).length : 0;

  // What Add offers: servers and rooms we're in that have no rule yet.
  const addable =
    tab === 'server'
      ? directory.filter((g) => !rules?.servers?.[g.id]).map((g) => ({ id: g.id, name: g.name, sub: `${g.channels.length} channels` }))
      : tab === 'channel'
        ? directory.flatMap((g) =>
            g.channels.filter((c) => !rules?.channels?.[c.id]).map((c) => ({ id: c.id, name: c.name, serverId: g.id, sub: g.name })),
          )
        : [];
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
              {tab === 'user' && (
                <div className={cn('text-[11px] mb-2', colors.textMuted)}>
                  People and bots show up here on their own the first time they talk near us: people at Limited, bots at Blocked.
                  {newFaces > 0 && ` ${newFaces} new.`}
                </div>
              )}
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
                      {tab === 'user' && rule.auto && (
                        <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}>
                          New
                        </span>
                      )}
                      {tab === 'user' && (
                        <span className={cn('text-[10px] capitalize', colors.textMuted)}>{rule.trustLevel || 'limited'}</span>
                      )}
                      <ChevronRight size={13} className={cn(colors.textMuted, expanded === key && 'rotate-90')} />
                    </button>
                    {expanded === key && ruleEditor(id, rule)}
                  </div>
                );
              })}
              <Paginator page={rulesPage.page} pageCount={rulesPage.pageCount} onPage={rulesPage.setPage} colors={colors} />

              {adding ? (
                <div className={cn('mt-1 rounded-xl border p-2.5 flex flex-col gap-2', colors.panelBorder)}>
                  {!byId && tab !== 'user' && (
                    <div className="max-h-64 overflow-y-auto">
                      {addable.length === 0 && (
                        <div className={cn('px-1 py-2 text-xs', colors.textMuted)}>
                          {directory.length ? `Every ${tab} already has a rule.` : 'Turn the gateway on to see your servers.'}
                        </div>
                      )}
                      {addable.map((a: any) => (
                        <button
                          key={a.id}
                          onClick={() => addRule({ id: a.id, name: a.name, serverId: a.serverId })}
                          className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-white/5"
                        >
                          <span className={cn('flex-1 truncate text-sm', colors.textMain)}>{tab === 'channel' ? `#${a.name}` : a.name}</span>
                          <span className={cn('shrink-0 text-[10px]', colors.textMuted)}>{a.sub}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {(byId || tab === 'user') && (
                    <>
                      <input className={input} placeholder={`${tab} ID`} value={newId} onChange={(e) => setNewId(e.target.value)} />
                      <input className={input} placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} />
                    </>
                  )}
                  <div className="flex gap-2">
                    {(byId || tab === 'user') && (
                      <button onClick={() => addRule()} className="rounded-lg px-3 py-1.5 text-xs font-semibold bytelight-on-accent" style={{ background: colors.accent }}>
                        Add
                      </button>
                    )}
                    {tab !== 'user' && (
                      <button onClick={() => setById((v) => !v)} className={cn('px-2 py-1.5 text-xs', colors.textMuted)}>
                        {byId ? 'Pick from the list' : 'Add by ID instead'}
                      </button>
                    )}
                    <button onClick={() => { setAdding(false); setById(false); }} className={cn('ml-auto px-2 py-1.5 text-xs', colors.textMuted)}>
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
