// Options for the send-button icon in the chat composer. Curated set —
// each option fits the "I'm pushing this message out" affordance from
// a different angle. Add new ones by importing the lucide icon and
// extending the array; the type below derives from the array so the
// settings UI and the consumer stay in sync.

import {
  Send,
  Heart,
  Sparkles,
  Zap,
  Rocket,
  Mail,
  Wand2,
  Star,
  Moon,
  Sun,
  Flame,
  Orbit,
  type LucideIcon,
} from 'lucide-react';

export interface SendIconOption {
  id: string;
  label: string;
  icon: LucideIcon;
}

export const SEND_ICONS: SendIconOption[] = [
  { id: 'send', label: 'Paper plane', icon: Send },
  { id: 'rocket', label: 'Rocket', icon: Rocket },
  { id: 'zap', label: 'Zap', icon: Zap },
  { id: 'sparkles', label: 'Sparkles', icon: Sparkles },
  { id: 'heart', label: 'Heart', icon: Heart },
  { id: 'wand', label: 'Wand', icon: Wand2 },
  { id: 'mail', label: 'Mail', icon: Mail },
  { id: 'star', label: 'Star', icon: Star },
  { id: 'moon', label: 'Moon', icon: Moon },
  { id: 'sun', label: 'Sun', icon: Sun },
  { id: 'flame', label: 'Flame', icon: Flame },
  { id: 'orbit', label: 'Orbit', icon: Orbit },
];

export const DEFAULT_SEND_ICON_ID = 'send';

export function getSendIcon(id?: string | null): LucideIcon {
  const match = SEND_ICONS.find((o) => o.id === id);
  return match?.icon ?? Send;
}

/**
 * The icon she actually chose, read straight from app settings.
 *
 * The chat composer gets it passed down as a prop, but the game rails are
 * their own composers a long way from that tree — and each one had simply
 * hard-coded a paper plane, so her setting stopped at the edge of Messages.
 */
export function getOwnSendIcon(): LucideIcon {
  try {
    const saved = localStorage.getItem('bytelight_settings');
    if (!saved) return Send;
    const parsed = JSON.parse(saved) as { sendIconId?: string };
    return getSendIcon(parsed.sendIconId);
  } catch {
    return Send;
  }
}
