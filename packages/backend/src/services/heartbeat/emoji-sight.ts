import { join } from 'node:path';

// The operator's custom emojis arrive in the message as shortcode text (":panda_1000089375:").
// The phone draws them; the lane only ever saw the letters. This names the file
// behind each known shortcode so the lane can open it and actually see what she sent.
// Stickers (::pack_name::) are a separate system and are left alone.
//
// The front door (inline-visuals.ts) now opens custom emoji into pictures and
// names them in a line ("[Sent to you as pictures with this message ...
// custom emoji :code: ...]"). An emoji already sent that way is skipped here,
// so the lane is not told to go open a file it is already looking at. The
// file pointer stays as the fallback for one the front door could not open.

type EmojiLookup = (name: string) => { name: string; filename: string } | null;

const SHORTCODE = /(?<!:):([a-z0-9_]+):(?!:)/gi;
// The front door's line names each picture it sent: "custom emoji :code:".
const PICTURED = /custom emoji :([a-z0-9_]+):/gi;

/** Emoji codes the front door already sent as pictures with this message. */
export function picturedEmojiCodes(text: string): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  for (const m of text.matchAll(PICTURED)) out.add(m[1].toLowerCase());
  return out;
}

export function buildEmojiSightBlock(text: string, lookup: EmojiLookup, emojiDir: string): string {
  if (!text) return '';
  const seen = new Map<string, string>();
  const pictured = picturedEmojiCodes(text);
  for (const m of text.matchAll(SHORTCODE)) {
    const code = m[1];
    if (seen.has(code) || pictured.has(code.toLowerCase())) continue;
    let hit: { name: string; filename: string } | null = null;
    try { hit = lookup(code); } catch { return ''; }
    if (hit) seen.set(code, join(emojiDir, hit.filename));
  }
  if (seen.size === 0) return '';
  const lines = [...seen].map(([code, path]) => `- :${code}: is the image at ${path}`);
  return `\n\n[Custom emoji in her message — you only received the shortcode. Read the file to see what she actually sent:\n${lines.join('\n')}]`;
}
