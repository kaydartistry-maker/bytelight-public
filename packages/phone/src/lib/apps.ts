// App registry — the single source of truth for the phone's launchable apps.
// Consumed by the home-screen dock and the app drawer.

import type { LucideIcon } from 'lucide-react';
import { Library, MessageSquare, StickyNote, Settings, Activity, Sticker, LayoutDashboard, Plug, FileText, Bot, Users, Brain, Paintbrush, Box, FolderOpen, BookOpen, Inbox, Mail, ScanSearch, CloudSun, Telescope, Music, Gamepad2, TreePine } from 'lucide-react';
import { SPOTIFY_APP_ID } from './spotify';
import type { OsScreen } from '../App';

export interface AppDef {
  id: string;
  name: string;
  icon: LucideIcon;
  category: 'Companion' | 'Tools' | 'System' | 'Fun';
  // 'screen' apps swap the OS into a full-screen view; 'modal' apps open an overlay.
  kind: 'screen' | 'modal';
  screen?: OsScreen;
  // Shown on the home-screen dock (the curated quick-access row).
  dock?: boolean;
}

export const APPS: AppDef[] = [
  { id: 'messages', name: 'Messages', icon: MessageSquare, category: 'Companion', kind: 'screen', screen: 'messages', dock: true },
  { id: 'status', name: 'Status', icon: Activity, category: 'System', kind: 'screen', screen: 'status' },
  { id: 'integrations', name: 'Integrations', icon: Plug, category: 'System', kind: 'screen', screen: 'integrations' },
  { id: 'agent', name: 'Agent', icon: Bot, category: 'System', kind: 'screen', screen: 'agent' },
  { id: 'packs', name: 'Packs', icon: Sticker, category: 'System', kind: 'screen', screen: 'packs' },
  { id: 'commandcenter', name: 'Command Center', icon: LayoutDashboard, category: 'Companion', kind: 'screen', screen: 'commandcenter' },
  { id: 'canvas', name: 'Canvas', icon: FileText, category: 'Companion', kind: 'screen', screen: 'canvas' },
  { id: 'companions', name: 'Companions', icon: Users, category: 'Companion', kind: 'screen', screen: 'companions' },
  { id: 'memory', name: 'Memory', icon: Brain, category: 'Companion', kind: 'screen', screen: 'memory' },
  { id: 'journal', name: 'Journal', icon: BookOpen, category: 'Companion', kind: 'screen', screen: 'journal' },
  { id: 'letters', name: 'Letters', icon: Mail, category: 'Companion', kind: 'screen', screen: 'letters' },
  { id: 'library', name: 'Reading Nook', icon: Library, category: 'Companion', kind: 'screen', screen: 'library' },
  { id: 'fieldnotes', name: 'Field Notes', icon: Telescope, category: 'Companion', kind: 'screen', screen: 'fieldnotes' },
  // Spotify (ported from Aerie): the operator's listening, played through her Spotify MCP server.
  { id: SPOTIFY_APP_ID, name: 'Spotify', icon: Music, category: 'Tools', kind: 'screen', screen: 'spotify' },
  // The companions' read-only room (ported from Aerie).
  { id: 'treehouse', name: 'Treehouse', icon: TreePine, category: 'Companion', kind: 'screen', screen: 'treehouse' },
  { id: 'studio', name: 'Studio', icon: Paintbrush, category: 'Tools', kind: 'screen', screen: 'studio' },
  { id: 'files', name: 'Files', icon: FolderOpen, category: 'Tools', kind: 'screen', screen: 'files' },
  { id: 'inbox', name: 'Inbox', icon: Inbox, category: 'Tools', kind: 'screen', screen: 'inbox' },
  { id: 'weather', name: 'Weather', icon: CloudSun, category: 'Tools', kind: 'screen', screen: 'weather' },
  { id: 'artifacts', name: 'Artifacts', icon: Box, category: 'Tools', kind: 'screen', screen: 'artifacts' },
  { id: 'xray', name: 'X-Ray', icon: ScanSearch, category: 'System', kind: 'screen', screen: 'xray' },
  { id: 'settings', name: 'Settings', icon: Settings, category: 'System', kind: 'modal' },
  { id: 'notes', name: 'Notes', icon: StickyNote, category: 'Tools', kind: 'screen', screen: 'notes', dock: true },
  { id: 'games', name: 'Games', icon: Gamepad2, category: 'Fun', kind: 'screen', screen: 'games' },
];

export const DOCK_APPS = APPS.filter((a) => a.dock);

export const CATEGORY_ORDER: AppDef['category'][] = ['Companion', 'Tools', 'Fun', 'System'];

export function appsByCategory(): Array<{ category: AppDef['category']; apps: AppDef[] }> {
  return CATEGORY_ORDER.map((category) => ({
    category,
    apps: APPS.filter((a) => a.category === category),
  })).filter((g) => g.apps.length > 0);
}

// --- Custom drawer layout, persisted in localStorage. ----------------------
//
// The drawer is a sparse grid: each slot holds either an app id or null
// (an empty cell). Storage matches that shape — a positional array
// where indexes are grid slots and nulls are gaps. Lets the user place
// apps wherever they want (e.g. centering an odd row) instead of being
// forced into a left-to-right fill.

const LAYOUT_STORAGE_KEY = 'bytelight_app_layout_v1';
const LEGACY_ORDER_STORAGE_KEY = 'bytelight_app_order_v1';

export type AppSlot = string | null;

const APP_ID_ALIASES: Record<string, string> = {
  // GIF Lab became a first-class Studio section. Keep old saved dock/drawer
  // layouts useful instead of leaving a dead tile behind.
  gif: 'studio',
  // (X-Ray is NOT aliased: the operator keeps it as its own tile in the Apps drawer.
  // Aliasing it to Agent wiped its saved drawer position on every load.)
  // Cortex, Memory Blocks, and Self-Knowledge folded into the Memory hub.
  cortex: 'memory',
  memoryblocks: 'memory',
  selfknowledge: 'memory',
};

export function migrateAppIds(ids: string[]): string[] {
  const canonicalPresent = new Set(ids.filter((id) => !APP_ID_ALIASES[id]));
  const seen = new Set<string>();
  const migrated: string[] = [];
  for (const id of ids) {
    const target = APP_ID_ALIASES[id] ?? id;
    if (APP_ID_ALIASES[id] && canonicalPresent.has(target)) continue;
    if (seen.has(target)) continue;
    seen.add(target);
    migrated.push(target);
  }
  return migrated;
}

function migrateLayoutSlots(slots: AppSlot[]): AppSlot[] {
  const canonicalPresent = new Set(slots.filter((id): id is string => Boolean(id) && !APP_ID_ALIASES[id as string]));
  const seen = new Set<string>();
  return slots.map((slot) => {
    if (!slot) return null;
    const target = APP_ID_ALIASES[slot] ?? slot;
    if (APP_ID_ALIASES[slot] && canonicalPresent.has(target)) return null;
    if (seen.has(target)) return null;
    seen.add(target);
    return target;
  });
}

export function loadAppLayout(): AppSlot[] | null {
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((v) => v === null || typeof v === 'string')) {
        const migrated = migrateLayoutSlots(parsed as AppSlot[]);
        if (JSON.stringify(migrated) !== JSON.stringify(parsed)) saveAppLayout(migrated);
        return migrated;
      }
    }
    // One-time migration from the older v1 ordered-list format. Empty
    // layout (no gaps), apps in saved order.
    const legacy = localStorage.getItem(LEGACY_ORDER_STORAGE_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy);
      if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) {
        return migrateLayoutSlots(parsed as AppSlot[]);
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function saveAppLayout(slots: AppSlot[]): void {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(slots));
  } catch {
    /* localStorage unavailable — ignore */
  }
}

// Resolve a sparse layout against the canonical APPS list. Slots that
// reference unknown ids become empty; apps not yet placed (e.g. newly
// added in a later build) are appended at the end so the user doesn't
// silently lose access. Returns an array of (AppDef | null) the drawer
// can render directly.
export function applyAppLayout(
  apps: AppDef[],
  layout: AppSlot[] | null,
): Array<AppDef | null> {
  if (!layout) return [...apps].sort((a, b) => a.name.localeCompare(b.name));
  const byId = new Map(apps.map((a) => [a.id, a]));
  const placed = new Set<string>();
  const resolved: Array<AppDef | null> = [];
  for (const slot of layout) {
    if (slot && byId.has(slot) && !placed.has(slot)) {
      resolved.push(byId.get(slot) || null);
      placed.add(slot);
    } else {
      resolved.push(null);
    }
  }
  // Insert unplaced apps alphabetically rather than appending at the end,
  // so new apps land where the user would expect them.
  const unplaced = apps.filter((a) => !placed.has(a.id)).sort((a, b) => a.name.localeCompare(b.name));
  for (const app of unplaced) {
    // Find the right alphabetical position among already-placed apps
    let insertIdx = resolved.length;
    for (let i = 0; i < resolved.length; i++) {
      const slot = resolved[i];
      if (slot && app.name.localeCompare(slot.name) < 0) {
        insertIdx = i;
        break;
      }
    }
    resolved.splice(insertIdx, 0, app);
  }
  return resolved;
}
