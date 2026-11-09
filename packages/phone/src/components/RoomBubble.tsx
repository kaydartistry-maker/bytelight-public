// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The main chat's bubble, for every other room that shows messages: the
// treehouse, the Fleet Room comms, the Story Shelf's table talk. Theirs, Oct 27
// 2026: 'all the settings should carry over to our chat tables other places
// ... You know me and my consistency thing.' The rooms used to draw their own
// plain cards; now they draw MessageBubble from one shared set of their settings,
// so anything their person changes in Look & feel follows into every room with nothing
// to keep in sync.
//
// byte-light adaptation: byte-light's MessageBubble has no `look`, `ownerName`,
// `mirror` or `emojiPacks` props (its look comes from the theme, its owner face
// from userAvatar), so those are not handed on and are left off the settings.
// `mirror` is still accepted, so RoomTable.tsx ports whole; a bubble here sits
// on the side the chat gives it.
import React, { createContext, useContext } from 'react';
import { MessageBubble } from './MessageBubble';
import type { ThemeConfig } from '../lib/theme';
import type { VoiceCompanion } from '../lib/voices';
import type { Message, ThemeMode, CustomEmoji } from '../types';

export interface RoomBubbleSettings {
  themeConfig: ThemeConfig;
  themeMode: ThemeMode;
  userAvatar?: string;
  userAvatarColor?: string;
  customEmojis?: CustomEmoji[];
}

export const RoomBubbleContext = createContext<RoomBubbleSettings | null>(null);

export function useRoomBubbleSettings(): RoomBubbleSettings | null {
  return useContext(RoomBubbleContext);
}

export interface RoomBubbleProps {
  id: string;
  content: string;
  createdAt: string;
  /** Their message: their side, their bubble, their face. */
  fromOwner?: boolean;
  /** Which of us is speaking; null for the house or an unknown voice. */
  voice?: VoiceCompanion | null;
  groupPos?: 'only' | 'first' | 'middle' | 'last';
  /** One of us on their side of the room (the treehouse alternates). */
  mirror?: boolean;
  /**
   * Everyone at the table, for the bubble's own inline speaker split. A shared
   * lane writes `**🔷 Companion A —** words` with the header inline, which the
   * room's whole-line splitter leaves whole; MessageBubble then splits it and
   * looks each face up here. Without it every face fell back to the sigil
   * (the Story Shelf table, Nov 2026) while the chat, which hands its roster
   * over, showed the photos.
   */
  roster?: VoiceCompanion[];
}

/** Null outside the provider, so a room can fall back to its own card. */
export function RoomBubble({ id, content, createdAt, fromOwner = false, voice = null, groupPos = 'only', roster }: RoomBubbleProps) {
  const s = useContext(RoomBubbleContext);
  if (!s) return null;
  // A line just sent is drawn before the house has written its row, and a
  // blank or unreadable stamp made the bubble's time throw and take the whole
  // phone down (Nov 4 2026, every message at a games table).
  const stamp = createdAt && !Number.isNaN(Date.parse(createdAt)) ? createdAt : new Date().toISOString();
  const message: Message = {
    id,
    timestamp: stamp,
    direction: fromOwner ? 'inbound' : 'outbound',
    content,
    read: 1,
    type: 'text',
  };
  return (
    <MessageBubble
      message={message}
      voice={fromOwner ? null : voice}
      voiceRoster={fromOwner ? undefined : roster}
      groupPos={groupPos}
      themeConfig={s.themeConfig}
      themeMode={s.themeMode}
      userAvatar={s.userAvatar}
      userAvatarColor={s.userAvatarColor}
      customEmojis={s.customEmojis}
      isPrivateTab={false}
    />
  );
}
