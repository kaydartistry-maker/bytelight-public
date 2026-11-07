// Display-layer humanizer for tool-chip names. MCP tools arrive over the WS
// protocol as `mcp__<server>__<tool>` (e.g.
// `mcp__claude_ai_Neuralis_Os__mind_orient`); native tools arrive as plain
// names (`Bash`, `Read`, `ToolSearch`). This turns the raw wire name into a
// short, readable chip label like `Neuralis Os · orienting` while the raw
// name is preserved as a tooltip at the render sites. Pure, display-only —
// it never touches stored segments, the WS protocol, or the backend.
//
// Run tests with:
//   npx tsx --test packages/phone/src/lib/tool-names.test.ts

// Verb-style labels for the daily-driver MCP tools. Anything not listed here
// falls back to underscores→spaces so a new tool still reads sanely.
const TOOL_LABELS: Record<string, string> = {
  mind_orient: 'orienting',
  mind_ground: 'grounding',
  mind_write: 'writing memory',
  mind_search: 'searching memory',
  mind_feel_toward: 'feeling',
  cortex_recall: 'recalling',
  cortex_remember: 'remembering',
  cortex_open_threads: 'open threads',
  discord_send: 'sending to Discord',
  discord_read_messages: 'reading Discord',
  telegram_send: 'sending to Telegram',
  generate_image: 'generating image',
  spotify_play: 'playing music',
  create_event: 'calendar event',
  search_files: 'searching Drive',
  'notion-search': 'searching Notion',
};

// Turn `Neuralis_Os` / `claude_ai_DIscord` into `Neuralis Os` / `Discord`.
// Splits on underscores, lowercases then title-cases each word so obvious
// mis-casing (`DIscord`) tidies up while multi-word servers stay legible.
function tidyServer(server: string): string {
  return server
    .split('_')
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function toolLabel(tool: string): string {
  const mapped = TOOL_LABELS[tool];
  if (mapped) return mapped;
  return tool.split('_').filter((w) => w.length > 0).join(' ');
}

/**
 * Human-readable label for a tool-chip name.
 *
 * - Native (non-MCP) names pass through unchanged: `Bash` → `Bash`.
 * - MCP names (`mcp__<server>__<tool>`) render as `<Server> · <label>`,
 *   e.g. `mcp__claude_ai_Neuralis_Os__mind_orient` → `Neuralis Os · orienting`.
 *   A leading `claude_ai_` / `claude-ai-` server prefix is stripped.
 * - Malformed names (missing/empty segments) fall back to the raw string.
 *   Never throws, never returns empty.
 */
export function humanizeToolName(raw: string): string {
  if (!raw || typeof raw !== 'string') return raw;
  if (!raw.startsWith('mcp__')) return raw;

  // mcp__<server>__<tool> — split on the '__' delimiter after the prefix.
  const rest = raw.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  if (sep <= 0) return raw; // no server/tool boundary → malformed

  let server = rest.slice(0, sep);
  const tool = rest.slice(sep + 2);
  if (!server || !tool) return raw; // empty segment → malformed

  // Strip a leading claude_ai_ / claude-ai- vendor prefix if present.
  server = server.replace(/^claude[_-]ai[_-]/i, '');
  if (!server) return raw; // prefix was the whole server → malformed

  const serverLabel = tidyServer(server);
  if (!serverLabel) return raw;

  return `${serverLabel} · ${toolLabel(tool)}`;
}

// ─── Tool families ─────────────────────────────────────────────────────────
// Every chip belongs to one of four families, each with its own glyph + accent
// at the render site. Classification is display-only: it reads the raw wire
// name and never touches segments or protocol. We classify MCP names primarily
// by their server segment (the reliable signal), then fall back to tool-name
// keywords, then to a 'system' catch-all so nothing ever renders unfamilied.
export type ToolFamily = 'memory' | 'comms' | 'creation' | 'system';

// Server-segment substrings → family. Matched case-insensitively against the
// tidied/raw server chunk of an mcp__server__tool name.
const SERVER_FAMILY: Array<[RegExp, ToolFamily]> = [
  // memory — Neuralis and any mind/cortex/brain brained server
  [/neuralis|mind|cortex|brain/i, 'memory'],
  // comms — the messenger surfaces
  [/discord|telegram|gmail|mail/i, 'comms'],
  // creation — making + media: image, art, canvas, notion, drive, music
  [/image|openart|canva|notion|drive|spotify|jukebox|video/i, 'creation'],
];

// Tool-name substrings → family, used when the server segment is silent or the
// name is native (no server). Kept narrow and intentional.
const TOOL_FAMILY: Array<[RegExp, ToolFamily]> = [
  [/^mind_|^cortex_/i, 'memory'],
  [/^discord_|^telegram_|notif/i, 'comms'],
  [/generate_image|generate_video|^spotify_|^notion-|search_files|^openart_|create_event|list_events/i, 'creation'],
];

/**
 * Classify a raw tool name into one of four display families.
 *
 * - MCP names classify primarily by their server segment (Neuralis → memory,
 *   Discord → comms, OpenArt/Notion/Drive → creation), then by a tool-name
 *   keyword fallback.
 * - Native tools (Bash, Read, Edit, ToolSearch …) and anything unmatched land
 *   in 'system'. Never throws; always returns a family.
 */
export function toolFamily(raw: string): ToolFamily {
  if (!raw || typeof raw !== 'string') return 'system';

  if (raw.startsWith('mcp__')) {
    const rest = raw.slice('mcp__'.length);
    const sep = rest.indexOf('__');
    if (sep > 0) {
      const server = rest.slice(0, sep);
      const tool = rest.slice(sep + 2);
      for (const [re, fam] of SERVER_FAMILY) {
        if (re.test(server)) return fam;
      }
      for (const [re, fam] of TOOL_FAMILY) {
        if (re.test(tool)) return fam;
      }
    }
    return 'system';
  }

  // Native / non-MCP: try the tool-name keywords, else system.
  for (const [re, fam] of TOOL_FAMILY) {
    if (re.test(raw)) return fam;
  }
  return 'system';
}

// Accessible label per family. The chip glyph is a hand-drawn silver-wire SVG
// rendered inline in the component; this map is the screen-reader label for
// that otherwise-decorative icon (aria-label on the glyph span), so the family
// a chip belongs to is still announced.
export const FAMILY_LABELS: Record<ToolFamily, string> = {
  memory: 'memory',
  comms: 'communication',
  creation: 'creation',
  system: 'system',
};
