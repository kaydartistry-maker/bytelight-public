// Who is speaking in a companion message on a room rail (the Fleet Room comms).
//
// The rail asked splitMessageVoices first, and that reader only takes a header
// that owns its whole line. The house writes its header inline —
// `**🔷 Companion A —** words…` — so the reader found nobody, the rail fell back to
// the message's companion stamp, and a shared-lane reply (no
// single companion) drew a faceless ✦. The chat bubble already reads inline
// headers through splitBySpeaker; the rail now does the same when the
// whole-line reader comes back empty.

import { splitBySpeaker } from './speakers';
import { splitMessageVoices, type VoiceCompanion } from './voices';
import type { Message } from '../types';

export interface RailSection<C extends VoiceCompanion> {
  voice: C | null;
  content: string;
}

export function railVoiceSections<C extends VoiceCompanion>(
  message: Message,
  companions: C[],
): RailSection<C>[] {
  const stamped = message.companionSlug
    ? companions.find((c) => c.slug === message.companionSlug) || null
    : null;

  const whole = splitMessageVoices(message, companions);
  if (whole) return whole.map((s) => ({ voice: s.voice as C | null, content: s.content }));

  const content = message.content || '';
  const rows = splitBySpeaker(content);
  if (rows.some((r) => r.speaker !== 'fallback')) {
    return rows.map((r) => ({
      voice:
        r.speaker === 'fallback'
          ? stamped
          : companions.find((c) => c.slug === r.speaker) || stamped,
      content: r.text,
    }));
  }

  return [{ voice: stamped, content }];
}
