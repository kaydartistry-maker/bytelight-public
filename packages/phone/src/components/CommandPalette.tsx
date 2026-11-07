import React, { useEffect, useMemo, useRef } from 'react';
import { cn } from '../lib/utils';
import type { CommandRegistryEntry } from '../bytelight';
import type { ThemeConfig } from '../lib/theme';

interface CommandPaletteProps {
  registry: CommandRegistryEntry[];
  filter: string;
  selectedIndex: number;
  onSelect: (cmd: CommandRegistryEntry) => void;
  onHoverIndex: (index: number) => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

type Group = { category: 'builtin' | 'skill' | 'custom'; label: string; commands: CommandRegistryEntry[] };

// Mirror of the Svelte CommandPalette this house ran before the phone.
//
// Slash commands themselves are Claude Code's, not anyone's here — /compact,
// /clear, skills, and the .claude/commands/*.md convention all come with it.
// What the NOTICE credits Byte-Light for is the UI: the thing that lists them,
// filters them and makes them visible. This file is that, ported.
// Renders a filtered, grouped
// list of commands above the composer; the parent owns the selected
// index so keyboard navigation can be driven from the textarea's
// onKeyDown.
export function CommandPalette({
  registry,
  filter,
  selectedIndex,
  onSelect,
  onHoverIndex,
  themeConfig,
  themeMode,
}: CommandPaletteProps) {
  const colors = themeConfig[themeMode];

  // Filter + group. Matches against name AND description, case-insensitive,
  // matching the desktop palette.
  const groups = useMemo<Group[]>(() => {
    const q = filter.toLowerCase();
    const match = (e: CommandRegistryEntry) =>
      !q || e.name.toLowerCase().includes(q) || (e.description || '').toLowerCase().includes(q);
    const builtin: CommandRegistryEntry[] = [];
    const skill: CommandRegistryEntry[] = [];
    const custom: CommandRegistryEntry[] = [];
    for (const cmd of registry) {
      if (!match(cmd)) continue;
      if (cmd.category === 'skill') skill.push(cmd);
      else if (cmd.category === 'custom') custom.push(cmd);
      else builtin.push(cmd);
    }
    const out: Group[] = [];
    if (builtin.length) out.push({ category: 'builtin', label: 'Commands', commands: builtin });
    if (skill.length) out.push({ category: 'skill', label: 'Skills', commands: skill });
    if (custom.length) out.push({ category: 'custom', label: 'Custom', commands: custom });
    return out;
  }, [registry, filter]);

  // Flatten groups to map selectedIndex back to a concrete command.
  const flat = useMemo(() => groups.flatMap((g) => g.commands), [groups]);

  // Keep the highlighted row in view when the parent moves the selection.
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const el = container.querySelector<HTMLButtonElement>(`[data-cmd-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (flat.length === 0) return null;

  let flatIndex = -1;
  return (
    <div
      ref={scrollContainerRef}
      className={cn(
        'mb-2 max-h-64 overflow-y-auto rounded-xl border backdrop-blur-md shadow-md',
        colors.panelBg,
        colors.panelBorder,
      )}
      onMouseDown={(e) => e.preventDefault() /* keep textarea focus */}
    >
      {groups.map((group, gi) => (
        <div key={group.category}>
          <div
            className={cn(
              'sticky top-0 px-3 py-1 text-[10px] font-bold uppercase tracking-wider opacity-60',
              colors.panelBg,
              colors.textMuted,
            )}
          >
            {group.label}
          </div>
          {group.commands.map((cmd) => {
            flatIndex++;
            const isActive = flatIndex === selectedIndex;
            const idx = flatIndex;
            return (
              <button
                key={`${group.category}:${cmd.name}`}
                data-cmd-index={idx}
                onMouseEnter={() => onHoverIndex(idx)}
                onClick={() => onSelect(cmd)}
                className={cn(
                  'flex w-full items-baseline gap-2 px-3 py-2 text-left text-xs transition-colors',
                  isActive && (themeMode === 'dark' ? 'bg-white/10' : 'bg-black/5'),
                )}
              >
                <span className={cn('font-mono font-semibold', colors.textMain)} style={{ color: colors.accent }}>
                  /{cmd.name}
                </span>
                {cmd.args && (
                  <span className={cn('font-mono text-[10px]', colors.textMuted)}>{cmd.args}</span>
                )}
                {cmd.description && (
                  <span className={cn('flex-1 truncate text-[11px] opacity-80', colors.textMuted)}>
                    {cmd.description}
                  </span>
                )}
              </button>
            );
          })}
          {gi < groups.length - 1 && <div className={cn('h-px mx-2 opacity-40', colors.panelBorder, 'border-t')} />}
        </div>
      ))}
    </div>
  );
}
