import React, { useEffect, useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { apiFetch } from '../bytelight';

// Names to tap instead of ids to paste (Kay, 2026-11-27). The gateway reads
// its servers and rooms from Discord itself (GET /api/discord/directory), and
// people land on the Users list the first time they speak near us, so every
// id box on the Discord tab can offer names.

export interface DirChannel { id: string; name: string; category: string | null }
export interface DirGuild { id: string; name: string; icon: string | null; channels: DirChannel[] }

export interface PickOption {
  id: string;
  label: string;
  /** A second, quieter line: the server a room is in, "bot", and so on. */
  sub?: string;
}

type Colors = { panelBorder: string; textMain: string; textMuted: string; accent: string };

let directoryRead: Promise<DirGuild[]> | null = null;

function readDirectory(force = false): Promise<DirGuild[]> {
  if (directoryRead && !force) return directoryRead;
  directoryRead = apiFetch('/api/discord/directory')
    .then((r) => (r.ok ? r.json() : { guilds: [] }))
    .then((j) => (Array.isArray(j?.guilds) ? (j.guilds as DirGuild[]) : []))
    .catch(() => []);
  // An empty answer (gateway still connecting) is not kept, so the next open asks again.
  directoryRead.then((g) => { if (g.length === 0) directoryRead = null; });
  return directoryRead;
}

/** Our servers and their rooms, by name. Empty while the gateway is off. */
export function useDiscordDirectory(): DirGuild[] {
  const [guilds, setGuilds] = useState<DirGuild[]>([]);
  useEffect(() => {
    let live = true;
    readDirectory().then((g) => { if (live) setGuilds(g); });
    return () => { live = false; };
  }, []);
  return guilds;
}

export function guildOptions(guilds: DirGuild[]): PickOption[] {
  return guilds.map((g) => ({ id: g.id, label: g.name }));
}

export function channelOptions(guilds: DirGuild[], onlyGuildId?: string): PickOption[] {
  const out: PickOption[] = [];
  for (const g of guilds) {
    if (onlyGuildId && g.id !== onlyGuildId) continue;
    for (const c of g.channels) {
      out.push({ id: c.id, label: `#${c.name}`, sub: onlyGuildId ? c.category ?? undefined : g.name });
    }
  }
  return out;
}

export function userOptions(users: Record<string, any> | undefined): PickOption[] {
  return Object.entries(users ?? {})
    .map(([id, u]) => ({ id, label: String(u?.name || id), sub: u?.trustLevel ? String(u.trustLevel) : undefined }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Chips for the picked names, and a list to tap more from. Ids nobody can
 * name (a server we left, a person never seen) still show, as their id, so
 * nothing saved is hidden.
 */
export function NamePicker({
  label,
  value,
  options,
  onChange,
  colors,
  empty = 'Nothing picked',
  noOptions = 'Nothing to pick from yet.',
}: {
  label: string;
  value: string[];
  options: PickOption[];
  onChange: (next: string[]) => void;
  colors: Colors;
  empty?: string;
  noOptions?: string;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const byId = useMemo(() => new Map(options.map((o) => [o.id, o])), [options]);
  const picked = new Set(value);
  const remaining = options.filter((o) => !picked.has(o.id));
  const q = filter.trim().toLowerCase();
  const shown = q ? remaining.filter((o) => `${o.label} ${o.sub ?? ''}`.toLowerCase().includes(q)) : remaining;

  return (
    <div className="flex flex-col gap-1">
      <span className={cn('text-[11px]', colors.textMuted)}>{label}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {value.length === 0 && <span className={cn('text-xs', colors.textMuted)}>{empty}</span>}
        {value.map((id) => {
          const o = byId.get(id);
          return (
            <span
              key={id}
              className={cn('inline-flex max-w-full items-center gap-1 rounded-full border py-1 pl-2.5 pr-1 text-xs', colors.panelBorder, colors.textMain)}
            >
              <span className={cn('truncate', !o && 'font-mono text-[10px]')}>{o ? o.label : id}</span>
              <button
                type="button"
                aria-label={`Remove ${o ? o.label : id}`}
                onClick={() => onChange(value.filter((v) => v !== id))}
                className={cn('rounded-full p-1', colors.textMuted)}
              >
                <X size={11} />
              </button>
            </span>
          );
        })}
        <button
          type="button"
          onClick={() => { setOpen((v) => !v); setFilter(''); }}
          className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold"
          style={{ color: colors.accent, border: `1px dashed ${colors.accent}` }}
          aria-expanded={open}
        >
          <Plus size={11} /> Add
        </button>
      </div>
      {open && (
        <div className={cn('mt-1 rounded-xl border p-1.5', colors.panelBorder)}>
          {remaining.length > 8 && (
            <input
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Find…"
              aria-label="Find"
              className={cn('mb-1 w-full rounded-lg border bg-transparent px-2.5 py-1.5 text-xs', colors.panelBorder, colors.textMain)}
            />
          )}
          <div className="max-h-56 overflow-y-auto">
            {remaining.length === 0 && <div className={cn('px-2 py-2 text-xs', colors.textMuted)}>{options.length ? 'All picked.' : noOptions}</div>}
            {shown.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => onChange([...value, o.id])}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-white/5"
              >
                <span className={cn('flex-1 truncate text-xs', colors.textMain)}>{o.label}</span>
                {o.sub && <span className={cn('shrink-0 text-[10px]', colors.textMuted)}>{o.sub}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
