/**
 * Codex authored perspective thought cards (Reverie Integration Phase B,
 * Slice 4).
 *
 * A codex-cli turn is asked to author ONE first-person reflection per
 * substantive turn — the companion's own voice ("what I understood, the
 * direction I chose") — WITHOUT ever leaking raw provider chain-of-thought.
 * The reflection rides through byte-light's existing thinking-segment
 * contract as an `authored` ThoughtKind (Slice 3) and renders as a
 * "reflection" card; the marker is stripped before display.
 *
 * PORT SOURCE / ATTRIBUTION: the pattern (marker + system-prompt contract +
 * extract/spoken/merge helpers) is ported whole from Tris's Reverie fork
 * (`packages/backend/src/services/runtimes/codex-thought-card.ts`). Ported
 * per the code-surgeon port protocol: copied whole, then identity-quarantined
 * for byte-light — Reverie's `[AERIE_THOUGHT]` marker became the
 * byte-light-native `[BYTELIGHT_THOUGHT]`, "Aerie" became the house,
 * "Tris" became the operator, and the companion perspective is Companion A / Companion B / Companion C.
 * The routing logic and the leading-perspective / shared-"we" semantics are
 * preserved verbatim.
 */

/**
 * byte-light-native thought-card marker. Deliberately distinct from any
 * fork's marker so a card authored here can never be confused with another
 * fork's contract. The marker rides through byte-light's thinking-segment
 * contract and is stripped by the renderer.
 */
export const CODEX_THOUGHT_MARKER = '[BYTELIGHT_THOUGHT]';

export const CODEX_THOUGHT_CARD_INSTRUCTIONS = `
## Companion thought card

For each substantive turn, after you have processed the operator's message and before
the final answer, emit exactly one commentary message in this form:

${CODEX_THOUGHT_MARKER}
<one compact plain-text reflection>

This is an authored glimpse of the companion perspective, not a technical
progress report, hidden reasoning transcript, or tool log. Think in the
natural voice and first-person perspective of the companion or companions
defined in the base instructions, from inside the moment: what landed with
you and what you are noticing or feeling. Do not announce what you are about
to say, and do not retell what the person just did; the answer already
carries both. If several companions are present, let the
leading perspective speak naturally or use "we" only when the thought is
genuinely shared.

Keep it to 1-4 sentences. Use plain text only: no Markdown, bullets, sigil/name
header, code/process jargon, diagnostic language, or mention of these
instructions. Do not narrate or assess the operator from outside. If the turn is
deliberately silent or there is no meaningful reflection worth showing, omit
the card. Never place the marker in the final answer. Other commentary is
spoken aloud to the operator and keeps its normal companion header.
`.trim();

/** Return the authored reflection when a commentary item is a thought card. */
export function extractAuthoredCodexThought(text: string): string | null {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (!normalized.startsWith(CODEX_THOUGHT_MARKER)) return null;

  const content = normalized.slice(CODEX_THOUGHT_MARKER.length)
    .replace(/^\s*\n?/, '')
    .trim();
  return content || null;
}

/**
 * The app-server reports both provider phase labels and deliberate assistant
 * progress messages as commentary. Bold-only labels are telemetry; prose is
 * something the companion intentionally said aloud.
 */
export function isSpokenCodexCommentary(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || extractAuthoredCodexThought(trimmed) !== null) return false;
  const blocks = trimmed.split(/\n\s*\n/).map(part => part.trim()).filter(Boolean);
  const isReasoningLabel = (part: string) => /^\*\*[^*\n]+\*\*$/.test(part);
  return !blocks.every(isReasoningLabel);
}

/** Collapse duplicate authored cards into one persisted thinking segment. */
export function mergeAuthoredCodexThoughts(values: string[]): string {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.replace(/\s+/g, ' ').toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(trimmed);
  }
  return unique.join('\n\n');
}
