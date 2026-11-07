// Copyright 2026 Byte-light contributors. Licensed under the Apache License 2.0.
/**
 * Coming up for air in the Codex lane.
 *
 * The warm CLI lane can send a line, keep working, and send another — an ack
 * reaches the user while the work is still running instead of arriving
 * stapled to the answer it was meant to precede. The Codex lane could not: it
 * kept only the last non-commentary message of a turn and dropped the rest.
 *
 * That rule was aimed at something real — commentary messages arriving around
 * tool calls produced a jumble of bubbles that looked like thinking cards and
 * were not. But commentary is filtered by PHASE, separately and already, so
 * keeping only the last of what remained was reaching past its own reason and
 * taking deliberate speech with it.
 *
 * The closing `final_answer` is deliberately NOT an interim bubble. Keeping it
 * in the router tail lets normal turn completion close and return it once.
 */

export interface CodexTurnItem {
  id?: string;
  type?: string;
  phase?: string;
  text?: unknown;
}

/** Speech the room has not been shown yet, worth surfacing now. */
export function isInterimCodexSpeech(
  item: CodexTurnItem | null | undefined,
  alreadyEmitted: ReadonlySet<string>,
  alreadyEmittedTexts?: ReadonlySet<string>,
): item is CodexTurnItem & { id: string; text: string } {
  if (!item || item.type !== 'agentMessage') return false;
  if (item.phase === 'commentary') return false;
  if (item.phase === 'final_answer') return false;
  if (typeof item.id !== 'string' || !item.id) return false;
  if (alreadyEmitted.has(item.id)) return false;
  if (typeof item.text !== 'string' || !item.text.trim()) return false;
  if (alreadyEmittedTexts?.has(item.text.trim())) return false;
  return true;
}

/** Claim the speech still owed when the completed turn is reconciled. */
export function claimUnsentCodexSpeech(
  items: CodexTurnItem[],
  emittedIds: Set<string>,
  emittedTexts: Set<string>,
): Array<CodexTurnItem & { text: string }> {
  const claimed: Array<CodexTurnItem & { text: string }> = [];
  for (const item of items) {
    if (item?.type !== 'agentMessage' || item.phase === 'commentary') continue;
    if (typeof item.text !== 'string' || !item.text.trim()) continue;
    const text = item.text.trim();
    if ((item.id && emittedIds.has(item.id)) || emittedTexts.has(text)) continue;
    if (item.id) emittedIds.add(item.id);
    emittedTexts.add(text);
    claimed.push({ ...item, text });
  }
  return claimed;
}
