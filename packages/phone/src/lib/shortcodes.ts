// Finding the shortcode being typed, at the caret.
//
// The command palette can anchor to the start of the box because a slash
// command is the whole message. A shortcode is a word inside a sentence, so
// the only thing that can say which one is being typed is where the cursor is.

export interface ShortcodeToken {
  /** Index in the content where the colons begin. */
  start: number;
  /** ':' for emoji-and-stickers, '::' for stickers only. */
  colons: ':' | '::';
  /** What has been typed after the colons. */
  query: string;
}

export function matchShortcodeToken(content: string, caret: number): ShortcodeToken | null {
  if (caret < 0 || caret > content.length) return null;
  const upto = content.slice(0, caret);

  // At least one character after the colons, so a bare ":" — which is the
  // start of most typed smileys — opens nothing.
  const m = upto.match(/(::?)([a-zA-Z0-9_-]+)$/);
  if (!m) return null;

  // A code that has already been closed is finished; editing inside one should
  // not reopen the tray over the top of it.
  if (content.slice(caret, caret + 1) === ':') return null;

  return {
    start: caret - m[0].length,
    colons: m[1] as ':' | '::',
    query: m[2],
  };
}

/** Replace the token at the caret with a chosen code, leaving the caret after
 *  it and a space, so the next word does not run into the code just inserted. */
export function applyShortcode(
  content: string,
  token: ShortcodeToken,
  caret: number,
  code: string,
): { content: string; caret: number } {
  const before = content.slice(0, token.start);
  const after = content.slice(caret);
  return {
    content: `${before}${code} ${after}`,
    caret: before.length + code.length + 1,
  };
}
