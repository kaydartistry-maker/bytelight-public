// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import { themeInk } from '../../lib/theme-ink';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import {
  Anchor,
  Crosshair,
  LoaderCircle,
  Maximize2,
  MessageCircle,
  Minimize2,
  Radio,
  RefreshCw,
  RotateCw,
  Send,
  Shuffle,
  Waves,
  Sticker,
} from 'lucide-react';
import { StickerPicker } from '../StickerPicker';
import { isStickerImage, StickerImage, stickersToMarkdown, useStickerPacks } from '../RichWords';
import { apiFetch, markRead } from '../../bytelight';
import type { Message as PhoneMessage } from '../../types';
import { useHouseRoster, OWNER_SIGIL, getOwnerAvatar, type HouseCompanion } from '../../lib/house';
import type { ResolvedThemeColors, ThemeColors } from '../../lib/theme';
import { cn } from '../../lib/utils';
import { splitMessageVoices } from '../../lib/voices';
import { getOwnSendIcon } from '../../lib/sendIcons';

/** The owner's side is 'owner'; the backend never sends a person's name here. */
type Turn = 'owner' | 'companions';
type Status = 'setup' | 'playing' | 'complete';
type ShotResult = 'miss' | 'hit' | 'sunk';
type Orientation = 'horizontal' | 'vertical';

interface FleetSpec {
  name: string;
  length: number;
  color: string;
}

interface ShipPlacement extends FleetSpec {
  cells: string[];
}

interface Shot {
  coordinate: string;
  result: ShotResult;
  ship?: string;
  actor: string;
  createdAt: string;
}

interface LogEntry {
  id: number;
  kind: 'system' | 'shot' | 'chat';
  actor: string;
  content: string;
  coordinate: string | null;
  result: ShotResult | null;
  createdAt: string;
}

interface BattleView {
  id: string;
  threadId: string;
  size: number;
  status: Status;
  turn: Turn;
  winner: Turn | null;
  playerFleet: ShipPlacement[];
  enemyFleet: Array<FleetSpec & { sunk: boolean }>;
  playerShots: Shot[];
  companionShots: Shot[];
  companionPending: boolean;
  companionError: string | null;
  conversation: ConversationMessage[];
  log: LogEntry[];
  createdAt: string;
  updatedAt: string;
}

interface ConversationMessage {
  id: string;
  role: 'user' | 'companion' | 'system';
  content: string;
  companionSlug: string | null;
  createdAt: string;
}

interface BattlePayload {
  game: BattleView | null;
  size?: number;
  fleet?: FleetSpec[];
}

async function readBattlePayload(
  response: Response,
  fallback: string,
): Promise<BattlePayload & { error?: string }> {
  const body = await response.text();
  const looksLikeHtml = /<!doctype\s+html/i.test(body) || /<html[\s>]/i.test(body);
  if (looksLikeHtml) {
    throw new Error('The Fleet Room is staged and needs one byte-light backend restart before the harbor can open.');
  }

  let payload: BattlePayload & { error?: string };
  try {
    payload = JSON.parse(body) as BattlePayload & { error?: string };
  } catch {
    throw new Error(fallback);
  }
  if (!response.ok) throw new Error(payload.error || fallback);
  return payload;
}

const SIZE = 8;
const COLUMNS = 'ABCDEFGH'.split('');
// Match the solid panel fill the rest of the house uses for cards (the games
// menu and Agent app both paint straight onto --custom-panelBg). The glass
// layers read markedly more transparent than everything around them.
const PANEL_SURFACE = 'var(--custom-panelBg, var(--bytelight-surface-strong))';
const PANEL_SURFACE_STRONG = 'var(--custom-panelBg, var(--bytelight-surface-strong))';
const PANEL_BORDER = 'var(--custom-panelBorder, var(--bytelight-border))';
const PANEL_TEXT = 'var(--bytelight-text)';
const PANEL_TEXT_MUTED = 'var(--bytelight-text-muted)';
const ERROR_SURFACE = 'color-mix(in srgb, #f43f5e 10%, var(--custom-panelBg, var(--bytelight-surface-strong)))';
const ERROR_BORDER = 'color-mix(in srgb, #f43f5e 20%, var(--custom-panelBorder, var(--bytelight-border)))';
const BOARD_CELL = 'color-mix(in srgb, var(--bytelight-panel-base) 86%, #11191d)';
const BOARD_CELL_MISS = 'color-mix(in srgb, var(--bytelight-panel-base) 78%, #222d30)';
const BOARD_CELL_BORDER = 'color-mix(in srgb, var(--custom-panelBorder, var(--bytelight-border)) 72%, #3b474b)';
const BOARD_CELL_MISS_BORDER = 'color-mix(in srgb, var(--custom-panelBorder, var(--bytelight-border)) 62%, #8d9b9e)';
// Only reached before the server's fleet arrives, so it must match
// DEFAULT_BATTLESHIP_FLEET in services/db/battleship.ts exactly — that file is
// the source of truth for names, lengths and hull colours, and a house running
// a renamed fleet gets the real one the moment the board loads.
const FALLBACK_FLEET: FleetSpec[] = [
  { name: 'Battleship', length: 4, color: '#e85d04' },
  { name: 'Cruiser', length: 3, color: '#1e3a5f' },
  { name: 'Submarine', length: 3, color: '#7c3aed' },
  { name: 'Destroyer', length: 2, color: '#cbd5e1' },
  { name: 'Patrol Boat', length: 2, color: '#e11d48' },
];

// Rail actors are companion slugs, 'owner' for the owner's side (labelled with
// their own name where the ledger is drawn), and 'house' for the room itself.
// Companions are rows in a database rather than a fixed cast, so anything not
// listed here is title-cased from its own slug instead of being printed raw.
const SYSTEM_ACTOR_NAMES: Record<string, string> = {
  house: 'The House',
};

function actorLabel(actor: string): string {
  return SYSTEM_ACTOR_NAMES[actor] || actor.charAt(0).toUpperCase() + actor.slice(1);
}

function coordinateAt(x: number, y: number): string {
  return `${COLUMNS[x]}${y + 1}`;
}

function coordinateParts(coordinate: string): { x: number; y: number } {
  return { x: COLUMNS.indexOf(coordinate[0]), y: Number(coordinate.slice(1)) - 1 };
}

function shuffleFleet(specs: FleetSpec[]): ShipPlacement[] {
  const occupied = new Set<string>();
  return specs.map((ship) => {
    for (let attempt = 0; attempt < 500; attempt++) {
      const horizontal = Math.random() < 0.5;
      const maxX = horizontal ? SIZE - ship.length : SIZE - 1;
      const maxY = horizontal ? SIZE - 1 : SIZE - ship.length;
      const x = Math.floor(Math.random() * (maxX + 1));
      const y = Math.floor(Math.random() * (maxY + 1));
      const cells = Array.from({ length: ship.length }, (_, index) =>
        coordinateAt(x + (horizontal ? index : 0), y + (horizontal ? 0 : index)),
      );
      if (cells.some((cell) => occupied.has(cell))) continue;
      cells.forEach((cell) => occupied.add(cell));
      return { ...ship, cells };
    }
    return { ...ship, cells: [] };
  });
}

function FleetRoomMark({ accent }: { accent: string }) {
  return (
    <svg viewBox="0 0 180 112" className="h-full w-full" aria-hidden="true">
      <defs>
        <filter id="fleet-glow">
          <feGaussianBlur stdDeviation="2.4" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <path d="M0 0h180v112H0z" fill="var(--bytelight-panel-base)" opacity=".12" />
      <g opacity=".18" stroke={PANEL_TEXT_MUTED} fill="none">
        <path d="M-8 78c20-10 33 10 51 0s33 10 51 0 33 10 51 0 33 10 51 0" />
        <path d="M-8 92c20-10 33 10 51 0s33 10 51 0 33 10 51 0 33 10 51 0" />
      </g>
      <g transform="translate(88 52)" fill="none" stroke={accent} filter="url(#fleet-glow)">
        <circle r="31" opacity=".32" />
        <circle r="20" opacity=".38" />
        <path d="M0 0V-34M0 0l23-13" strokeWidth="1.5" />
        <circle r="3.6" fill={accent} stroke="none" />
      </g>
      <path d="M24 70h91l13 10H38z" fill="var(--bytelight-panel-base)" stroke={PANEL_TEXT} strokeWidth="1.5" />
      <path d="M58 70l8-13h29l9 13" fill="var(--bytelight-panel-base)" stroke={PANEL_TEXT} strokeWidth="1.5" />
      <path d="M81 57V44h18" fill="none" stroke={PANEL_TEXT} strokeWidth="1.5" />
      <path d="M99 44V27" fill="none" stroke={PANEL_TEXT} strokeWidth="1.5" />
      <path d="M99 28l18 6-18 6z" fill={accent} stroke={PANEL_TEXT} strokeWidth=".7" opacity=".9" />
      <circle cx="100" cy="44" r="2" fill={accent} />
      <circle cx="107" cy="44" r="2" fill={PANEL_TEXT} opacity=".72" />
      <circle cx="114" cy="44" r="2" fill={PANEL_TEXT_MUTED} />
    </svg>
  );
}

function SeafloorLounge({ sunk, total }: { sunk: number; total: number }) {
  return (
    <div
      className="relative h-24 overflow-hidden rounded-2xl border"
      style={{ backgroundColor: PANEL_SURFACE, borderColor: PANEL_BORDER }}
    >
      <svg viewBox="0 0 360 96" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden="true">
        <rect width="360" height="96" fill="var(--bytelight-panel-base)" opacity=".12" />
        <path d="M0 73c35-8 60 10 93 2s64 6 96-1 61 8 94 0 52 7 77 0v22H0z" fill="var(--bytelight-panel-base)" opacity=".45" />
        <g fill="none" stroke={PANEL_TEXT_MUTED} opacity=".18">
          <path d="M25 18c20-8 32 8 50 0s33 8 51 0 32 8 50 0" />
          <path d="M191 31c18-8 31 8 48 0s31 8 49 0 31 8 48 0" />
        </g>
        {sunk > 0 && (
          <g transform="translate(242 57) rotate(-8)">
            <path d="M0 8h66l-9 12H11z" fill="var(--bytelight-panel-base)" stroke={PANEL_TEXT_MUTED} />
            <path d="M28 8V-5h20l6 13" fill="var(--bytelight-panel-base)" stroke={PANEL_TEXT_MUTED} />
          </g>
        )}
        <g transform="translate(74 63) rotate(18)" stroke={PANEL_TEXT_MUTED} fill="none" opacity=".7">
          <ellipse cx="0" cy="0" rx="6" ry="4" />
          <path d="M5 2l28 17" strokeWidth="3" strokeLinecap="round" />
        </g>
        <g fill="var(--bytelight-accent)" opacity=".35">
          <circle cx="298" cy="24" r="2" />
          <circle cx="303" cy="15" r="1.5" />
          <circle cx="308" cy="7" r="1" />
        </g>
      </svg>
      <div className="relative flex h-full items-end justify-between p-4">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[.22em]" style={{ color: PANEL_TEXT_MUTED }}>Seafloor Lounge</div>
          <div className="mt-1 text-sm" style={{ color: PANEL_TEXT }}>{sunk ? `${sunk} hull${sunk === 1 ? '' : 's'} checked in` : 'Table is still set'}</div>
          <div className="mt-1 text-[8px] uppercase tracking-[.18em]" style={{ color: PANEL_TEXT_MUTED }}>Reserved for the first hull down</div>
        </div>
        <div
          className="rounded-[var(--shape-control)] border px-3 py-1 text-xs tabular-nums"
          style={{
            backgroundColor: PANEL_SURFACE,
            borderColor: PANEL_BORDER,
            color: PANEL_TEXT,
          }}
        >
          {sunk}/{total}
        </div>
      </div>
    </div>
  );
}

interface BoardProps {
  title: string;
  subtitle: string;
  accent: string;
  shots: Shot[];
  ships?: ShipPlacement[];
  interactive?: boolean;
  disabled?: boolean;
  onCell?: (coordinate: string) => void;
  selectedShip?: string | null;
  onSetupCell?: (coordinate: string) => void;
}

function OceanBoard({
  title,
  subtitle,
  accent,
  shots,
  ships = [],
  interactive = false,
  disabled = false,
  onCell,
  selectedShip,
  onSetupCell,
}: BoardProps) {
  const shotsByCell = useMemo(() => new Map(shots.map((shot) => [shot.coordinate, shot])), [shots]);
  const shipByCell = useMemo(() => {
    const map = new Map<string, ShipPlacement>();
    ships.forEach((ship) => ship.cells.forEach((cell) => map.set(cell, ship)));
    return map;
  }, [ships]);

  return (
    <section
      className="rounded-[calc(26px*var(--shape-scale,1))] border p-3 shadow-[0_18px_50px_rgba(0,0,0,.22)] backdrop-blur-md"
      style={{
        backgroundColor: PANEL_SURFACE,
        borderColor: PANEL_BORDER,
        color: PANEL_TEXT,
      }}
    >
      <div className="mb-3 flex items-end justify-between px-1">
        <div>
          <h3 className="text-sm font-semibold tracking-wide">{title}</h3>
          <p className="mt-0.5 text-[10px] uppercase tracking-[.18em] opacity-70">{subtitle}</p>
        </div>
        <Crosshair size={18} style={{ color: accent }} className={cn(interactive && !disabled && 'animate-pulse')} />
      </div>
      <div
        className="grid gap-[3px]"
        style={{ gridTemplateColumns: '16px repeat(8, minmax(0, 1fr))' }}
      >
        <div />
        {COLUMNS.map((column) => (
          <div key={column} className="pb-1 text-center text-[9px] font-semibold opacity-60">{column}</div>
        ))}
        {Array.from({ length: SIZE }, (_, y) => (
          <React.Fragment key={y}>
            <div className="flex items-center justify-center pr-1 text-[9px] font-semibold opacity-60">{y + 1}</div>
            {Array.from({ length: SIZE }, (_, x) => {
              const coordinate = coordinateAt(x, y);
              const shot = shotsByCell.get(coordinate);
              const ship = shipByCell.get(coordinate);
              const canPress = Boolean((interactive && !disabled && !shot) || onSetupCell);
              const isMiss = shot?.result === 'miss';
              const isHit = shot?.result === 'hit';
              const isSunk = shot?.result === 'sunk';
              const hasVisibleShip = Boolean(ship);
              // Each hull paints in its own colour where we can see whose it is.
              // On the enemy board there is no ship to ask, so it falls back to
              // the theme accent exactly as before — which is also why the five
              // were one orange smear: the colour arrives per ship and nothing
              // was reading it.
              const shipTint = ship?.color || accent;
              return (
                <motion.button
                  key={coordinate}
                  whileTap={canPress ? { scale: 0.88 } : undefined}
                  type="button"
                  disabled={!canPress}
                  onClick={() => onSetupCell ? onSetupCell(coordinate) : onCell?.(coordinate)}
                  aria-label={`${coordinate}${shot ? `, ${shot.result}` : ship ? `, ${ship.name}` : ''}`}
                  className={cn(
                    'relative aspect-square min-w-0 overflow-hidden rounded-[7px] border transition',
                    canPress && 'cursor-pointer hover:brightness-125',
                    selectedShip && ship?.name === selectedShip && 'ring-2 ring-white/70',
                  )}
                  style={{
                    borderColor: isSunk
                      ? `color-mix(in srgb, ${shipTint} 76%, white)`
                      : isHit
                        ? `color-mix(in srgb, ${shipTint} 62%, ${BOARD_CELL_BORDER})`
                        : isMiss
                          ? BOARD_CELL_MISS_BORDER
                          : hasVisibleShip
                            ? `color-mix(in srgb, ${shipTint} 58%, ${BOARD_CELL_BORDER})`
                            : BOARD_CELL_BORDER,
                    backgroundColor: isMiss
                      ? BOARD_CELL_MISS
                      : hasVisibleShip
                        ? `color-mix(in srgb, ${shipTint} 26%, ${BOARD_CELL})`
                        : BOARD_CELL,
                    backgroundImage: isSunk
                      ? `repeating-linear-gradient(135deg, color-mix(in srgb, ${shipTint} 22%, transparent) 0 3px, transparent 3px 7px)`
                      : hasVisibleShip
                        ? `linear-gradient(135deg, color-mix(in srgb, ${shipTint} 20%, transparent), transparent)`
                        : 'radial-gradient(circle at 28% 20%, color-mix(in srgb, var(--bytelight-text) 7%, transparent), transparent 36%)',
                    boxShadow: isSunk
                      ? `inset 0 0 0 2px ${PANEL_SURFACE}, inset 0 0 16px color-mix(in srgb, ${shipTint} 55%, transparent)`
                      : isHit
                        ? `inset 0 0 14px color-mix(in srgb, ${shipTint} 42%, transparent)`
                        : undefined,
                  }}
                >
                  {ship && (
                    <span
                      className="absolute inset-x-[18%] top-1/2 h-[3px] -translate-y-1/2 rounded-full"
                      style={{ backgroundColor: shipTint, boxShadow: `0 0 7px ${shipTint}` }}
                    />
                  )}
                  {shot?.result === 'miss' && (
                    <span
                      className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full border"
                      style={{
                        backgroundColor: 'color-mix(in srgb, var(--bytelight-text) 15%, transparent)',
                        borderColor: 'color-mix(in srgb, var(--bytelight-text) 65%, transparent)',
                      }}
                    />
                  )}
                  {(shot?.result === 'hit' || shot?.result === 'sunk') && (
                    <span
                      className={cn(
                        'absolute left-1/2 top-1/2 h-[54%] w-[54%] -translate-x-1/2 -translate-y-1/2 rotate-45',
                        isSunk && 'rounded-full ring-2 ring-white/80',
                      )}
                    >
                      <span
                        className="absolute left-1/2 top-0 h-full w-[2px] -translate-x-1/2 rounded-full"
                        style={{ backgroundColor: PANEL_TEXT, boxShadow: `0 0 7px ${accent}` }}
                      />
                      <span
                        className="absolute left-0 top-1/2 h-[2px] w-full -translate-y-1/2 rounded-full"
                        style={{ backgroundColor: PANEL_TEXT, boxShadow: `0 0 7px ${accent}` }}
                      />
                    </span>
                  )}
                </motion.button>
              );
            })}
          </React.Fragment>
        ))}
      </div>
    </section>
  );
}

function RailAvatar({
  companion,
  owner = false,
  accent,
  className,
}: {
  companion?: HouseCompanion | null;
  owner?: boolean;
  accent?: string;
  className?: string;
}) {
  // The owner's own face reaches this rail too. It used to draw a fixed sigil no matter
  // what they had set, so the Fleet Room was the one room they weren't in.
  const mine = owner ? getOwnerAvatar() : {};
  const ring = owner
    ? mine.color || accent || 'var(--bytelight-accent)'
    : companion?.color || PANEL_TEXT_MUTED;
  const src = owner ? mine.url : companion?.avatar_url;
  return (
    <div
      className={cn(
        'flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 text-sm shadow-lg',
        className,
      )}
      style={{ backgroundColor: PANEL_SURFACE, borderColor: ring }}
      aria-hidden="true"
    >
      {src
        ? <img src={src} alt="" className="h-full w-full object-cover" />
        : <span>{owner ? OWNER_SIGIL : companion?.emoji || '✦'}</span>}
    </div>
  );
}

function RailMarkdown({ children }: { children: string }) {
  // Our stickers are pictures in the Fleet Room too, not their codes (RichWords.tsx).
  useStickerPacks();
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      components={{
        p: ({ children: content }) => <p className="my-0 leading-6">{content}</p>,
        em: ({ children: content }) => <em className="opacity-80">{content}</em>,
        strong: ({ children: content }) => <strong className="font-semibold">{content}</strong>,
        ul: ({ children: content }) => <ul className="my-1 list-disc pl-5">{content}</ul>,
        ol: ({ children: content }) => <ol className="my-1 list-decimal pl-5">{content}</ol>,
        code: ({ children: content }) => (
          <code className="rounded px-1 py-0.5 text-[13px]" style={{ backgroundColor: PANEL_SURFACE_STRONG }}>
            {content}
          </code>
        ),
        img: ({ src, alt }) => (isStickerImage(alt) ? <StickerImage src={typeof src === 'string' ? src : undefined} alt={alt} /> : <img src={typeof src === 'string' ? src : undefined} alt={alt ?? ''} className="max-w-full rounded-lg" />),
      }}
    >
      {stickersToMarkdown(children)}
    </ReactMarkdown>
  );
}

// Memoized on purpose: every message in the rail is parsed through ReactMarkdown,
// so without this the chat input re-parses the whole conversation on every keystroke
// and typing visibly lags behind the letters.
const RailConversation = React.memo(function RailConversation({
  messages,
  companions,
  pending,
  scrollRef,
  accent,
}: {
  messages: ConversationMessage[];
  companions: HouseCompanion[];
  pending: boolean;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  accent: string;
}) {
  return (
    <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 scrollbar-hide">
      {messages.length === 0 && !pending && (
        <div
          className="flex min-h-40 items-center justify-center rounded-[calc(22px*var(--shape-scale,1))] border border-dashed px-6 text-center text-[14px] leading-6"
          style={{ borderColor: PANEL_BORDER, color: PANEL_TEXT }}
        >
          The chart table is suspiciously civilized. Say something and ruin that.
        </div>
      )}
      {messages.map((message) => {
        if (message.role === 'system') {
          return (
            <div
              key={message.id}
              className="mx-auto max-w-[92%] rounded-[var(--shape-control)] border px-4 py-2 text-center text-[13px] leading-5"
              style={{
                backgroundColor: PANEL_SURFACE_STRONG,
                borderColor: PANEL_BORDER,
                color: PANEL_TEXT,
              }}
            >
              {message.content}
            </div>
          );
        }

        if (message.role === 'user') {
          return (
            // Avatar at the TOP beside a pointed top corner, and body text at
            // 14 — the messages app's shape, so both rails read the same way.
            <div key={message.id} className="flex items-start justify-end gap-2 pl-8">
              <div
                className="max-w-[82%] rounded-[calc(20px*var(--shape-scale,1))] rounded-tr-none border px-4 py-3 text-[14px]"
                style={{
                  backgroundColor: `color-mix(in srgb, ${accent} 18%, var(--bytelight-surface-strong))`,
                  borderColor: `color-mix(in srgb, ${accent} 42%, ${PANEL_BORDER})`,
                  color: PANEL_TEXT,
                }}
              >
                <RailMarkdown>{message.content}</RailMarkdown>
              </div>
              <RailAvatar owner accent={accent} className="mt-0.5" />
            </div>
          );
        }

        const phoneMessage: PhoneMessage = {
          id: message.id,
          timestamp: message.createdAt,
          direction: 'outbound',
          content: message.content,
          read: 1,
          companionSlug: message.companionSlug || undefined,
        };
        const sections = splitMessageVoices(phoneMessage, companions)
          ?? [{
            voice: message.companionSlug
              ? companions.find((companion) => companion.slug === message.companionSlug) || null
              : null,
            content: message.content,
          }];

        return (
          <div key={message.id} className="space-y-2">
            {sections.map((section, index) => {
              const voice = section.voice as HouseCompanion | null;
              return (
                <div key={`${message.id}-${index}`} className="flex items-start gap-2 pr-6">
                  <RailAvatar companion={voice} className="mt-0.5" />
                  <div
                    className="max-w-[84%] rounded-[calc(20px*var(--shape-scale,1))] rounded-tl-none border px-4 py-3 text-[14px]"
                    style={{
                      backgroundColor: PANEL_SURFACE,
                      borderColor: `color-mix(in srgb, ${voice?.color || PANEL_TEXT_MUTED} 28%, ${PANEL_BORDER})`,
                      color: PANEL_TEXT,
                    }}
                  >
                    {voice && (
                      <div className="mb-1.5 text-[12px] font-semibold uppercase tracking-[.12em]" style={{ color: themeInk(voice.slug, voice.color) }}>
                        {voice.display_name}
                      </div>
                    )}
                    <RailMarkdown>{section.content}</RailMarkdown>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}

      {pending && (
        <div className="flex items-center gap-3 py-2 pr-6">
          <div className="flex -space-x-2">
            {companions.slice(0, 3).map((companion) => (
              <RailAvatar key={companion.slug} companion={companion} />
            ))}
          </div>
          <div
            className="rounded-2xl border px-4 py-3 text-[14px]"
            style={{
              backgroundColor: PANEL_SURFACE_STRONG,
              borderColor: PANEL_BORDER,
              color: PANEL_TEXT,
            }}
          >
            <span className="mr-2 inline-flex gap-1 align-middle">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current opacity-60 [animation-delay:-.2s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current opacity-60 [animation-delay:-.1s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current opacity-60" />
            </span>
            The companions are at the chart table
          </div>
        </div>
      )}
    </div>
  );
});

export function BattleshipGame({
  colors,
  rawColors,
}: {
  colors: ThemeColors;
  rawColors: ResolvedThemeColors;
  onExit: () => void;
}) {
  const { companions, owner } = useHouseRoster();
  const [game, setGame] = useState<BattleView | null>(null);
  const [fleetSpecs, setFleetSpecs] = useState<FleetSpec[]>(FALLBACK_FLEET);
  const [setupFleet, setSetupFleet] = useState<ShipPlacement[]>(() => shuffleFleet(FALLBACK_FLEET));
  const [selectedShip, setSelectedShip] = useState<string | null>(null);
  const [orientation, setOrientation] = useState<Orientation>('horizontal');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [chat, setChat] = useState('');
  // A sticker in the room, the same tray as chat, on a line of its own; Enter
  // is a new line and the button sends (the owner's ask, Oct 26 2026).
  const [stickers, setStickers] = useState(false);
  const chatBox = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const box = chatBox.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${Math.min(Math.max(box.scrollHeight, 48), 140)}px`;
  }, [chat]);
  const [railExpanded, setRailExpanded] = useState(false);
  const SendIcon = getOwnSendIcon();
  const railScrollRef = useRef<HTMLDivElement>(null);
  const railSettledRef = useRef<string | null>(null);

  // The Fleet Room is a thread, so every companion line in it counts as unread
  // until something says otherwise — and only the chat screen ever did. Reading
  // the room here is reading it. (243 sat on the badge before this existed.)
  const railLatestId = game?.conversation?.length
    ? game.conversation[game.conversation.length - 1].id
    : null;
  useEffect(() => {
    if (!game?.threadId || !railLatestId) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    markRead(game.threadId, railLatestId);
  }, [game?.threadId, railLatestId]);

  const loadGame = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const response = await apiFetch('/api/games/battleship');
      const payload = await readBattlePayload(response, 'Could not open the Fleet Room');
      setGame((current) => {
        if (!payload.game || !current) return payload.game;
        return payload.game.updatedAt >= current.updatedAt ? payload.game : current;
      });
      if (payload.fleet?.length) {
        setFleetSpecs(payload.fleet);
        setSetupFleet((current) => current.length ? current : shuffleFleet(payload.fleet!));
      }
      setError('');
    } catch (err) {
      if (!quiet) setError(err instanceof Error ? err.message : 'Could not open the Fleet Room');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadGame();
  }, [loadGame]);

  useEffect(() => {
    if (!game || (game.status !== 'playing' && !game.companionPending)) return;
    const timer = window.setInterval(
      () => void loadGame(true),
      game.companionPending ? 1200 : 4000,
    );
    return () => window.clearInterval(timer);
  }, [game?.id, game?.status, game?.companionPending, loadGame]);

  useEffect(() => {
    const handleUpdate = (event: Event) => {
      const { gameId } = (event as CustomEvent<{ gameId: string }>).detail;
      if (!game?.id || gameId === game.id) void loadGame(true);
    };
    window.addEventListener('bytelight:battleship-update', handleUpdate);
    return () => window.removeEventListener('bytelight:battleship-update', handleUpdate);
  }, [game?.id, loadGame]);

  useEffect(() => {
    const node = railScrollRef.current;
    if (!node) return;
    // Entering the room mounts this container and fills it in the same commit, and a
    // smooth scroll issued against a container that has only just been laid out gets
    // dropped — which is why the rail used to open partway up the conversation.
    // Jump instantly the first time we settle on a game, animate for live updates after.
    const gameKey = game?.id ?? null;
    const firstSettle = railSettledRef.current !== gameKey;
    if (firstSettle) railSettledRef.current = gameKey;
    const frame = window.requestAnimationFrame(() => {
      node.scrollTo({ top: node.scrollHeight, behavior: firstSettle ? 'auto' : 'smooth' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [game?.id, game?.conversation.length, game?.companionPending, railExpanded]);

  const runAction = async (path: string, body?: Record<string, unknown>) => {
    setWorking(true);
    setError('');
    try {
      const response = await apiFetch(`/api/games/battleship${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await readBattlePayload(response, 'The harbor did not answer');
      setGame(payload.game);
      return payload.game;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The harbor did not answer');
      return null;
    } finally {
      setWorking(false);
    }
  };

  const beginSetup = async () => {
    if (game?.companionPending) return;
    const next = await runAction('/new');
    if (next) {
      setSetupFleet(shuffleFleet(fleetSpecs));
      setSelectedShip(null);
    }
  };

  const launch = async () => {
    if (!game) return;
    await runAction('/start', { gameId: game.id, ships: setupFleet });
  };

  const fire = async (coordinate: string) => {
    if (!game || game.companionPending || game.turn !== 'owner' || game.status !== 'playing') return;
    await runAction('/fire', { gameId: game.id, coordinate });
  };

  const sendChat = async () => {
    const content = chat.trim();
    if (!game || !content || game.companionPending) return;
    setChat('');
    const next = await runAction('/chat', { gameId: game.id, content });
    if (!next) setChat(content);
  };

  const moveSelectedShip = (coordinate: string) => {
    if (!selectedShip) return;
    const spec = fleetSpecs.find((ship) => ship.name === selectedShip);
    if (!spec) return;
    const { x, y } = coordinateParts(coordinate);
    const cells = Array.from({ length: spec.length }, (_, index) => {
      const nextX = x + (orientation === 'horizontal' ? index : 0);
      const nextY = y + (orientation === 'vertical' ? index : 0);
      return nextX < SIZE && nextY < SIZE ? coordinateAt(nextX, nextY) : '';
    });
    if (cells.some((cell) => !cell)) {
      setError(`${spec.name} runs off the chart from ${coordinate}`);
      return;
    }
    const occupiedByOthers = new Set(
      setupFleet.filter((ship) => ship.name !== selectedShip).flatMap((ship) => ship.cells),
    );
    if (cells.some((cell) => occupiedByOthers.has(cell))) {
      setError('That berth overlaps another ship');
      return;
    }
    setSetupFleet((fleet) => fleet.map((ship) => ship.name === selectedShip ? { ...ship, cells } : ship));
    setSelectedShip(null);
    setError('');
  };

  const sunkCount = game?.enemyFleet.filter((ship) => ship.sunk).length ?? 0;
  const damageEntries = game?.log.filter((entry) => entry.kind !== 'chat').slice(-10).reverse() ?? [];
  const actorColor = (actor: string) => (
    actor === 'owner'
      ? rawColors.accent
      : companions.find((companion) => companion.slug === actor)?.color || rawColors.textMuted
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoaderCircle className="animate-spin opacity-50" size={30} />
      </div>
    );
  }

  if (!game) {
    return (
      <div className="h-full overflow-y-auto px-4 pb-24 pt-5 scrollbar-hide">
        <div
          className="overflow-hidden rounded-[calc(30px*var(--shape-scale,1))] border shadow-2xl backdrop-blur-md"
          style={{
            backgroundColor: PANEL_SURFACE,
            borderColor: PANEL_BORDER,
            color: PANEL_TEXT,
          }}
        >
          <div className="h-48"><FleetRoomMark accent={rawColors.accent} /></div>
          <div className="px-6 pb-6">
            <div className="text-[10px] font-semibold uppercase tracking-[.28em]" style={{ color: PANEL_TEXT_MUTED }}>House waters · 8×8</div>
            <h2 className="mt-2 font-serif text-3xl">The Fleet Room</h2>
            <p className="mt-3 text-sm leading-6">
              Two sealed boards. One permanent damage ledger. Absolutely no coordinates entrusted to a companion’s thinking block.
            </p>
            <button
              type="button"
              onClick={beginSetup}
              disabled={working}
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-2xl px-5 py-4 text-sm font-semibold shadow-lg transition active:scale-[.98]"
              style={{ backgroundColor: rawColors.accent, color: rawColors.accentText }}
            >
              {working ? <LoaderCircle size={18} className="animate-spin" /> : <Anchor size={18} />}
              Open the harbor
            </button>
          </div>
        </div>
        {error && <p className="mt-4 text-center text-sm text-rose-400">{error}</p>}
      </div>
    );
  }

  if (game.status === 'setup') {
    return (
      <div className="h-full overflow-y-auto px-3 pb-24 pt-4 scrollbar-hide">
        <div
          className="mb-4 rounded-[calc(26px*var(--shape-scale,1))] border p-5 backdrop-blur-md"
          style={{
            background: `linear-gradient(145deg, color-mix(in srgb, ${rawColors.accent} 10%, var(--bytelight-surface)), var(--bytelight-surface))`,
            borderColor: PANEL_BORDER,
            color: PANEL_TEXT,
          }}
        >
          <div className="flex items-start justify-between">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[.24em]" style={{ color: PANEL_TEXT_MUTED }}>Placement harbor</div>
              <h2 className="mt-1 font-serif text-2xl">Seal your fleet</h2>
            </div>
            <Anchor style={{ color: rawColors.accent }} size={26} />
          </div>
          <p className="mt-2 text-xs leading-5">
            Shuffle for a clean layout, or select a hull and tap its new starting square. The companions never receive this board.
          </p>
        </div>

        <OceanBoard
          title="Your Waters"
          subtitle={selectedShip ? `Place ${selectedShip}` : 'Fleet visible only to you'}
          accent={rawColors.accent}
          shots={[]}
          ships={setupFleet}
          selectedShip={selectedShip}
          onSetupCell={moveSelectedShip}
        />

        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => {
              setSetupFleet(shuffleFleet(fleetSpecs));
              setSelectedShip(null);
              setError('');
            }}
            className="flex items-center justify-center gap-2 rounded-2xl border px-3 py-3 text-xs font-semibold"
            style={{ backgroundColor: PANEL_SURFACE, borderColor: PANEL_BORDER, color: PANEL_TEXT }}
          >
            <Shuffle size={15} /> Shuffle fleet
          </button>
          <button
            type="button"
            onClick={() => setOrientation((value) => value === 'horizontal' ? 'vertical' : 'horizontal')}
            className="flex items-center justify-center gap-2 rounded-2xl border px-3 py-3 text-xs font-semibold"
            style={{ backgroundColor: PANEL_SURFACE, borderColor: PANEL_BORDER, color: PANEL_TEXT }}
          >
            <RotateCw size={15} /> {orientation}
          </button>
        </div>

        <div className="mt-3 grid gap-2">
          {setupFleet.map((ship) => (
            <button
              key={ship.name}
              type="button"
              onClick={() => setSelectedShip((current) => current === ship.name ? null : ship.name)}
              className="flex items-center justify-between rounded-2xl border px-4 py-3 text-left transition"
              style={{
                backgroundColor: selectedShip === ship.name
                  ? `color-mix(in srgb, ${rawColors.accent} 18%, var(--bytelight-surface))`
                  : PANEL_SURFACE,
                borderColor: selectedShip === ship.name
                  ? rawColors.accent
                  : PANEL_BORDER,
                color: PANEL_TEXT,
              }}
            >
              <span className="flex items-center gap-3">
                <span className="h-2.5 rounded-full" style={{ width: 14 + ship.length * 8, backgroundColor: rawColors.accent, boxShadow: `0 0 9px ${rawColors.accent}` }} />
                <span className="text-xs font-medium">{ship.name}</span>
              </span>
              <span className="text-[10px] uppercase tracking-wider opacity-70">{ship.length} cells</span>
            </button>
          ))}
        </div>

        {error && (
          <p
            className="mt-3 rounded-xl px-3 py-2 text-center text-xs"
            style={{ backgroundColor: ERROR_SURFACE, color: PANEL_TEXT }}
          >
            {error}
          </p>
        )}
        <button
          type="button"
          onClick={launch}
          disabled={working}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl px-5 py-4 text-sm font-semibold shadow-lg transition active:scale-[.98]"
          style={{ backgroundColor: rawColors.accent, color: rawColors.accentText }}
        >
          {working ? <LoaderCircle size={18} className="animate-spin" /> : <Radio size={18} />}
          Seal boards & launch
        </button>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-3 pb-28 pt-3 scrollbar-hide">
      <header
        className="relative mb-3 overflow-hidden rounded-[calc(26px*var(--shape-scale,1))] border backdrop-blur-md"
        style={{
          backgroundColor: PANEL_SURFACE,
          borderColor: PANEL_BORDER,
          color: PANEL_TEXT,
        }}
      >
        <div className="absolute inset-y-0 right-0 w-44 opacity-60"><FleetRoomMark accent={rawColors.accent} /></div>
        <div className="relative p-5">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[.23em]" style={{ color: PANEL_TEXT_MUTED }}>
            <Waves size={13} /> The Fleet Room
          </div>
          <h2 className="mt-2 font-serif text-2xl">
            {game.status === 'complete'
              ? game.winner === 'owner' ? 'You own the water.' : 'The companions take the match.'
              : game.turn === 'owner' ? 'Your shot.' : 'The companions are plotting.'}
          </h2>
          <div
            className="mt-3 inline-flex items-center gap-2 rounded-[var(--shape-control)] border px-3 py-1.5 text-[10px] uppercase tracking-wider"
            style={{ backgroundColor: PANEL_SURFACE, borderColor: PANEL_BORDER }}
          >
            <span
              className={cn('h-1.5 w-1.5 rounded-full', game.status === 'playing' && 'animate-pulse')}
              style={{ backgroundColor: game.status === 'complete' ? rawColors.textMuted : rawColors.accent }}
            />
            {game.status === 'complete' ? 'Match complete' : game.turn === 'owner' ? 'Your command' : 'Companion turn'}
          </div>
        </div>
      </header>

      <div className="space-y-3">
        <OceanBoard
          title="Hunt the companions"
          subtitle={game.status === 'complete' ? 'Final firing solution' : game.turn === 'owner' ? 'Tap an uncalled coordinate' : 'Board sealed while they answer'}
          accent={rawColors.accent}
          shots={game.playerShots}
          interactive={game.status === 'playing' && game.turn === 'owner'}
          disabled={working || game.companionPending}
          onCell={fire}
        />

        <div className="grid grid-cols-2 gap-2">
          {game.enemyFleet.map((ship) => (
            <div
              key={ship.name}
              className={cn('rounded-2xl border px-3 py-2.5 transition', ship.sunk && 'border-dashed')}
              style={{
                backgroundColor: ship.sunk
                  ? PANEL_SURFACE
                  : `color-mix(in srgb, ${rawColors.accent} 8%, var(--bytelight-surface))`,
                borderColor: ship.sunk
                  ? PANEL_TEXT_MUTED
                  : `color-mix(in srgb, ${rawColors.accent} 38%, ${PANEL_BORDER})`,
                color: ship.sunk ? PANEL_TEXT_MUTED : PANEL_TEXT,
              }}
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn('h-1.5 rounded-full', ship.sunk && 'ring-1 ring-white/60')}
                  style={{
                    width: 11 + ship.length * 6,
                    backgroundColor: ship.sunk ? PANEL_SURFACE : rawColors.accent,
                  }}
                />
                <span className={cn('truncate text-[10px] font-semibold', ship.sunk && 'line-through')}>{ship.name}</span>
              </div>
              <div className="mt-1 text-[9px] uppercase tracking-wider opacity-70">{ship.sunk ? 'sunk' : `${ship.length} cells`}</div>
            </div>
          ))}
        </div>

        <SeafloorLounge sunk={sunkCount} total={game.enemyFleet.length} />

        <OceanBoard
          title="Your Waters"
          subtitle="The sealed fleet"
          accent={rawColors.accent}
          shots={game.companionShots}
          ships={game.playerFleet}
        />

        <section
          className="rounded-[calc(24px*var(--shape-scale,1))] border p-4 backdrop-blur-md"
          style={{
            backgroundColor: PANEL_SURFACE_STRONG,
            borderColor: PANEL_BORDER,
            color: PANEL_TEXT,
          }}
        >
          <div className="mb-3 flex items-center gap-2">
            <Crosshair size={15} style={{ color: rawColors.accent }} />
            <h3 className="text-xs font-semibold uppercase tracking-[.16em]">Damage ledger</h3>
          </div>
          <div className="space-y-2">
            {damageEntries.map((entry) => (
              <div key={entry.id} className="flex items-start gap-3 text-xs">
                <span
                  className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: actorColor(entry.actor) }}
                />
                <div className="min-w-0 flex-1">
                  <span className="font-semibold">
                    {entry.actor === 'owner' ? owner?.name || 'You' : actorLabel(entry.actor)}
                  </span>
                  <span className="ml-2">{entry.content}</span>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section
          className={cn(
            'flex flex-col border shadow-[0_24px_70px_rgba(0,0,0,.48)]',
            railExpanded
              ? 'fixed inset-x-3 bottom-[max(12px,env(safe-area-inset-bottom))] top-[calc(env(safe-area-inset-top)+68px)] z-[100] rounded-[calc(28px*var(--shape-scale,1))] p-4'
              : 'h-[420px] rounded-[calc(24px*var(--shape-scale,1))] p-4',
          )}
          style={{
            backgroundColor: PANEL_SURFACE_STRONG,
            borderColor: PANEL_BORDER,
            color: PANEL_TEXT,
          }}
        >
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <MessageCircle size={18} style={{ color: rawColors.accent }} />
              <div>
                <h3 className="text-[13px] font-semibold uppercase tracking-[.14em]">Fleet Room comms</h3>
                <p className="mt-0.5 text-[11px]" style={{ color: PANEL_TEXT_MUTED }}>Actual room · permanent record</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setRailExpanded((value) => !value)}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border transition active:scale-95"
              style={{ backgroundColor: PANEL_SURFACE, borderColor: PANEL_BORDER, color: PANEL_TEXT }}
              aria-label={railExpanded ? 'Collapse Fleet Room conversation' : 'Expand Fleet Room conversation'}
            >
              {railExpanded ? <Minimize2 size={19} /> : <Maximize2 size={19} />}
            </button>
          </div>

          <RailConversation
            messages={game.conversation}
            companions={companions}
            pending={game.companionPending}
            scrollRef={railScrollRef}
            accent={rawColors.accent}
          />

          {game.companionError && (
            <div
              className="mt-3 rounded-2xl border px-4 py-3 text-[13px] leading-5"
              style={{ backgroundColor: ERROR_SURFACE, borderColor: ERROR_BORDER, color: PANEL_TEXT }}
            >
              {game.companionError}
            </div>
          )}

          <div className="mt-3 flex gap-2">
            <textarea
              ref={chatBox}
              rows={1}
              value={chat}
              onChange={(event) => setChat(event.target.value)}
              disabled={working || game.companionPending}
              maxLength={500}
              placeholder={game.companionPending ? 'The companions are answering…' : 'Speak into the room…'}
              className="min-w-0 flex-1 resize-none rounded-2xl border px-4 py-3 text-[16px] leading-6 outline-none placeholder:opacity-60 disabled:opacity-55"
              style={{ backgroundColor: PANEL_SURFACE, borderColor: PANEL_BORDER, color: PANEL_TEXT }}
            />
            <button
              type="button"
              onClick={() => setStickers(true)}
              disabled={working || game.companionPending}
              aria-label="Add a sticker"
              title="Add a sticker"
              className="flex h-12 w-12 shrink-0 items-center justify-center self-end rounded-full border disabled:opacity-30"
              style={{ borderColor: PANEL_BORDER, color: PANEL_TEXT }}
            >
              <Sticker size={18} />
            </button>
            {stickers && (
              <StickerPicker
                colors={colors}
                onSelect={(code) => {
                  setChat((c) => (c.trim() ? `${c.replace(/\s+$/, '')}\n${code}\n` : `${code}\n`).slice(0, 500));
                  setStickers(false);
                  window.setTimeout(() => chatBox.current?.focus(), 50);
                }}
                onClose={() => setStickers(false)}
              />
            )}
            <button
              type="button"
              onClick={sendChat}
              disabled={working || game.companionPending || !chat.trim()}
              className="flex h-12 w-12 shrink-0 items-center justify-center self-end rounded-full disabled:opacity-30"
              style={{ backgroundColor: rawColors.accent, color: rawColors.accentText }}
              aria-label="Speak into the Fleet Room"
            >
              {working ? <LoaderCircle size={18} className="animate-spin" /> : <SendIcon size={18} />}
            </button>
          </div>
        </section>

        {error && (
          <p
            className="rounded-xl px-3 py-2 text-center text-xs"
            style={{ backgroundColor: ERROR_SURFACE, color: PANEL_TEXT }}
          >
            {error}
          </p>
        )}
        {game.status === 'complete' && (
          <button
            type="button"
            onClick={beginSetup}
            disabled={working || game.companionPending}
            className="flex w-full items-center justify-center gap-2 rounded-2xl border px-5 py-4 text-sm font-semibold transition active:scale-[.98]"
            style={{ backgroundColor: PANEL_SURFACE, borderColor: PANEL_BORDER, color: PANEL_TEXT }}
          >
            {working ? <LoaderCircle size={18} className="animate-spin" /> : <RefreshCw size={18} />}
            Open another battle
          </button>
        )}
      </div>
    </div>
  );
}
