import React, { useEffect, useMemo, useRef } from 'react';
import { cn } from '../lib/utils';
import type { ThemeConfig, ThemeMode } from '../lib/theme';

// The third sibling of CommandPalette and ShortcodePalette: same shape, same
// keyboard contract, pointed at the ARGUMENT of `/model` rather than at a
// command name or a shortcode.
//
// What it lists is ids, because an id is the only string `/model` accepts and
// it is not what is printed anywhere she looks. The name goes underneath, in
// smaller type, so the row still reads as the model she means.

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
  context_length?: number;
  /** Added by hand through models.extra_claude / models.extra_codex. */
  custom?: boolean;
}

interface ModelPaletteProps {
  matches: ModelOption[];
  query: string;
  selectedIndex: number;
  onSelect: (model: ModelOption) => void;
  onHoverIndex: (index: number) => void;
  themeConfig: ThemeConfig;
  themeMode: ThemeMode;
  /** True while the first /api/models call is in flight. */
  loading?: boolean;
}

// The providers name themselves in the API response; these are just the
// human labels. Anything not listed falls through as itself, so a provider
// added later shows up rather than disappearing.
const PROVIDER_LABEL: Record<string, string> = {
  'claude-cli': 'Claude — CLI lane',
  anthropic: 'Claude — API',
  'codex-cli': 'Codex — CLI lane',
  codex: 'Codex — API',
  ollama: 'Ollama — local',
  openrouter: 'OpenRouter',
};

function formatContext(n?: number): string {
  if (!n) return '';
  if (n >= 1_000_000) return `${n / 1_000_000}M context`;
  if (n >= 1000) return `${Math.round(n / 1000)}k context`;
  return `${n} context`;
}

export function ModelPalette({
  matches,
  query,
  selectedIndex,
  onSelect,
  onHoverIndex,
  themeConfig,
  themeMode,
  loading,
}: ModelPaletteProps) {
  const colors = themeConfig[themeMode];

  // Group by provider, preserving the order the API returned them in — it
  // leads with the lane this house actually runs on.
  const groups = useMemo(() => {
    const out: Array<{ provider: string; models: ModelOption[] }> = [];
    for (const m of matches) {
      const last = out[out.length - 1];
      if (last && last.provider === m.provider) last.models.push(m);
      else out.push({ provider: m.provider, models: [m] });
    }
    return out;
  }, [matches]);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const el = container.querySelector<HTMLButtonElement>(`[data-model-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  // A query that matches nothing is worth saying out loud rather than closing
  // silently — an empty tray reads the same as a broken one, and the whole
  // point of this is that a typed id can be wrong.
  if (!loading && matches.length === 0 && query) {
    return (
      <div
        className={cn('mb-2 rounded-xl border px-3 py-2 backdrop-blur-md shadow-md', colors.panelBg, colors.panelBorder)}
      >
        <span className={cn('text-sm', colors.textMuted)}>No model id contains “{query}”.</span>
      </div>
    );
  }
  if (loading && matches.length === 0) {
    return (
      <div
        className={cn('mb-2 rounded-xl border px-3 py-2 backdrop-blur-md shadow-md', colors.panelBg, colors.panelBorder)}
      >
        <span className={cn('text-sm', colors.textMuted)}>Reading the model list…</span>
      </div>
    );
  }
  if (matches.length === 0) return null;

  let flatIndex = -1;
  return (
    <div
      ref={scrollContainerRef}
      className={cn(
        'mb-2 max-h-64 overflow-y-auto rounded-xl border backdrop-blur-md shadow-md',
        colors.panelBg,
        colors.panelBorder,
      )}
      role="listbox"
      aria-label={query ? `Models matching ${query}` : 'Models'}
      onMouseDown={(e) => e.preventDefault() /* keep textarea focus */}
    >
      {groups.map((group) => (
        <div key={group.provider}>
          <div
            className={cn(
              'sticky top-0 px-3 py-1 text-[10px] font-bold uppercase tracking-wider opacity-60',
              colors.panelBg,
              colors.textMuted,
            )}
          >
            {PROVIDER_LABEL[group.provider] || group.provider}
          </div>
          {group.models.map((m) => {
            flatIndex += 1;
            const i = flatIndex;
            return (
              <button
                key={`${m.provider}:${m.id}`}
                type="button"
                role="option"
                aria-selected={i === selectedIndex}
                data-model-index={i}
                onMouseEnter={() => onHoverIndex(i)}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onSelect(m);
                }}
                className={cn(
                  'w-full px-3 py-2 text-left transition-colors',
                  i === selectedIndex ? 'bg-black/10 dark:bg-white/10' : 'hover:bg-black/5 dark:hover:bg-white/5',
                )}
              >
                <div className={cn('text-sm font-mono truncate', colors.textMain)}>{m.id}</div>
                <div className={cn('text-[11px] truncate', colors.textMuted)}>
                  {m.name}
                  {m.context_length ? ` · ${formatContext(m.context_length)}` : ''}
                  {m.custom ? ' · yours' : ''}
                </div>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
