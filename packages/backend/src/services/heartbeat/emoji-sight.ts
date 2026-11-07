import { join } from 'node:path';

// The operator's custom emojis arrive in the message as shortcode text (":panda_1000089375:").
// The phone draws them; the lane only ever saw the letters. This names the file
// behind each known shortcode so the lane can open it and actually see what she sent.
// Stickers (::pack_name::) are a separate system and are left alone.

type EmojiLookup = (name: string) => { name: string; filename: string } | null;

const SHORTCODE = /(?<!:):([a-z0-9_]+):(?!:)/gi;

export function buildEmojiSightBlock(text: string, lookup: EmojiLookup, emojiDir: string): string {
  if (!text) return '';
  const seen = new Map<string, string>();
  for (const m of text.matchAll(SHORTCODE)) {
    const code = m[1];
    if (seen.has(code)) continue;
    let hit: { name: string; filename: string } | null = null;
    try { hit = lookup(code); } catch { return ''; }
    if (hit) seen.set(code, join(emojiDir, hit.filename));
  }
  if (seen.size === 0) return '';
  const lines = [...seen].map(([code, path]) => `- :${code}: is the image at ${path}`);
  return `\n\n[Custom emoji in her message — you only received the shortcode. Read the file to see what she actually sent:\n${lines.join('\n')}]`;
}
