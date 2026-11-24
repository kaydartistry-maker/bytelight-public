// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Our stickers outside the chat. The treehouse, the Card Room's table and the
// Story Shelf's table drew a sticker as its bare code, ::birch_hearteyes::,
// because only the chat knew how to turn one into its picture (the owner's ask, Oct 26
// 2026, reading the weekly look-back in the treehouse: 'Your stickers don't
// render. It's the same for the tables in the games and story shelf').
//
// Change from Aerie: this house's canonical sticker code is single-colon
// :pack_sticker: (Aerie's is ::pack_sticker::), so both are read, and the
// markdown path goes through the chat's own prepareChatText, which also keeps
// status tags ([companion-a mood: …]) out of the room.
import React, { useEffect, useState } from 'react';
import { loadStickers, resolveStickerRef, subscribeStickers } from '../bytelight/stickers';
import { prepareChatText, stickerSrc } from '../lib/chat-text';
import { parseInlineMarkdown } from '../lib/utils';

const STICKER = /::?([a-zA-Z0-9_-]+_[a-zA-Z0-9_-]+)::?/g;

/** Re-render once the sticker packs are known, so a room opened before the chat still draws them. */
export function useStickerPacks(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const off = subscribeStickers(() => setVersion((v) => v + 1));
    void loadStickers().then(() => setVersion((v) => v + 1)).catch(() => {});
    return off;
  }, []);
  return version;
}

/** For a markdown renderer: each known sticker code becomes an image the renderer can draw. */
export function stickersToMarkdown(text: string): string {
  return prepareChatText({ text, resolveSticker: resolveStickerRef }).markdown;
}

/** True for an image a markdown renderer got from stickersToMarkdown. */
export function isStickerImage(alt: unknown): boolean {
  return typeof alt === 'string' && alt.startsWith('sticker:');
}

/** A sticker the size it is in chat, on a line of its own. */
export function StickerImage({ src, alt }: { src?: string; alt?: string }) {
  return (
    <img
      src={stickerSrc(src)}
      alt={alt?.replace(/^sticker:/, '') || 'sticker'}
      className="my-1 block h-24 w-auto max-w-[60%] object-contain"
      loading="lazy"
    />
  );
}

/**
 * Bold and italic like parseInlineMarkdown, with each known sticker drawn as
 * its picture. Unknown codes stay as text, the way chat leaves them.
 */
export function InlineWithStickers({ text }: { text: string }) {
  useStickerPacks();
  if (!text.includes(':')) return <>{parseInlineMarkdown(text)}</>;
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(STICKER)) {
    const url = resolveStickerRef(m[1]);
    if (!url) continue;
    const at = m.index ?? 0;
    if (at > last) out.push(<React.Fragment key={key++}>{parseInlineMarkdown(text.slice(last, at))}</React.Fragment>);
    out.push(<StickerImage key={key++} src={url} alt={`sticker:${m[1]}`} />);
    last = at + m[0].length;
  }
  if (last < text.length) out.push(<React.Fragment key={key++}>{parseInlineMarkdown(text.slice(last))}</React.Fragment>);
  return <>{out}</>;
}
