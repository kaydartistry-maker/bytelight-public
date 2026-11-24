import type { CustomEmoji } from '../types';
import { stripStatusTags } from '@bytelight/shared';

interface PrepareChatTextInput {
  text: string;
  resolveSticker: (ref: string) => string | null;
  customEmojis?: CustomEmoji[];
}

interface PreparedChatText {
  markdown: string;
  stickerSharesText: boolean;
  emoteOnly: boolean;
}

const STICKER_REF = /::[a-zA-Z0-9_-]+_[a-zA-Z0-9_-]+::/g;
const STICKER_AT_START = /^::([a-zA-Z0-9_-]+_[a-zA-Z0-9_-]+)::/;
// Main's canonical sticker ref is single-colon `:packname_stickername:` — what
// the companions are told to write and what the Svelte client renders. Only a
// ref that resolves to a real sticker is taken; anything else falls through to
// the custom-emoji lookup and then to plain text.
const SINGLE_STICKER_AT_START = /^:([a-zA-Z0-9_-]+_[a-zA-Z0-9_-]+):/;

function replaceShortcodes(text: string, resolveSticker: (ref: string) => string | null, customEmojis: CustomEmoji[]): string {
  const emojisByToken = new Map(customEmojis.map((emoji) => [`:${emoji.shortcode}:`, emoji]));
  let prepared = '';
  let index = 0;
  while (index < text.length) {
    if (text[index] !== ':') {
      prepared += text[index];
      index += 1;
      continue;
    }

    if (text[index + 1] === ':') {
      const sticker = text.slice(index).match(STICKER_AT_START);
      if (sticker) {
        const url = resolveSticker(sticker[1]);
        prepared += url ? `![sticker:${sticker[1]}](${url})` : sticker[0];
        index += sticker[0].length;
        continue;
      }
    }

    const single = text.slice(index).match(SINGLE_STICKER_AT_START);
    const singleUrl = single ? resolveSticker(single[1]) : null;
    if (single && singleUrl) {
      prepared += `![sticker:${single[1]}](${singleUrl})`;
      index += single[0].length;
      continue;
    }

    const closingColon = text.indexOf(':', index + 1);
    const token = closingColon === -1 ? '' : text.slice(index, closingColon + 1);
    const emoji = emojisByToken.get(token);
    if (emoji) {
      prepared += `![emoji:${emoji.shortcode}](emoji:${emoji.shortcode})`;
      index = closingColon + 1;
      continue;
    }

    prepared += ':';
    index += 1;
  }
  return prepared;
}

// A sticker's size follows where it sits, line by line: one with words still
// to come after it on the same line is mid-sentence and stays emoji-small; one
// at the end of a line, or alone on its own line, is drawn at sticker size.
// (The old rule shrank every sticker in a bubble the moment the bubble held
// any text at all, and a companion's reply always does.) The mark rides on the
// image url as a fragment, which the browser never sends, so the picture loads
// the same and preparing the text twice changes nothing.
const INLINE_STICKER_MARK = '#bl-inline';
const STICKER_IMAGE = /!\[sticker:[^\]]*\]\(([^)]*)\)/g;

function markInlineStickers(markdown: string): string {
  return markdown.split('\n').map((line) => {
    if (!line.includes('![sticker:')) return line;
    return line.replace(STICKER_IMAGE, (token: string, url: string, offset: number) => {
      const rest = line.slice(offset + token.length).replace(STICKER_IMAGE, '').trim();
      const midSentence = rest.length > 0;
      const marked = url.endsWith(INLINE_STICKER_MARK);
      if (midSentence === marked) return token;
      const nextUrl = midSentence ? url + INLINE_STICKER_MARK : url.slice(0, -INLINE_STICKER_MARK.length);
      return token.slice(0, token.length - url.length - 1) + nextUrl + ')';
    });
  }).join('\n');
}

/** True when this sticker sits mid-sentence and should stay emoji-small. */
export function isInlineSticker(src: string | undefined): boolean {
  return typeof src === 'string' && src.endsWith(INLINE_STICKER_MARK);
}

/** The sticker's real url, with the size mark taken off. */
export function stickerSrc(src: string | undefined): string | undefined {
  return isInlineSticker(src) ? src!.slice(0, -INLINE_STICKER_MARK.length) : src;
}

/** The size classes for a sticker image, by where it sits in its line. */
export function stickerSizeClass(src: string | undefined): string {
  return isInlineSticker(src)
    ? '!h-[1.75em] !max-h-[1.75em] !my-0 mx-0.5 align-text-bottom'
    : 'max-h-32 align-bottom';
}

export function prepareChatText({ text, resolveSticker, customEmojis = [] }: PrepareChatTextInput): PreparedChatText {
  // Status tags ([companion-a mood: playful]) never show, not even mid-stream;
  // the backend takes them out of what it keeps (@bytelight/shared).
  let markdown = stripStatusTags(text).replace(/(^|\n)-# +(.*)/g, '$1###### $2');
  markdown = replaceShortcodes(markdown, resolveSticker, customEmojis);
  markdown = markInlineStickers(markdown);
  const withoutStickers = markdown.replace(/!\[sticker:[^\]]*\]\([^)]*\)/g, '').replace(STICKER_REF, '');
  const withoutEmotes = markdown.replace(/!\[d?emoji:[^\]]*\]\([^)]*\)/g, '');
  return {
    markdown,
    stickerSharesText: withoutStickers !== markdown && withoutStickers.trim().length > 0,
    emoteOnly: withoutEmotes !== markdown && withoutEmotes.trim() === '',
  };
}
