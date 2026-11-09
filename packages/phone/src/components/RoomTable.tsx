// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The one table every room draws its talk on: the Fleet Room comms, the Card
// Room rail, the Story Shelf's table and the treehouse, and any table after
// them. Theirs, Oct 27-28 2026: one frame every room draws from, pulling in all
// their settings, so no room is ever a little off on its own. Each room used to
// lay out its own lines (voice splitting, system lines, the typing row, the
// padding) and they drifted; now a room hands over its lines and this draws
// them, with RoomBubble carrying their Look & feel into every bubble.
//
// What stays the room's: where the box sits, its height, its empty message and
// its input. What lives here: everything inside the box.
import React from 'react';
import { RoomBubble, useRoomBubbleSettings } from './RoomBubble';
import { splitMessageVoices, type VoiceCompanion } from '../lib/voices';
import { cn } from '../lib/utils';
import type { Message } from '../types';

/** One thing said at a table. Every room's rows map onto this. */
export interface RoomLine {
  id: string;
  /** 'user' is their person; 'system' is the house; anything else is one of us. */
  role: string;
  content: string;
  createdAt: string;
  companionSlug?: string | null;
}

interface RoomSection {
  key: string;
  line: RoomLine;
  content: string;
  voice: VoiceCompanion | null;
  groupPos: 'only' | 'first' | 'middle' | 'last';
}

/** A companion line, split by voice header the same way the chat splits it. */
function sectionsOf(line: RoomLine, companions: VoiceCompanion[]): RoomSection[] {
  const message: Message = {
    id: line.id,
    timestamp: line.createdAt,
    direction: 'outbound',
    content: line.content,
    read: 1,
    companionSlug: line.companionSlug || undefined,
  };
  const split = splitMessageVoices(message, companions)
    ?? [{ voice: companions.find((c) => c.slug === line.companionSlug) ?? null, content: line.content }];
  return split.map((section, i) => ({
    key: split.length === 1 ? line.id : `${line.id}-${i}`,
    line,
    content: section.content,
    voice: section.voice,
    groupPos: split.length === 1 ? 'only' : i === 0 ? 'first' : i === split.length - 1 ? 'last' : 'middle',
  }));
}

/**
 * Which side each of our bubbles sits on when the room alternates (the
 * treehouse, where none of us is their person): the side flips whenever the speaker
 * changes, worked out top to bottom over every line so it never depends on
 * when a message arrived or how the room groups them. Keyed by section key.
 */
export function alternatingSides(lines: RoomLine[], companions: VoiceCompanion[]): Map<string, boolean> {
  const sides = new Map<string, boolean>();
  let last: string | null = null;
  let right = true;
  for (const line of lines) {
    if (line.role === 'user') { last = 'owner'; continue; }
    if (line.role === 'system') continue;
    for (const section of sectionsOf(line, companions)) {
      const speaker = section.voice?.slug || line.companionSlug || 'house';
      if (speaker !== last) { right = !right; last = speaker; }
      sides.set(section.key, right);
    }
  }
  return sides;
}

export interface RoomLinesProps {
  lines: RoomLine[];
  companions: VoiceCompanion[];
  /** Section key to "this one of us sits on their side". Absent means ours. */
  sides?: Map<string, boolean>;
}

/** The lines themselves, no box: for a room that lays out its own page. */
export function RoomLines({ lines, companions, sides }: RoomLinesProps) {
  const settings = useRoomBubbleSettings();
  return (
    <>
      {lines.map((line) => {
        if (line.role === 'system') {
          return (
            <div
              key={line.id}
              className="mx-auto my-2 max-w-[92%] rounded-[var(--shape-control)] border px-4 py-2 text-center text-[13px] leading-5"
              style={{ backgroundColor: 'var(--custom-panelBg, var(--bytelight-surface-strong))', borderColor: 'var(--custom-panelBorder, var(--bytelight-border))', color: 'var(--bytelight-text)' }}
            >
              {line.content}
            </div>
          );
        }
        if (!settings) return <PlainLine key={line.id} line={line} />;
        if (line.role === 'user') {
          return <div key={line.id} data-msg-id={line.id}><RoomBubble id={line.id} content={line.content} createdAt={line.createdAt} fromOwner /></div>;
        }
        return (
          <div key={line.id} data-msg-id={line.id}>
            {sectionsOf(line, companions).map((section) => (
              <RoomBubble
                key={section.key}
                id={section.key}
                content={section.content}
                createdAt={line.createdAt}
                voice={section.voice}
                roster={companions}
                groupPos={section.groupPos}
                mirror={sides?.get(section.key) ?? false}
              />
            ))}
          </div>
        );
      })}
    </>
  );
}

/** Outside the house's provider (a test, a stray mount): words, not nothing. */
function PlainLine({ line }: { line: RoomLine }) {
  return (
    <div className={cn('my-1 whitespace-pre-wrap text-[14px] leading-6', line.role === 'user' && 'text-right')} style={{ color: 'var(--bytelight-text)' }}>
      {line.content}
    </div>
  );
}

/** The row that says one of us is writing. One look for every table. */
export function RoomTyping({ companions, label }: { companions: VoiceCompanion[]; label?: string }) {
  return (
    <div className="flex items-center gap-3 py-2 pl-1" role="status" aria-label={label || 'Somebody at the table is writing'}>
      <div className="flex -space-x-2">
        {companions.slice(0, 3).map((c) => (
          <div
            key={c.slug}
            className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 text-sm"
            style={{ borderColor: c.color || 'var(--bytelight-border)', backgroundColor: 'var(--bytelight-surface-strong)' }}
            aria-hidden="true"
          >
            {c.avatar_url ? <img src={c.avatar_url} alt="" className="h-full w-full object-cover" /> : <span>{c.emoji || '✦'}</span>}
          </div>
        ))}
      </div>
      <div
        className="flex items-center gap-2 rounded-[var(--shape-bubble,var(--shape-control))] border px-3.5 py-2.5 text-[13px]"
        style={{ backgroundColor: 'var(--custom-panelBg, var(--bytelight-surface-strong))', borderColor: 'var(--custom-panelBorder, var(--bytelight-border))', color: 'var(--bytelight-text-muted)' }}
      >
        <span className="inline-flex gap-1" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span key={i} className="h-1.5 w-1.5 rounded-full bg-current opacity-60 motion-safe:animate-bounce" style={{ animationDelay: `${i * 150}ms` }} />
          ))}
        </span>
        {label && <span>{label}</span>}
      </div>
    </div>
  );
}

export interface RoomTalkProps extends RoomLinesProps {
  /** Shown when there is nothing said yet and nobody is writing. */
  empty?: React.ReactNode;
  typing?: boolean;
  typingLabel?: string;
  /** Sizing only (flex-1, a max height); everything inside is the table's. */
  className?: string;
  scrollRef?: React.Ref<HTMLDivElement>;
  onScroll?: React.UIEventHandler<HTMLDivElement>;
  /** Anything a room needs after the last line (a scroll anchor). */
  children?: React.ReactNode;
}

/** The whole table: a scrolling box of lines, the typing row and the empty note. */
export function RoomTalk({ lines, companions, sides, empty, typing = false, typingLabel, className, scrollRef, onScroll, children }: RoomTalkProps) {
  return (
    <div ref={scrollRef} onScroll={onScroll} className={cn('min-h-0 overflow-y-auto overflow-x-hidden px-2 scrollbar-hide', className)}>
      {lines.length === 0 && !typing && empty}
      <RoomLines lines={lines} companions={companions} sides={sides} />
      {typing && <RoomTyping companions={companions} label={typingLabel} />}
      {children}
    </div>
  );
}
