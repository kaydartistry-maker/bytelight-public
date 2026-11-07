// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
//
// One squash on the owner Compactions page, closed or opened. A view and nothing
// else: it is handed the row and the text, so it can be drawn on the server
// in a test exactly the way the phone draws it.
//
// Closed, a row says when, whose head it came from, how much was squashed,
// and (from the house of today) the part of the summary that changes from one
// squash to the next, under a word saying which part it is. Every summary of
// the shared room opens with the same standing paragraph, so a preview cut
// from the top made different squashes look like copies (their catch, Oct 21
// 2026). Opened, it is the whole summary, rendered as the markdown it is.

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { Scissors, Loader2, ChevronDown, ChevronRight } from 'lucide-react';
import type { ThemeColors } from '../lib/theme';
import { cn } from '../lib/utils';
import { previewLabel, whenLabel, type CompactionRow } from '../lib/compactions';

interface Props {
  row: CompactionRow;
  isOpen: boolean;
  /** The whole summary, once it has been fetched. */
  fullText: string | null;
  /** Fetching the whole summary right now. */
  opening: boolean;
  colors: ThemeColors;
  onToggle: (row: CompactionRow) => void;
}

export function CompactionCard({ row, isOpen, fullText, opening, colors, onToggle }: Props) {
  const label = previewLabel(row.previewFrom);
  // From the house of today the preview is the part that changes, worth
  // showing closed. From the older house it is the standing paragraph every
  // summary opens with, so the closed row stays as it was and it waits for
  // the row to be opened.
  const showPreview = row.previewFrom !== null && row.preview.length > 0;
  const body = fullText ?? (row.id ? null : row.preview);
  return (
    <div className={cn('rounded-2xl border overflow-hidden', colors.panelBg, colors.panelBorder)}>
      <button onClick={() => onToggle(row)} className="w-full p-3 text-left flex items-start gap-2" aria-expanded={isOpen}>
        <Scissors size={14} className="mt-0.5 shrink-0" style={{ color: colors.accent }} />
        <span className="flex-1 min-w-0">
          <span className={cn('block text-sm font-medium', colors.textMain)}>{whenLabel(row.at)}</span>
          <span className={cn('block text-xs', colors.textMuted)}>
            {row.whose} · {row.chars.toLocaleString()} characters squashed
          </span>
          {showPreview && (
            <span className={cn('block text-xs mt-1.5 leading-relaxed break-words', colors.textMain)}>
              {label && <span className={cn('font-semibold', colors.textMuted)}>{label}: </span>}
              {row.preview}
            </span>
          )}
        </span>
        {isOpen ? <ChevronDown size={14} className="mt-1 shrink-0" /> : <ChevronRight size={14} className="mt-1 shrink-0" />}
      </button>
      {isOpen && (
        <div className={cn('px-3 pb-3 text-xs break-words space-y-1.5', colors.textMuted)}>
          {body === null ? (
            <span className="flex items-center gap-1.5">
              {opening ? (
                <><Loader2 size={12} className="animate-spin" /> Opening the whole summary…</>
              ) : (
                <>The whole summary could not be read just now. Close it and open it again to try once more.</>
              )}
            </span>
          ) : (
            <>
              {/* The summary is written as markdown by the summariser. Render it as
                  markdown rather than raw text so the headings and emphasis it already
                  carries read as structure instead of asterisks. */}
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkBreaks]}
                components={{
                  p: ({ children }) => <span className="block">{children}</span>,
                  strong: ({ children }) => (
                    <strong className={cn('font-semibold', colors.textMain)}>{children}</strong>
                  ),
                  h1: ({ children }) => (
                    <span className={cn('block text-sm font-semibold mt-2', colors.textMain)}>{children}</span>
                  ),
                  h2: ({ children }) => (
                    <span className={cn('block text-sm font-semibold mt-2', colors.textMain)}>{children}</span>
                  ),
                  h3: ({ children }) => (
                    <span className={cn('block text-xs font-semibold mt-2', colors.textMain)}>{children}</span>
                  ),
                  ul: ({ children }) => <ul className="list-disc pl-4 space-y-0.5">{children}</ul>,
                  ol: ({ children }) => <ol className="list-decimal pl-4 space-y-0.5">{children}</ol>,
                  code: ({ children }) => (
                    <code className="px-1 py-0.5 rounded bg-black/20 text-[11px] break-all">{children}</code>
                  ),
                  pre: ({ children }) => (
                    <pre className="p-2 rounded bg-black/20 text-[11px] overflow-x-auto">{children}</pre>
                  ),
                }}
              >
                {body}
              </ReactMarkdown>
              {fullText === null && row.cut && (
                <span className="flex items-center gap-1.5 opacity-60">
                  {opening ? <><Loader2 size={12} className="animate-spin" /> Opening the rest…</> : '…'}
                </span>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
