/**
 * Split outbound chat text into platform-sized chunks. Prefers a paragraph
 * break, then a line break, then a space, as long as the break leaves the
 * chunk at least `minRatio` of `maxLength`; otherwise hard-cuts. Leading
 * whitespace of each following chunk is dropped.
 */
export function splitMessage(text: string, maxLength: number, minRatio: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;
  const floor = maxLength * minRatio;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf('\n\n', maxLength);
    if (splitAt < floor) splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt < floor) splitAt = remaining.lastIndexOf(' ', maxLength);
    if (splitAt < floor) splitAt = maxLength;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}
