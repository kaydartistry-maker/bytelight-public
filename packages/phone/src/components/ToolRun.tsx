// One chip per run of tool calls. Collapsed it is a single pill ("7 tools");
// tapped it opens the list, and each call in the list opens to its raw name,
// input and output. Family glyphs and accents match the web client's
// silver-wire set (MessageBubble.svelte familyIcon + .inline-tool[data-family]),
// so a tool reads the same on both surfaces. While a reply is streaming
// (`live`), calls still waiting on output spin.
import React, { useState } from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';
import { cn } from '../lib/utils';
import type { ThemeConfig } from '../lib/theme';
import { humanizeToolName, toolFamily, FAMILY_LABELS, type ToolFamily } from '../lib/tool-names';
import { formatToolOutput, type ToolSegment } from '../lib/tool-runs';

const FAMILY_ACCENT: Record<ToolFamily, string> = {
  memory: '#a78bfa',   // violet
  comms: '#4fd6c8',    // teal
  creation: '#d8a24a', // warm amber
  system: '#8b8f99',   // cool smoke
};

export function FamilyGlyph({ family, size = 13 }: { family: ToolFamily; size?: number }) {
  return (
    <span aria-label={FAMILY_LABELS[family]} className="inline-flex shrink-0" style={{ color: FAMILY_ACCENT[family] }}>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        {family === 'memory' && (
          <>
            <path d="M12 5.5c-1-1.3-3.4-1.2-4.3.3-1.6-.2-3 1.1-2.7 2.7-1.2.8-1.2 2.7 0 3.5-.4 1.6 1 3 2.6 2.8.7 1.4 3 1.6 4.4.4" />
            <path d="M12 5.5c1-1.3 3.4-1.2 4.3.3 1.6-.2 3 1.1 2.7 2.7 1.2.8 1.2 2.7 0 3.5.4 1.6-1 3-2.6 2.8-.7 1.4-3 1.6-4.4.4" />
            <path d="M12 5.5v10.5" />
            <path d="M9 9.2c.9.3 1.6 1 1.9 1.9M15 9.2c-.9.3-1.6 1-1.9 1.9" />
          </>
        )}
        {family === 'comms' && (
          <path d="M6 5.5h12a2.5 2.5 0 0 1 2.5 2.5v5a2.5 2.5 0 0 1-2.5 2.5h-6.5l-4 3v-3H6A2.5 2.5 0 0 1 3.5 13V8A2.5 2.5 0 0 1 6 5.5Z" />
        )}
        {family === 'creation' && (
          <>
            <path d="M16.5 5.5l2 2" />
            <path d="M17.5 4.5a1.4 1.4 0 0 1 2 2L8.5 17.5l-3 1 1-3 11-11Z" />
          </>
        )}
        {family === 'system' && (
          <>
            <path d="M13.5 8.5l-8 8" />
            <path d="M14 5.5l4.5 4.5" />
            <path d="M12.2 6.8l5 5 1.8-1.8a1.3 1.3 0 0 0 0-1.8l-3.2-3.2a1.3 1.3 0 0 0-1.8 0Z" />
          </>
        )}
      </svg>
    </span>
  );
}

interface ToolRunProps {
  tools: ToolSegment[];
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  /** Reply is still streaming: a call with no output yet is running, not empty. */
  live?: boolean;
}

export function ToolRun({ tools, themeConfig, themeMode, live = false }: ToolRunProps) {
  const colors = themeConfig[themeMode];
  const [open, setOpen] = useState(false);
  // Keyed by position in the run, not toolId: ids can arrive empty, and a
  // run only ever grows at the end, so an index stays put.
  const [openTools, setOpenTools] = useState<Set<number>>(new Set());
  const errors = tools.filter((t) => t.isError).length;
  const isRunning = (t: ToolSegment) => live && !t.isError && t.output === undefined;
  const running = tools.filter(isRunning).length;
  // Distinct families in the run, in first-seen order, for the collapsed pill.
  const families = [...new Set(tools.map((t) => toolFamily(t.toolName)))];

  const toggleTool = (id: number) =>
    setOpenTools((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className={cn('my-0.5 flex flex-col', open ? 'self-stretch' : 'self-start')}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        className={cn('flex items-center gap-1.5 self-start rounded-full border px-2.5 py-1 text-[11px] transition-opacity', colors.panelBorder, open ? 'opacity-90' : 'opacity-65 hover:opacity-90')}
        style={{ background: 'rgba(127,127,127,0.08)' }}
        aria-expanded={open}
      >
        <span className="flex items-center gap-0.5">
          {families.map((f) => <FamilyGlyph key={f} family={f} size={12} />)}
        </span>
        <span>{tools.length} tool{tools.length !== 1 ? 's' : ''}</span>
        {running > 0 && <Loader2 size={11} className="shrink-0 animate-spin opacity-80" aria-label="running" />}
        {errors > 0 && <span className="rounded-full bg-red-500/15 px-1.5 text-[10px] text-red-400">{errors} error{errors !== 1 ? 's' : ''}</span>}
        <ChevronRight size={11} className={cn('shrink-0 transition-transform', open ? 'rotate-90' : '')} />
      </button>

      {open && (
        <div className={cn('mt-1 flex flex-col overflow-hidden rounded-xl border', colors.panelBorder)} style={{ background: 'rgba(127,127,127,0.06)' }}>
          {tools.map((t, i) => {
            const family = toolFamily(t.toolName);
            const expanded = openTools.has(i);
            const openable = Boolean(t.input || t.output);
            return (
              <div key={i} className={cn(i > 0 && 'border-t', colors.panelBorder)}>
                <button
                  onClick={(e) => { e.stopPropagation(); if (openable) toggleTool(i); }}
                  disabled={!openable}
                  className="flex w-full min-w-0 items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px]"
                >
                  <FamilyGlyph family={family} />
                  <span className="shrink-0 font-semibold" style={{ color: FAMILY_ACCENT[family] }}>{humanizeToolName(t.toolName)}</span>
                  <span className="min-w-0 flex-1 truncate font-mono opacity-55">{t.input ?? ''}</span>
                  {t.isError
                    ? <span className="shrink-0 rounded-full bg-red-500/15 px-1.5 text-[10px] text-red-400">error</span>
                    : isRunning(t) ? <Loader2 size={11} className="shrink-0 animate-spin opacity-70" aria-label="running" />
                    : t.output ? <span className="shrink-0 text-emerald-400" title="done">✓</span> : null}
                  {openable && <ChevronRight size={11} className={cn('shrink-0 opacity-60 transition-transform', expanded ? 'rotate-90' : '')} />}
                </button>
                {expanded && openable && (
                  <div className="px-2.5 pb-2">
                    {/* Mobile has no hover tooltip, so the raw wire name lives here. */}
                    <div className="mb-1 flex items-center gap-1 font-mono text-[10px] opacity-50">
                      <FamilyGlyph family={family} size={10} />
                      <span className="truncate">{t.toolName}</span>
                    </div>
                    {t.input && (
                      <pre className="mb-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/25 p-2 font-mono text-[10.5px] leading-snug opacity-75">{t.input}</pre>
                    )}
                    {t.output
                      ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/30 p-2 font-mono text-[10.5px] leading-snug opacity-85">{formatToolOutput(t.output)}</pre>
                      : isRunning(t) && <div className="font-mono text-[10.5px] italic opacity-55">running…</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
