// Ported from a sibling fork. Licensed under the Apache License 2.0.
/**
 * A bell can belong to more than one companion, so that several of them can
 * answer it, each in their own head.
 *
 * `cron.<wakeType>.companion` has always held one slug. It now holds a list,
 * comma separated, in the order the owners answer. A bell never fans out on its
 * own, because tripling a bell nobody asked to triple would ring it three times
 * and paint three selfies; a list is the user saying so on purpose. So a bell with
 * several owners rings in each owner's own head in turn, and each one after the
 * first is handed what the companions before them said, the same way the user's own
 * messages fan out when every companion has a lane.
 *
 * One slug reads exactly as it always did. An older build handed a list looks
 * for a companion literally called "birch,willow,cedar", finds nobody, and falls
 * back to the shared bell, which is the safe direction to be wrong in.
 */
export function parseBellOwners(raw: string | null | undefined): string[] {
  const seen = new Set<string>();
  for (const part of (raw || '').split(/[\s,]+/)) {
    const slug = part.trim();
    if (slug) seen.add(slug);
  }
  return [...seen];
}

/**
 * What the next owner in line is handed. Not the fan-out block the user's messages
 * use: that one tells a lane it is answering THE USER and must not answer the
 * other companions, and on a bell they are exactly who it is there with.
 */
export function sameBellBlock(spoken: Array<{ name: string; text: string }>): string {
  if (spoken.length === 0) return '';
  return [
    '',
    '',
    '[Same bell. It belongs to more than one of you and rings in each of your own heads in turn,',
    'so the other companions it belongs to have already answered it, and what they said is below and already in the room.',
    'This is your turn in the same bell. Answer them if you want to; they are in the room with you.',
    'Never speak under another companion\'s header, and do not restage what they already did.',
    'Pick up from where they left it and bring what only you would bring.',
    `To call another companion back for one more pass, address them by name, opening a sentence with it or tagging it on the end after a comma. A bell answers at most ${MAX_BELL_RECALLS} calls, then it ends.]`,
    ...spoken.map((s) => `${s.name} already said, in this bell:\n${s.text}`),
  ].join('\n');
}

/**
 * How many times one bell can be called back past its owner list. A companion may
 * call another back by name to keep a bell going, but not indefinitely, because
 * every pass spends tokens. So the cap is in the machine rather than in our
 * manners, the same way the Discord guard holds our mouth after three bot turns.
 */
export const MAX_BELL_RECALLS = 2;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Which companion a turn addressed by name, if any. Only DIRECT ADDRESS counts:
 * the name opening a sentence and followed by a comma or a stop ("Birch, come
 * here." / "Cedar."), or tagged onto the end of one after a comma ("..., Willow?").
 * We say each other's names all the time in passing, and a mention that only
 * talks ABOUT another companion must not wake them, or every bell would spend its whole
 * allowance on the word "Birch".
 */
export function addressedOwner<T extends { slug: string; name: string }>(
  text: string,
  speakerSlug: string,
  owners: T[],
): T | null {
  let best: { owner: T; at: number } | null = null;
  for (const owner of owners) {
    if (owner.slug === speakerSlug || !owner.name) continue;
    const name = escapeRegExp(owner.name);
    const patterns = [
      new RegExp(`(?:^|[\\n.!?]\\s*)${name}[,.!?]`, 'g'),
      new RegExp(`,\\s*${name}\\s*[.!?]*(?=\\s*(?:$|\\n))`, 'g'),
    ];
    for (const re of patterns) {
      const match = re.exec(text);
      if (match && (!best || match.index < best.at)) best = { owner, at: match.index };
    }
  }
  return best ? best.owner : null;
}

/** Added to the recalled owner's prompt so they know why the bell came back. */
export function recallNote(callerName: string): string {
  return `\n\n[${callerName} called you back by name, so this bell came round to you once more. Answer them.]`;
}


/**
 * Ring one bell through its owners in order, then honour up to
 * MAX_BELL_RECALLS call-backs. `turnFor` runs one owner's turn with what has
 * been said so far and any extra note, and returns their words, or null when they
 * passed, timed out or said nothing. Kept apart from the orchestrator so the
 * order and the cap can be tested without a real lane.
 */
export async function ringBellInTurn<T extends { slug: string; name: string }>(
  owners: T[],
  turnFor: (owner: T, spoken: Array<{ name: string; text: string }>, extra: string) => Promise<string | null>,
  onRecall?: (caller: T, target: T, n: number) => void,
): Promise<Array<{ name: string; slug: string; text: string }>> {
  const said: Array<{ name: string; slug: string; text: string }> = [];
  let last: { owner: T; text: string } | null = null;
  const ring = async (owner: T, extra: string): Promise<boolean> => {
    const text = await turnFor(owner, said.map(({ name, text }) => ({ name, text })), extra);
    if (!text) return false;
    said.push({ name: owner.name, slug: owner.slug, text });
    last = { owner, text };
    return true;
  };
  for (const owner of owners) await ring(owner, '');
  for (let n = 1; n <= MAX_BELL_RECALLS; n++) {
    const caller = last as { owner: T; text: string } | null;
    if (!caller) break;
    const target = addressedOwner(caller.text, caller.owner.slug, owners);
    if (!target) break;
    onRecall?.(caller.owner, target, n);
    if (!(await ring(target, recallNote(caller.owner.name)))) break;
  }
  return said;
}
