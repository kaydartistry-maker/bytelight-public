// Bridges the Bytelight message model to the phone's Message shape.
// Phase 2: synthesize the phone's inline content sentinels so the existing
// MessageBubble renders unchanged. A structured-segment refactor comes later.

import type { Message as BytelightMessage, MessageSegment } from './protocol';
import type { Message as PhoneMessage, SurfacedCard, SurfacedMemory } from '../types';

// Extract the emoji list from Bytelight's structured metadata.reactions.
export function reactionsToEmojiList(metadata: Record<string, unknown> | null): string[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const reactions = (metadata as { reactions?: unknown }).reactions;
  if (!Array.isArray(reactions)) return [];
  return reactions
    .map((r) => (r && typeof r === 'object' ? (r as { emoji?: string }).emoji : undefined))
    .filter((e): e is string => typeof e === 'string');
}

// Synthesize the phone's inline content sentinels from Bytelight's content_type.
function synthesizeContent(km: BytelightMessage): string {
  switch (km.content_type) {
    case 'image':
      return km.content.startsWith('[IMG]:') ? km.content : `[IMG]: ${km.content}`;
    case 'audio':
      return km.content.startsWith('[VOICE]:') ? km.content : `[VOICE]: ${km.content}`;
    case 'file': {
      const name = (km.metadata as { filename?: string } | null)?.filename || 'file';
      return km.content.startsWith('[FILE:') ? km.content : `[FILE:${name}]: ${km.content}`;
    }
    default:
      return km.content;
  }
}

// Render metadata.attachments (files uploaded via /api/files) as the phone's
// inline content sentinels so MessageBubble shows them.
function attachmentSentinels(metadata: Record<string, unknown> | null): string {
  if (!metadata || typeof metadata !== 'object') return '';
  const atts = (metadata as { attachments?: unknown }).attachments;
  if (!Array.isArray(atts)) return '';
  return atts
    .map((a) => {
      if (!a || typeof a !== 'object') return '';
      const att = a as { url?: string; filename?: string; contentType?: string };
      if (!att.url) return '';
      if (att.contentType === 'image') return ` [IMG]:${att.url}`;
      return ` [FILE:${att.filename || 'file'}]:${att.url}`;
    })
    .join('');
}

// Pull the interleaved text/tool/thinking segments the backend persists in
// metadata.segments so finalized companion replies can show tool calls.
function extractSegments(metadata: Record<string, unknown> | null): MessageSegment[] | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const segs = (metadata as { segments?: unknown }).segments;
  if (!Array.isArray(segs) || segs.length === 0) return undefined;
  const valid = segs.filter(
    (s): s is MessageSegment =>
      !!s && typeof s === 'object' && typeof (s as { type?: unknown }).type === 'string',
  );
  return valid.length > 0 ? valid : undefined;
}

// The shiver — ambient recall that rode this reply. The heartbeat runtime
// emits `memory_surface`, the router folds it into `metadata.surfacedMemory`,
// and the bubble draws a glint you can ignore or tap. Déjà vu is the fainter
// variant: something felt, nothing clear enough to show.
function extractSurfacedMemory(
  metadata: Record<string, unknown> | null,
): SurfacedMemory | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const raw = (metadata as { surfacedMemory?: unknown }).surfacedMemory;
  if (!raw || typeof raw !== 'object') return undefined;
  const { cards, dejavu } = raw as { cards?: unknown; dejavu?: unknown };
  const validCards = Array.isArray(cards)
    ? cards.filter(
        (c): c is SurfacedCard =>
          !!c && typeof c === 'object' && typeof (c as { excerpt?: unknown }).excerpt === 'string',
      )
    : [];
  // Nothing surfaced and nothing was felt — no chip, no empty ceremony.
  if (validCards.length === 0 && dejavu !== true) return undefined;
  return { cards: validCards, dejavu: dejavu === true };
}

export function toPhoneMessage(km: BytelightMessage): PhoneMessage {
  // The phone's Message model uses 'inbound' for the phone owner's own
  // messages and 'outbound' for the other party (see MessageBubble/App.tsx).
  const isOwnMessage = km.role === 'user';
  const direction: PhoneMessage['direction'] = isOwnMessage ? 'inbound' : 'outbound';
  const type: PhoneMessage['type'] = km.content_type === 'audio' ? 'voice' : 'text';
  // Discord-bridged messages carry the sender's Discord identity in
  // metadata; prefer the display name (what the server calls them) over
  // the raw username so guests render under their actual name.
  const discordMeta =
    km.platform === 'discord'
      ? (km.metadata as {
          discordUsername?: string;
          discordDisplayName?: string;
          discordAvatarUrl?: string;
        } | null)
      : null;
  const discordUsername = discordMeta?.discordDisplayName || discordMeta?.discordUsername;
  const attachmentTail = attachmentSentinels(km.metadata).trim();
  return {
    id: km.id,
    timestamp: km.created_at,
    direction,
    content: `${synthesizeContent(km)} ${attachmentTail}`.trim(),
    attachmentTail: attachmentTail || undefined,
    read: km.read_at ? 1 : 0,
    isSystem: km.role === 'system',
    type,
    reactions: reactionsToEmojiList(km.metadata),
    status: isOwnMessage ? 'read' : km.read_at ? 'read' : 'delivered',
    sender: km.role === 'system' ? (discordUsername || 'System') : undefined,
    senderAvatar: discordUsername ? discordMeta?.discordAvatarUrl : undefined,
    via: discordUsername ? 'Discord' : undefined,
    companionSlug:
      typeof (km.metadata as { companionSlug?: unknown } | null)?.companionSlug === 'string'
        ? ((km.metadata as { companionSlug: string }).companionSlug)
        : undefined,
    companionId: km.role === 'companion' && km.companion_id ? km.companion_id : undefined,
    segments: extractSegments(km.metadata),
    surfacedMemory: extractSurfacedMemory(km.metadata),
    replyToId: km.reply_to_id ?? undefined,
    replyToPreview: km.reply_to_preview ?? undefined,
    editedAt: km.edited_at ?? undefined,
    transcript:
      type === 'voice'
        ? ((km.metadata as { transcript?: string } | null)?.transcript ?? undefined)
        : undefined,
    isVoiceInput: extractIsVoiceInput(km.metadata),
    prosody: extractProsody(km.metadata),
  };
}

function extractIsVoiceInput(metadata: Record<string, unknown> | null): boolean | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const source = (metadata as { source?: unknown }).source;
  if (source === 'voice_mode') return true;
  const prosody = (metadata as { prosody?: unknown }).prosody;
  if (prosody && typeof prosody === 'object' && Object.keys(prosody).length > 0) return true;
  return undefined;
}

function extractProsody(metadata: Record<string, unknown> | null): Record<string, number> | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const prosody = (metadata as { prosody?: unknown }).prosody;
  if (!prosody || typeof prosody !== 'object' || Array.isArray(prosody)) return undefined;
  const entries = Object.entries(prosody as Record<string, unknown>)
    .filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1]));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

// A synthetic phone message for the in-progress streamed reply.
export function streamingToPhoneMessage(messageId: string, tokens: string): PhoneMessage {
  return {
    id: `streaming-${messageId}`,
    timestamp: new Date().toISOString(),
    direction: 'outbound',
    content: tokens,
    read: 1,
    type: 'text',
    status: 'delivered',
  };
}
