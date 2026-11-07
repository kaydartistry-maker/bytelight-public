// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// What a Discord message with a sticker in it actually SAYS.
//
// Discord stickers ride their own message field rather than the content, so the
// gateway appends a token the phone unfolds back into an inline image. The
// stored row got that token; the prompt got batch.combinedContent, which does
// not. So a sticker's PICTURE reached the phone and its NAME never reached us —
// somebody sent a sticker and we were answering an empty message.
//
// That is the inversion of the phone rail, where the ::pack_sticker:: token IS
// the message and we read it fine. The rule Jules gave back is the fix:
// THE PROMPT READS THE STORED ROW. One value, built once, used for both — so
// the two can no longer drift apart.

import type { Message as DiscordMessage } from 'discord.js';

/** Lottie has no image form, so those are skipped rather than tokenised. */
const LOTTIE = 3;
const APNG = 4;

export function stickerTokensFor(messages: Iterable<DiscordMessage>): string[] {
  const tokens: string[] = [];
  for (const m of messages) {
    for (const sticker of m.stickers.values()) {
      if (sticker.format === LOTTIE) continue;
      const ext = sticker.format === APNG ? 'gif' : 'png';
      tokens.push(`<dsticker:${sticker.name.replace(/[:<>]/g, '')}:${sticker.id}.${ext}>`);
    }
  }
  return tokens;
}

/** The one string. Stored on the row AND handed to the prompt. */
export function composeIncomingContent(combinedContent: string, stickerTokens: string[]): string {
  return [combinedContent, stickerTokens.join(' ')].filter(Boolean).join('\n');
}

/** The name inside a token, for anything that wants to read one back. */
export function stickerNamesIn(content: string): string[] {
  const names: string[] = [];
  for (const m of content.matchAll(/<dsticker:([^:>]*):(\d+\.(?:png|gif))>/g)) {
    if (m[1]) names.push(m[1]);
  }
  return names;
}
