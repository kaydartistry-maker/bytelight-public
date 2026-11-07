// Discord utility functions

import type { Message as DiscordMessage } from 'discord.js';
import { splitMessage } from '../split-message.js';
import { composeIncomingContent, stickerTokensFor } from './sticker-content.js';

/** Split a response into Discord-safe chunks (max 1900 chars). */
export function splitResponse(text: string, maxLength = 1900): string[] {
  return splitMessage(text, maxLength, 0.5);
}

// discord.js cleanContent reduces custom emotes <a:name:id> to :name:,
// dropping the id needed to render the emote image. Put the raw tokens back:
// each token from the raw content replaces the first matching :name: in the
// cleaned string, in order, so duplicates line up.
function restoreEmoteTokens(raw: string, cleaned: string): string {
  const tokens = raw.match(/<a?:\w+:\d{17,20}>/g);
  if (!tokens) return cleaned;
  let result = cleaned;
  for (const token of tokens) {
    const name = token.slice(token.indexOf(':') + 1, token.lastIndexOf(':'));
    result = result.replace(`:${name}:`, token);
  }
  return result;
}

/**
 * Outbound counterpart to restoreEmoteTokens: turn the `:name:` shorthand a
 * companion writes into the real Discord token — `<:name:id>` (static) or
 * `<a:name:id>` (animated) — for any `name` that exactly matches a known guild
 * custom emoji. Match is CASE-SENSITIVE (Discord emoji names are).
 *
 * Left untouched:
 *  - `:name:` whose name isn't a known guild emoji (Unicode shortcodes like
 *    `:smile:`, and byte-light sticker refs like `:companion_a_wink:`, both pass
 *    through — sticker refs require a `_` and are resolved by an independent
 *    exact-lookup pipeline (visual-blocks.ts), so only a genuine same-name
 *    collision could shadow one, same ambiguity Discord itself would have).
 *  - text already inside a complete token — the leading `<` (optionally `<a`)
 *    means a `:name:` sitting inside `<:name:id>` is never double-wrapped,
 *    because a bare-`:name:` match can't start with `<`.
 *
 * @param emojiIndex flat list of guild emojis; zero-length → identity.
 */
export function resolveEmoteShorthand(
  text: string,
  emojiIndex: Array<{ name: string; id: string; animated: boolean }>,
): string {
  if (!text || emojiIndex.length === 0) return text;
  // name → emoji (first wins on duplicate names across guilds).
  const byName = new Map<string, { id: string; animated: boolean }>();
  for (const e of emojiIndex) {
    if (!byName.has(e.name)) byName.set(e.name, { id: e.id, animated: e.animated });
  }
  // Match a bare :name:. The `(?<!<)` lookbehind skips a token's opening colon
  // (`<:name:...`), and the `(?![0-9]+>)` lookahead skips a token's middle colon
  // (`...:id>`) — together they leave complete <:name:id> / <a:name:id> tokens
  // untouched, so nothing is ever double-wrapped, while still allowing adjacent
  // shorthand like `:a::b:` (the shared middle colon is not `<`-prefixed).
  return text.replace(
    /(?<!<):([A-Za-z0-9_]+):(?![0-9]+>)/g,
    (whole, name: string) => {
      const emoji = byName.get(name); // case-sensitive exact match
      if (!emoji) return whole; // unknown name (unicode shortcode / sticker ref) — leave it
      return emoji.animated ? `<a:${name}:${emoji.id}>` : `<:${name}:${emoji.id}>`;
    },
  );
}

/**
 * Render a Discord message's text content with any stickers appended as
 * `<dsticker:<name>:<id>.<png|gif>>` tokens (sticker-content.ts, Aerie). The
 * phone unfolds those into the sticker picture; the companion reads the name
 * inside. Sticker-only messages have empty text content — without the tokens
 * they'd store and display as empty strings, leaving the companion blind to
 * what was sent. This one value is the stored row, the judge's input and the
 * prompt, so the two can never drift apart.
 *
 * BYTE-LIGHT ADAPTATION: Aerie drops Lottie stickers entirely (no image
 * form). byte-light already named them, so a Lottie sticker keeps its
 * readable `[sticker: <Name>]` token rather than going silent.
 *
 * cleanContent resolves mentions to readable names but also reduces custom
 * emotes <a:name:id> to :name:, losing the id the frontend needs to render
 * the emote image off the Discord CDN, so restore the raw tokens afterwards.
 */
/** Discord's StickerFormatType.Lottie. */
const LOTTIE_STICKER_FORMAT = 3;

export function formatDiscordMessageContent(message: DiscordMessage): string {
  const text = restoreEmoteTokens(message.content, message.cleanContent || message.content || '');
  if (message.stickers.size === 0) return text;
  const lottie = [...message.stickers.values()]
    .filter(s => s.format === LOTTIE_STICKER_FORMAT)
    .map(s => `[sticker: ${s.name}]`);
  return composeIncomingContent(text, [...stickerTokensFor([message]), ...lottie]);
}

/**
 * Format Discord message history for agent context
 */
export function formatChannelHistory(messages: DiscordMessage[]): string {
  return messages.map(msg => {
    const time = msg.createdAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const author = msg.author.bot ? `[BOT] ${msg.author.username}` : msg.author.username;
    const content = formatDiscordMessageContent(msg)
      || (msg.attachments.size > 0 ? '[attachment]' : '[embed]');
    return `[${time}] ${author}: ${content}`;
  }).join('\n');
}
