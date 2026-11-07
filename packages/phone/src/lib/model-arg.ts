// Completing a model id in the composer.
//
// The command palette anchors to the start of the box and closes the moment a
// space is typed, because at that point you are in args territory. This picks
// up exactly where that stops: `/model <id>`, with the id being completed.
//
// It exists because a model id is not a thing anyone holds in their head.
// Someone typed `opus 4.5` — the name printed on the picker is `Claude Opus
// 4.5` and the id is `claude-opus-4-5`. The lane launched with the string as
// typed, the CLI rejected it, and the session died and respawned every two
// seconds until the value was put back. The phone knows about forty-five ids
// across four providers, and until now `/model` asked you to type one from
// memory with nothing between your thumb and the CLI.

export interface ModelArgToken {
  /** Index in the content where the id being typed begins. */
  start: number;
  /** What has been typed of the id so far. Empty right after `/model `. */
  query: string;
}

// Everything a provider might legally put in an id — Ollama uses `:` and `/`,
// Anthropic and OpenAI use `-` and `.`. Deliberately excludes whitespace, so
// the token ends where the argument does.
const MODEL_ARG = /^\/model[ \t]+([a-zA-Z0-9._:/-]*)$/;

/**
 * The model id being typed immediately before the caret, or null.
 *
 * Matched against the text UP TO the caret, the same way a shortcode is, so
 * she can go back and fix an id mid-message and still get the list.
 *
 * Unlike a shortcode this opens on an EMPTY query: `/model ` with nothing
 * after it is unambiguous, and showing all of them is the answer to not
 * knowing what to type. A bare `:` had to stay quiet because it is also most
 * of the smileys anyone types; `/model ` is not the start of anything else.
 */
export function matchModelArgToken(content: string, caret: number): ModelArgToken | null {
  if (caret < 0 || caret > content.length) return null;
  const upto = content.slice(0, caret);
  const m = upto.match(MODEL_ARG);
  if (!m) return null;
  return { start: upto.length - m[1].length, query: m[1] };
}

/** Replace the partial id at the caret with the chosen one, leaving the caret
 *  after it. No trailing space — the id is the whole argument, so the next
 *  thing she does is send. */
export function applyModelArg(
  content: string,
  token: ModelArgToken,
  caret: number,
  id: string,
): { content: string; caret: number } {
  const before = content.slice(0, token.start);
  const after = content.slice(caret);
  return { content: `${before}${id}${after}`, caret: before.length + id.length };
}
