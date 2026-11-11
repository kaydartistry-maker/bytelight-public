import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { cn } from '../lib/utils';
import { ThemeColors, ThemeConfig } from '../lib/theme';
import { AVATAR, type SpeakerSegment, type InterleavedRow, type SpeakerId } from '../lib/speakers';
import { CodeBlock } from './CodeBlock';
import { MessageSegments } from './MessageSegments';
import type { MessageSegment } from '../bytelight';
import type { CustomEmoji } from '../types';
import { resolveStickerRef } from '../bytelight/stickers';
import { prepareChatText, stickerSizeClass, stickerSrc } from '../lib/chat-text';

// Per-speaker bubble stack — the visual carried over from the Svelte house
// (MessageBubble.svelte speaker bubbles).
// A mixed Companion A/Companion B message renders as one chrome-less wrapper holding a
// chrome'd bubble per speaker; unmarked leading narration gets the neutral
// ✨ fallback bubble. Markers are already stripped by splitBySpeaker.

const NAMES: Record<string, string> = {
  'companion-a': 'Companion A',
  'companion-b': 'Companion B',
  'companion-c': 'Companion C',
};

export interface RosterFace {
  slug: string;
  display_name: string;
  avatar_url: string | null;
  color: string | null;
  emoji: string | null;
}

interface SpeakerBubblesProps {
  rows: SpeakerSegment[];
  roster?: RosterFace[];
  colors: ThemeColors;
  textColorClass: string;
  isLightText: boolean;
  customEmojis?: CustomEmoji[];
}

// The little face beside a speaker's bubble — same recipe as the voice
// avatar rail in MessageBubble (w-9 rounded, companion color ring,
// emoji/initial fallback), one per split row.
function SpeakerFace({ face, fallbackEmoji, name }: { face?: RosterFace; fallbackEmoji: string; name: string }) {
  return (
    <div className="-ml-1.5 mr-2 mt-0.5 shrink-0 self-start" title={name}>
      {face?.avatar_url ? (
        <img
          src={face.avatar_url}
          alt={name}
          referrerPolicy="no-referrer"
          loading="lazy"
          decoding="async"
          className="w-9 h-9 rounded-full object-cover border-2"
          style={{ borderColor: face.color || 'transparent' }}
        />
      ) : (
        <div
          className="w-9 h-9 rounded-full flex items-center justify-center text-base border-2"
          style={{ borderColor: face?.color || 'transparent', background: 'rgba(127,127,127,0.15)' }}
        >
          {face?.emoji || fallbackEmoji}
        </div>
      )}
    </div>
  );
}

export function SpeakerBubbles({ rows, roster, colors, textColorClass, isLightText, customEmojis }: SpeakerBubblesProps) {
  const faceFor = (speaker: string): RosterFace | undefined =>
    roster?.find((c) => c.slug === speaker || c.display_name.toLowerCase() === speaker);
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((row, i) => {
        const { markdown, emoteOnly } = prepareChatText({ text: row.text, resolveSticker: resolveStickerRef, customEmojis });
        return (
          <div key={i} className="flex items-start">
          {row.speaker !== 'fallback' && (
            <SpeakerFace
              face={faceFor(row.speaker)}
              fallbackEmoji={AVATAR[row.speaker]}
              name={NAMES[row.speaker] ?? row.speaker}
            />
          )}
          <div
            data-user="false"
            data-speaker={row.speaker}
            className={cn(
              'bytelight-message-bubble min-w-0 flex-1 border px-3.5 py-2.5 rounded-[var(--shape-bubble)]',
              'rounded-tl-none',
              row.speaker === 'fallback' && 'ml-[38px]',
              colors.compBubbleBg,
              colors.panelBorder,
            )}
          >
          {row.speaker !== 'fallback' && (
            <div className={cn('mb-0.5 text-[11px] font-bold tracking-wide opacity-80 select-none', textColorClass)}>
              {NAMES[row.speaker] ?? row.speaker}
            </div>
          )}
          <div
            className={cn(
              'prose prose-sm max-w-none prose-p:leading-relaxed prose-p:my-0 prose-pre:bg-black/30 prose-img:inline prose-img:m-0 select-text [overflow-wrap:anywhere] min-w-0',
              isLightText ? 'prose-invert' : '',
              row.speaker === 'fallback' ? 'italic opacity-90' : '',
              textColorClass,
            )}
            style={{
              fontFamily: 'inherit',
              ['--tw-prose-body' as string]: 'inherit',
              ['--tw-prose-headings' as string]: 'inherit',
              ['--tw-prose-links' as string]: 'inherit',
              ['--tw-prose-bold' as string]: 'inherit',
              ['--tw-prose-bullets' as string]: 'inherit',
              ['--tw-prose-counters' as string]: 'inherit',
              ['--tw-prose-quotes' as string]: 'inherit',
              ['--tw-prose-code' as string]: 'inherit',
              ['--tw-prose-invert-body' as string]: 'inherit',
              ['--tw-prose-invert-headings' as string]: 'inherit',
              ['--tw-prose-invert-links' as string]: 'inherit',
              ['--tw-prose-invert-bold' as string]: 'inherit',
              ['--tw-prose-invert-bullets' as string]: 'inherit',
              ['--tw-prose-invert-counters' as string]: 'inherit',
              ['--tw-prose-invert-quotes' as string]: 'inherit',
              ['--tw-prose-invert-code' as string]: 'inherit',
            } as React.CSSProperties}
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkBreaks]}
              components={{
                p: ({ children }) => <span className="block">{children}</span>,
                h6: ({ children }) => (
                  <span className="block text-[11px] leading-snug opacity-60 italic">{children}</span>
                ),
                pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
                img: ({ node, src, alt, ...imageProps }) => {
                  if (alt?.startsWith('sticker:') && src) {
                    return <img src={stickerSrc(src)} alt={alt.slice('sticker:'.length)} referrerPolicy="no-referrer" className={cn(
                      '!inline-block !w-auto object-contain',
                      stickerSizeClass(src),
                    )} />;
                  }
                  const code = alt?.startsWith('emoji:') ? alt.slice('emoji:'.length) : undefined;
                  const emoji = customEmojis?.find((entry) => entry.shortcode === code);
                  if (emoji) {
                    return <img src={emoji.url} alt={code} referrerPolicy="no-referrer" className={cn(
                      '!inline-block !w-auto !my-0 mx-0.5 align-text-bottom rounded-sm object-contain',
                      emoteOnly ? '!h-12' : '!h-[1.75em]',
                    )} />;
                  }
                  return <img src={src} alt={alt} {...imageProps} />;
                },
              }}
            >
              {markdown}
            </ReactMarkdown>
          </div>
          </div>
          </div>
        );
      })}
    </div>
  );
}


// Interleaved variant — BL's splitInterleaved rendering: text rows become
// per-speaker bubbles, thinking/tool chips ride between them unchrome'd,
// speaker continuity carrying across chips (handled by the splitter).
interface SpeakerSegmentStackProps {
  rows: InterleavedRow<MessageSegment>[];
  roster?: RosterFace[];
  colors: ThemeColors;
  textColorClass: string;
  isLightText: boolean;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  customEmojis?: CustomEmoji[];
}

export function SpeakerSegmentStack({ rows, roster, colors, textColorClass, isLightText, themeConfig, themeMode, customEmojis }: SpeakerSegmentStackProps) {
  // Consecutive chip rows share ONE MessageSegments so a run of tool calls
  // folds into a single ToolRun chip instead of one chip per call.
  const blocks: Array<{ kind: 'text'; speaker: SpeakerId; text: string } | { kind: 'chips'; segments: MessageSegment[] }> = [];
  for (const row of rows) {
    if (row.kind === 'text') { blocks.push({ kind: 'text', speaker: row.speaker, text: row.text }); continue; }
    const last = blocks[blocks.length - 1];
    if (last && last.kind === 'chips') last.segments.push(row.segment);
    else blocks.push({ kind: 'chips', segments: [row.segment] });
  }
  return (
    <div className="flex flex-col gap-1.5">
      {blocks.map((row, i) =>
        row.kind === 'text' ? (
          <SpeakerBubbles
            key={i}
            rows={[{ speaker: row.speaker, text: row.text }]}
            roster={roster}
            colors={colors}
            textColorClass={textColorClass}
            isLightText={isLightText}
            customEmojis={customEmojis}
          />
        ) : (
          <div key={i} className="px-1 ml-[38px]">
            <MessageSegments
              segments={row.segments}
              themeConfig={themeConfig}
              themeMode={themeMode}
              customEmojis={customEmojis}
              textClass={textColorClass}
            />
          </div>
        ),
      )}
    </div>
  );
}
