import React, { useState, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { Brain, ChevronRight, RefreshCw } from 'lucide-react';
import { cn } from '../lib/utils';
import { ThemeConfig } from '../lib/theme';
import { CustomEmoji } from '../types';
import type { MessageSegment } from '../bytelight';
import { resolveStickerRef } from '../bytelight';
import { coalesceThinkingSegments, isAuthoredThinking, plainThinkingText, thinkingTitle } from '../lib/thinking';
import { CodeBlock } from './CodeBlock';
import { prepareChatText } from '../lib/chat-text';
import { groupToolRuns, isHiddenTool } from '../lib/tool-runs';
import { ToolRun } from './ToolRun';

interface MessageSegmentsProps {
  segments: MessageSegment[];
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  customEmojis?: CustomEmoji[];
  textClass?: string;
}

// Make the typography plugin inherit the bubble's text color rather than its
// own grays — matches the plain-text path in MessageBubble.
const PROSE_INHERIT: React.CSSProperties = {
  ['--tw-prose-body' as string]: 'inherit',
  ['--tw-prose-headings' as string]: 'inherit',
  ['--tw-prose-bold' as string]: 'inherit',
  ['--tw-prose-bullets' as string]: 'inherit',
  ['--tw-prose-counters' as string]: 'inherit',
  ['--tw-prose-quotes' as string]: 'inherit',
  ['--tw-prose-code' as string]: 'inherit',
  ['--tw-prose-links' as string]: 'inherit',
  ['--tw-prose-invert-body' as string]: 'inherit',
  ['--tw-prose-invert-headings' as string]: 'inherit',
  ['--tw-prose-invert-bold' as string]: 'inherit',
  ['--tw-prose-invert-bullets' as string]: 'inherit',
  ['--tw-prose-invert-code' as string]: 'inherit',
  ['--tw-prose-invert-links' as string]: 'inherit',
} as React.CSSProperties;

// Renders the interleaved text / tool-call / thinking segments the backend
// persists on a finalized companion message. Tool and thinking blocks are
// collapsible and start collapsed. Consecutive tool calls fold into one
// ToolRun chip that opens to the list, and each call opens to its output.
export function MessageSegments({ segments, themeConfig, themeMode, customEmojis, textClass }: MessageSegmentsProps) {
  const colors = themeConfig[themeMode];
  const [openThinking, setOpenThinking] = useState<Set<number>>(new Set());
  const displaySegments = useMemo(() => coalesceThinkingSegments(segments), [segments]);

  const isLight = textClass === 'text-white' || /text-\[#[CDEFcdef]/i.test(textClass || '');

  const items = useMemo(() => groupToolRuns(displaySegments, isHiddenTool), [displaySegments]);

  const toggleThinking = (i: number) =>
    setOpenThinking((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <div className="flex flex-col gap-1">
      {items.map((item) => {
        if (item.kind === 'tools') {
          return <ToolRun key={`tools-${item.index}`} tools={item.tools} themeConfig={themeConfig} themeMode={themeMode} />;
        }
        const seg = item.segment;
        const i = item.index;
        if (seg.type === 'text') {
          if (!seg.content.trim()) return null;
          const { markdown, stickerSharesText, emoteOnly } = prepareChatText({ text: seg.content, resolveSticker: resolveStickerRef, customEmojis });
          const emoteSizeClass = emoteOnly ? '!h-12' : '!h-[1.75em]';
          return (
            <div
              key={`text-${i}`}
              className={cn(
                'prose prose-sm max-w-none prose-p:my-0 prose-p:leading-relaxed prose-pre:bg-black/30 select-text',
                isLight ? 'prose-invert' : '',
                textClass,
              )}
              style={PROSE_INHERIT}
            >
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkBreaks]}
                components={{
                  p: ({ children }) => <span className="block">{children}</span>,
                  // Discord-style "-# whisper" subtext (preprocessed to h6 above)
                  h6: ({ children }) => <span className="block text-[11px] leading-snug opacity-60 italic">{children}</span>,
                  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
                  img: ({ src, alt }) => {
                    // Sticker refs: alt starts with "sticker:" and src is the resolved URL
                    if (alt?.startsWith('sticker:') && src) {
                      return (
                        <img
                          src={src}
                          alt={alt.slice('sticker:'.length)}
                          className={cn(
                            '!inline-block !w-auto object-contain',
                            stickerSharesText
                              ? '!h-[1.75em] !max-h-[1.75em] !my-0 mx-0.5 align-text-bottom'
                              : 'max-h-32 align-bottom',
                          )}
                          referrerPolicy="no-referrer"
                        />
                      );
                    }
                    // Custom emoji refs
                    const code = (src?.startsWith('emoji:') ? src : alt)?.split(':')[1];
                    const emoji = customEmojis?.find((e) => e.shortcode === code);
                    if (emoji) {
                      return (
                        <img
                          src={emoji.url}
                          alt={code}
                          className={cn('!inline-block !w-auto !my-0 mx-0.5 align-text-bottom rounded-sm object-contain', emoteSizeClass)}
                          referrerPolicy="no-referrer"
                        />
                      );
                    }
                    return null;
                  },
                }}
              >
                {markdown}
              </ReactMarkdown>
            </div>
          );
        }

        if (seg.type === 'thinking') {
          // CLI-lane session recycle note → distinct badge instead of a
          // generic thinking block, so the seam is visible at a glance.
          if ((seg.content || seg.summary || '').startsWith('[Session recycled')) {
            return (
              <div
                key={`recycle-${i}`}
                className={cn('my-0.5 flex items-center gap-1.5 self-start rounded-full border px-2.5 py-1 text-[11px] opacity-75', colors.panelBorder)}
                style={{ background: 'rgba(127,127,127,0.08)' }}
              >
                <RefreshCw size={11} className="shrink-0" />
                <span>Session recycled — re-primed with recent history</span>
              </div>
            );
          }
          // Reply window timeout note → small badge, not a full thinking block
          if ((seg.content || seg.summary || '').startsWith('[Reply window closed')) {
            return (
              <div
                key={`timeout-${i}`}
                className={cn('my-0.5 flex items-center gap-1.5 self-start rounded-full border px-2.5 py-1 text-[11px] opacity-75', colors.panelBorder)}
                style={{ background: 'rgba(127,127,127,0.08)' }}
              >
                <RefreshCw size={11} className="shrink-0" />
                <span>Reply window closed before my final line — it arrived with the next turn</span>
              </div>
            );
          }
          // Nothing to open. A card with no thought behind it still renders a
          // tappable row that answers with an empty box, which reads as broken
          // rather than as silence. Legacy rows reach here uncoalesced.
          if (!plainThinkingText(seg.content || seg.summary || '')) return null;
          const open = openThinking.has(i);
          const title = thinkingTitle(seg.summary || seg.content);
          return (
            <div
              key={`think-${i}`}
              className={cn('my-0.5 rounded-lg border', colors.panelBorder)}
              style={{ background: 'rgba(127,127,127,0.06)' }}
            >
              <button
                onClick={(e) => { e.stopPropagation(); toggleThinking(i); }}
                className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs italic opacity-75"
              >
                <Brain size={12} className="shrink-0" />
                {isAuthoredThinking(seg) && (
                  <span className="shrink-0 rounded-full border border-current/20 px-1.5 py-0.5 text-[9px] font-semibold not-italic uppercase tracking-wide opacity-80">
                    reflection
                  </span>
                )}
                {seg.kind === 'system' && (
                  <span className="shrink-0 rounded-full border border-current/20 px-1.5 py-0.5 text-[9px] font-semibold not-italic uppercase tracking-wide opacity-70">
                    system
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">{title}</span>
                {seg.content && (
                  <ChevronRight
                    size={12}
                    className={cn('shrink-0 transition-transform', open ? 'rotate-90' : '')}
                  />
                )}
              </button>
              {open && seg.content && (
                <div className="whitespace-pre-wrap break-words px-2.5 pb-2 text-[11px] leading-relaxed opacity-70">
                  {plainThinkingText(seg.content)}
                </div>
              )}
            </div>
          );
        }

        if (seg.type === 'sticker' || seg.type === 'emoji') {
          // Jumbo emotes when the whole message is just emoji/sticker segments.
          const mediaOnly = displaySegments.every(
            (s) => s.type === 'emoji' || s.type === 'sticker' || (s.type === 'text' && !s.content.trim()),
          );
          return (
            <img
              key={`media-${i}`}
              src={seg.url}
              alt={seg.name}
              referrerPolicy="no-referrer"
              className={
                seg.type === 'emoji'
                  ? cn('inline-block w-auto align-text-bottom', mediaOnly ? 'h-12' : 'h-[1.75em]')
                  : 'my-1 max-h-40 w-auto rounded-lg object-contain'
              }
            />
          );
        }

        return null;
      })}
    </div>
  );
}
