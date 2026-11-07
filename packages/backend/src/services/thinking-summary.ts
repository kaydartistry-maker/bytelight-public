/**
 * Short headline for a thinking block: the first sentence, capped at 120
 * chars. A sentence ends at `.`, `!` or `?` followed by whitespace, or at a
 * newline, so decimals ("v3.5") don't cut it short. An abbreviation followed
 * by a space ("e.g. warm") still ends it, though now at "e.g." rather than "e.".
 * Shared by the legacy agent path, the Claude SDK runtime and the heartbeat
 * outbox watcher so every lane surfaces the same summary string.
 */
export function extractThinkingSummary(text: string): string {
  const trimmed = text.replace(/^\s+/, '');
  // Find first sentence boundary
  const match = trimmed.match(/^(.+?(?:\.\s|!\s|\?\s|\n))/);
  if (match) {
    const sentence = match[1].trim();
    if (sentence.length <= 120) return sentence;
    return sentence.slice(0, 117) + '...';
  }
  // No sentence boundary found — take first 120 chars
  if (trimmed.length <= 120) return trimmed;
  return trimmed.slice(0, 117) + '...';
}
