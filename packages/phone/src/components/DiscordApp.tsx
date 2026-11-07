import React, { useEffect, useState } from 'react';
import { Bot, RefreshCw, Loader2, ChevronRight } from 'lucide-react';
import { AppShell } from './AppShell';
import { Toggle } from './Toggle';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import { apiFetch } from '../bytelight';
import { DiscordRules } from './DiscordRules';

interface DiscordAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  embedded?: boolean;
}

interface DiscordStatus {
  enabled: boolean;
  hasToken: boolean;
  connected: boolean;
  username: string | null;
  guilds: number;
  messagesReceived: number;
  messagesProcessed: number;
  deferred: number;
  deferredPending: number;
  errors: number;
}

interface PairingEntry {
  code: string;
  userId: string;
  username: string | null;
  channelId: string;
  expiresAt: string;
  approvedAt?: string;
}

interface DiscordSettings {
  ownerUserId: string;
  requireMentionInGuilds: boolean;
  debounceMs: number;
  pairingExpiryMs: number;
  ownerActiveThresholdMin: number;
  deferPollIntervalMs: number;
  deferMaxAgeMs: number;
  /** How long a message waits for the room before Companion A and Companion B decide (ms). */
  judgeBeatMs: number;
  /** The longest that wait runs while somebody is still typing (ms). */
  judgeMaxWaitMs: number;
  /** Someone tags, replies to or names the operator → her phone is told, and nobody answers for her. */
  ownerMentions: boolean;
  allowedUsers: string[];
  allowedGuilds: string[];
  activeChannels: string[];
}

export function DiscordApp({ onClose, themeConfig, themeMode, embedded }: DiscordAppProps) {
  const colors = themeConfig[themeMode];
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<DiscordStatus | null>(null);
  const [pending, setPending] = useState<PairingEntry[]>([]);
  const [approved, setApproved] = useState<PairingEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [settings, setSettings] = useState<DiscordSettings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [replacingToken, setReplacingToken] = useState(false);

  const enabled = status?.enabled ?? false;

  function flash(msg: string) {
    setMessage(msg);
    setTimeout(() => setMessage(null), 3000);
  }

  async function load() {
    try {
      const [statusRes, pairRes] = await Promise.all([
        apiFetch('/api/discord/status'),
        apiFetch('/api/discord/pairings'),
      ]);
      if (statusRes.ok) setStatus(await statusRes.json());
      if (pairRes.ok) {
        const data = await pairRes.json();
        setPending(data.pending || []);
        setApproved(data.approved || []);
      }
    } catch {
      setError('Failed to load Discord status');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function toggleGateway() {
    setBusy('toggle');
    setError(null);
    try {
      const res = await apiFetch('/api/discord/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !enabled }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Toggle failed');
      flash(!enabled ? 'Discord gateway starting…' : 'Discord gateway stopped');
      if (!enabled) await new Promise((r) => setTimeout(r, 2000));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to toggle Discord');
    } finally {
      setBusy(null);
    }
  }

  async function saveToken() {
    const value = tokenInput.trim();
    if (!value) return;
    setBusy('token');
    setError(null);
    try {
      const res = await apiFetch('/api/secrets/discord_bot_token', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to save token');
      setTokenInput('');
      flash('Bot token saved');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save token');
    } finally {
      setBusy(null);
    }
  }

  async function approve(code: string) {
    setBusy(`approve-${code}`);
    try {
      const res = await apiFetch(`/api/discord/pairings/${code}/approve`, { method: 'POST' });
      if (!res.ok) throw new Error((await res.json()).error || 'Approval failed');
      flash('Pairing approved');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve');
    } finally {
      setBusy(null);
    }
  }

  async function revoke(userId: string) {
    setBusy(`revoke-${userId}`);
    try {
      const res = await apiFetch(`/api/discord/pairings/${userId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error || 'Revocation failed');
      flash('Access revoked');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke');
    } finally {
      setBusy(null);
    }
  }

  async function loadSettings() {
    try {
      const res = await apiFetch('/api/discord/settings');
      if (res.ok) {
        setSettings(await res.json());
        setSettingsDirty(false);
      }
    } catch {
      setError('Failed to load settings');
    }
  }

  async function saveSettings() {
    if (!settings) return;
    setSavingSettings(true);
    setError(null);
    try {
      const res = await apiFetch('/api/discord/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
      setSettings(await res.json());
      setSettingsDirty(false);
      flash('Settings saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSavingSettings(false);
    }
  }

  function patchSettings(partial: Partial<DiscordSettings>) {
    setSettings((prev) => (prev ? { ...prev, ...partial } : prev));
    setSettingsDirty(true);
  }

  const card = cn('rounded-2xl border p-3 mb-3', colors.panelBg, colors.panelBorder);
  const sectionTitle = cn('text-[11px] font-bold uppercase tracking-[0.12em] mb-2', colors.textMuted);

  function toggle(on: boolean, onClick: () => void, disabled?: boolean) {
    return <Toggle on={on} onClick={onClick} disabled={disabled} colors={colors} />;
  }

  function numField(label: string, value: number, onChange: (n: number) => void, hint?: string) {
    return (
      <label className="flex flex-col gap-1">
        <span className={cn('text-[11px]', colors.textMuted)}>{label}</span>
        <input
          type="number"
          defaultValue={value}
          onBlur={(e) => {
            const n = parseFloat(e.target.value);
            if (!isNaN(n) && n !== value) onChange(n);
          }}
          className={cn('rounded-md border px-2 py-1 text-xs bg-transparent', colors.panelBorder, colors.textMain)}
        />
        {hint && <span className={cn('text-[10px] italic', colors.textMuted)}>{hint}</span>}
      </label>
    );
  }

  function listField(label: string, value: string[], onChange: (v: string[]) => void) {
    return (
      <label className="flex flex-col gap-1">
        <span className={cn('text-[11px]', colors.textMuted)}>{label}</span>
        <input
          type="text"
          defaultValue={value.join(', ')}
          onBlur={(e) => onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
          className={cn('rounded-md border px-2 py-1 text-xs bg-transparent', colors.panelBorder, colors.textMain)}
        />
      </label>
    );
  }

  return (
    <AppShell
      embedded={embedded}
      title="Discord"
      icon={Bot}
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
      {loading ? (
        <div className={cn('text-xs py-6 text-center', colors.textMuted)}>Loading Discord status…</div>
      ) : (
        <>
          {/* Gateway toggle */}
          <div className={card}>
            <div className={sectionTitle}>Discord Gateway</div>
            {!status?.hasToken ? (
              <div className="flex flex-col gap-2">
                <p className={cn('text-xs', colors.textMuted)}>
                  No bot token configured. Paste your bot token from{' '}
                  <span className={colors.textMain}>discord.com/developers</span> (Bot → Reset Token).
                </p>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    placeholder="Bot token"
                    autoComplete="off"
                    className={cn('flex-1 rounded-md border px-2 py-1 text-xs bg-transparent', colors.panelBorder, colors.textMain)}
                  />
                  <button
                    onClick={saveToken}
                    disabled={!tokenInput.trim() || busy === 'token'}
                    className={cn(
                      'rounded-md border px-3 py-1 text-xs disabled:opacity-40',
                      colors.panelBorder, colors.textMain,
                    )}
                  >
                    {busy === 'token' ? <Loader2 size={12} className="animate-spin" /> : 'Save'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <div>
                    <div className={cn('text-sm', colors.textMain)}>{enabled ? 'Gateway active' : 'Gateway off'}</div>
                    <div className={cn('text-[11px]', colors.textMuted)}>Connect to Discord and receive messages</div>
                  </div>
                  {toggle(enabled, toggleGateway, busy === 'toggle')}
                </div>
                {replacingToken ? (
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={tokenInput}
                      onChange={(e) => setTokenInput(e.target.value)}
                      placeholder="New bot token"
                      autoComplete="off"
                      className={cn('flex-1 rounded-md border px-2 py-1 text-xs bg-transparent', colors.panelBorder, colors.textMain)}
                    />
                    <button
                      onClick={async () => { await saveToken(); setReplacingToken(false); }}
                      disabled={!tokenInput.trim() || busy === 'token'}
                      className={cn('rounded-md border px-3 py-1 text-xs disabled:opacity-40', colors.panelBorder, colors.textMain)}
                    >
                      {busy === 'token' ? <Loader2 size={12} className="animate-spin" /> : 'Save'}
                    </button>
                    <button
                      onClick={() => { setReplacingToken(false); setTokenInput(''); }}
                      className={cn('rounded-md border px-3 py-1 text-xs', colors.panelBorder, colors.textMuted)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setReplacingToken(true)}
                    className={cn('self-start text-[11px] underline underline-offset-2', colors.textMuted)}
                  >
                    Replace bot token
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Connection */}
          {enabled && status && (
            <div className={card}>
              <div className={sectionTitle}>Connection</div>
              <div className="flex items-center gap-2 mb-2">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: colors.accent, opacity: status.connected ? 1 : 0.4 }}
                />
                <span className={cn('text-xs', colors.textMain)}>
                  {status.connected ? `Online as ${status.username}` : 'Connecting…'}
                </span>
              </div>
              {status.connected && (
                <div className="grid grid-cols-3 gap-2">
                  {[
                    ['Guilds', status.guilds],
                    ['Received', status.messagesReceived],
                    ['Processed', status.messagesProcessed],
                    ['Deferred', status.deferred ?? 0],
                    ['Errors', status.errors],
                  ].map(([label, val]) => (
                    <div
                      key={label as string}
                      className={cn('rounded-lg border p-2 text-center', colors.panelBorder)}
                    >
                      <div className={cn('text-[10px] uppercase', colors.textMuted)}>{label}</div>
                      <div
                        className="text-sm font-mono"
                        style={{ color: label === 'Errors' && (val as number) > 0 ? colors.accent : undefined }}
                      >
                        {val as number}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Pending pairings */}
          {pending.length > 0 && (
            <div className={card}>
              <div className={sectionTitle}>Pending Pairing Requests</div>
              {pending.map((p) => (
                <div key={p.code} className="flex items-center justify-between gap-2 py-1.5">
                  <div className="min-w-0">
                    <div className={cn('text-sm truncate', colors.textMain)}>{p.username || p.userId}</div>
                    <div className={cn('text-[11px]', colors.textMuted)}>
                      Code {p.code} · expires {new Date(p.expiresAt).toLocaleString()}
                    </div>
                  </div>
                  <button
                    onClick={() => approve(p.code)}
                    disabled={busy === `approve-${p.code}`}
                    className="rounded-lg px-2.5 py-1 text-[11px] font-semibold bytelight-on-accent shrink-0 disabled:opacity-50"
                    style={{ background: colors.accent }}
                  >
                    Approve
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Approved users */}
          {approved.length > 0 && (
            <div className={card}>
              <div className={sectionTitle}>Approved Users</div>
              {approved.map((p) => (
                <div key={p.userId} className="flex items-center justify-between gap-2 py-1.5">
                  <div className="min-w-0">
                    <div className={cn('text-sm truncate', colors.textMain)}>{p.username || p.userId}</div>
                    <div className={cn('text-[11px]', colors.textMuted)}>
                      Approved {p.approvedAt ? new Date(p.approvedAt).toLocaleDateString() : 'unknown'}
                    </div>
                  </div>
                  <button
                    onClick={() => revoke(p.userId)}
                    disabled={busy === `revoke-${p.userId}`}
                    className="rounded-lg border px-2.5 py-1 text-[11px] font-semibold shrink-0 disabled:opacity-50"
                    style={{ color: colors.accent, borderColor: colors.accent }}
                  >
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Gateway settings */}
          <div className={card}>
            <button
              onClick={() => {
                const next = !showSettings;
                setShowSettings(next);
                if (next && !settings) loadSettings();
              }}
              className="flex w-full items-center justify-between"
            >
              <span className={sectionTitle} style={{ marginBottom: 0 }}>Gateway Settings</span>
              <ChevronRight size={14} className={cn(colors.textMuted, showSettings && 'rotate-90')} />
            </button>
            {showSettings && settings && (
              <div className="mt-3 flex flex-col gap-2.5">
                {numField('Debounce window (ms)', settings.debounceMs, (n) => patchSettings({ debounceMs: n }))}
                <div className="flex items-center justify-between">
                  <span className={cn('text-[11px]', colors.textMuted)}>Require @mention in guilds</span>
                  {toggle(settings.requireMentionInGuilds, () =>
                    patchSettings({ requireMentionInGuilds: !settings.requireMentionInGuilds }),
                  )}
                </div>
                {numField('Pairing expiry (hours)', settings.pairingExpiryMs / 3_600_000, (n) =>
                  patchSettings({ pairingExpiryMs: n * 3_600_000 }),
                )}
                <div className="flex items-center justify-between">
                  <span className={cn('text-[11px]', colors.textMuted)}>Tell me when I'm mentioned</span>
                  {toggle(settings.ownerMentions ?? true, () =>
                    patchSettings({ ownerMentions: !(settings.ownerMentions ?? true) }),
                  )}
                </div>
                <span className={cn('text-[10px] -mt-1.5', colors.textMuted)}>
                  Someone tags you, replies to you or says your name: your phone is told, and nobody answers for you.
                </span>
                {numField('Beat wait (sec)', (settings.judgeBeatMs ?? 60000) / 1000, (n) =>
                  patchSettings({ judgeBeatMs: n * 1000 }),
                  'Chime-in rooms: how long to let everyone say their piece',
                )}
                {numField('Beat max wait (sec)', (settings.judgeMaxWaitMs ?? 180000) / 1000, (n) =>
                  patchSettings({ judgeMaxWaitMs: n * 1000 }),
                  'Longest wait while someone is still typing',
                )}
                {numField('Owner active threshold (min)', settings.ownerActiveThresholdMin, (n) =>
                  patchSettings({ ownerActiveThresholdMin: n }),
                )}
                {numField('Defer poll interval (sec)', settings.deferPollIntervalMs / 1000, (n) =>
                  patchSettings({ deferPollIntervalMs: n * 1000 }),
                  'Requires gateway restart',
                )}
                {numField('Defer max age (min)', settings.deferMaxAgeMs / 60_000, (n) =>
                  patchSettings({ deferMaxAgeMs: n * 60_000 }),
                )}
                {listField('Allowed guilds (IDs)', settings.allowedGuilds, (v) => patchSettings({ allowedGuilds: v }))}
                {listField('Active channels', settings.activeChannels, (v) => patchSettings({ activeChannels: v }))}
                {listField('Allowed users (IDs)', settings.allowedUsers, (v) => patchSettings({ allowedUsers: v }))}
                {settingsDirty && (
                  <button
                    onClick={saveSettings}
                    disabled={savingSettings}
                    className="rounded-lg px-3 py-2 text-xs font-semibold bytelight-on-accent disabled:opacity-50"
                    style={{ background: colors.accent }}
                  >
                    {savingSettings ? 'Saving…' : 'Save Settings'}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Server / channel / user rules */}
          <DiscordRules themeConfig={themeConfig} themeMode={themeMode} />

          {message && <p className="text-xs mt-1" style={{ color: colors.accent }}>{message}</p>}
          {error && <p className="text-xs mt-1" style={{ color: colors.accent, opacity: 0.8 }}>{error}</p>}
        </>
      )}
    </AppShell>
  );
}
