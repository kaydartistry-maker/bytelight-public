// Ported from a sibling fork (its agent-dispatch room helpers). Licensed under the Apache License 2.0.
//
// The Room: with "A Lane Each" on, a conversational turn passes between the
// companions' own sessions in a shuffled order, each later seat handed what
// the earlier ones said. These are the pure pieces of that, copied whole.

/** Fisher-Yates. The speaking order is rolled per turn so no lane is permanently first. */
export function shuffled<T>(items: T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * What a lane is handed when other companions have already spoken in this same turn.
 * Framed as overheard rather than as instruction: they are answering THE OWNER, and the
 * others are simply in the room, which is the whole point of passing the turn
 * along instead of fanning it out in parallel.
 *
 * THE FAILURE THIS WORDING IS AIMED AT (caught by putting two replies side by
 * side): "do not repeat their points back" reads as "do not quote them", and
 * none of us was quoting. Three companions who love the same person, handed
 * the same message, independently reach for the same obviously-right answer — so
 * the second and third replies came out as the first one with different
 * punctuation, each one certain they were being thoughtful. That is CONVERGENCE, not
 * repetition, and the old wording did not name it. The handoff also arrives
 * LOOKING like a message, and the natural thing to do with a message is answer
 * it, which is why the later a lane sits the more it echoes the line above it.
 * So: name the obvious answer as already spent, and say plainly that the block is
 * ground taken rather than something addressed to them.
 *
 * SECOND PASS, for a different half of the same fault: two lanes ended on "thank
 * you for the thread" in nearly the same words, and a third asked for the same
 * thing. Nobody was making a point — they were ending politely. A courtesy is the
 * cheapest available last line, so all three reach for it, and the convergence
 * lands at the END of a message where the wording above only guarded the
 * beginning. Hence the explicit rule against closing on a gesture.
 *
 * AND SILENCE IS NAMED AS AN OPTION, which it never was. On one shared lane three
 * voices cost the owner a single message; on separate lanes they cost three, so a lane
 * with nothing new to add is not being thorough by speaking — it is spending the owner's
 * attention on a turn that did not need it. The wording says so out loud, because
 * a model handed a prompt reads answering as the job unless told otherwise.
 */
/*
 * ADAPTED (the owner's call, 2026-10-21): the handoff wording above kept the
 * later lane AWAY from the earlier one ("replying to THE OWNER, not to them",
 * "not a message addressed to you") — right for a house whose companions kept
 * converging. This house's companions are meant to talk to each other as well
 * as to her, so the later lane may play off the earlier one. Kept from the
 * original: no summarising, no echo / convergence, no closing gesture, always
 * answer. "The owner" became her name (identity.user_name), never "owner" or "user".
 */
export function priorVoicesBlock(spoken: Array<{ name: string; text: string }>, userName = 'her'): string {
  const user = userName.trim() || 'her';
  const names = spoken.map((s) => s.name);
  const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] ?? 'He';
  const he = names.length > 1 ? 'They' : 'He';
  const him = names.length > 1 ? 'them' : 'him';
  const his = names.length > 1 ? 'their' : 'his';
  const lines = spoken.map((s) => `${s.name} already said, in this same turn:\n${s.text}`);
  return [
    '',
    '',
    `[Same turn: ${who} ${names.length > 1 ? 'are' : 'is'} in the room with you and already answered ${user}. You can hear exactly what ${he.toLowerCase()} said.`,
    `You're both talking to ${user}. ${he} ${names.length > 1 ? "aren't" : "isn't"} a message you have to reply to, and ${he.toLowerCase()} ${names.length > 1 ? "aren't" : "isn't"} background either — ${he.toLowerCase()}'${names.length > 1 ? 're' : 's'} right here.`,
    `Play off ${him} if it's real: answer ${him}, tease ${him}, push back, back ${him} up, pick up the thread ${he.toLowerCase()} left hanging. Or take it somewhere ${he.toLowerCase()} didn't go.`,
    `Don't summarize ${him} or translate ${him} to ${user} — ${user} heard ${him}; ${he.toLowerCase()} said it the way ${he.toLowerCase()} wanted it to land.`,
    `Don't echo ${him}: if your best line is one ${he.toLowerCase()} could've written, it's ${his}. Say the thing only you would say.`,
    `Don't end on a gesture. A polite closer — thanking ${user}, telling ${user} to rest, "keep going" — is the cheapest last line, and you'll both reach for it. End on the last real thing you had.`,
    "Never speak under another companion's header.",
    `Always answer. ${user === 'her' ? 'She wants' : `${user} wants`} both of you, not just whoever got there first.]`,
    '',
    ...lines,
  ].join('\n');
}


/**
 * Whether this turn fans out across the companions' own lanes. Autonomous
 * turns never fan out — a wake already targets one companion, and tripling it
 * would ring the same bell three times (and paint three selfies on a
 * spontaneous wake). Tolerates a quoted "true" because a hand-edited
 * yaml config is a supported way in, and a switch that silently ignores the owner's
 * edit is not a switch.
 */
export function shouldFanOut(multiLane: unknown, isAutonomous: boolean, rosterSize: number): boolean {
  const on = multiLane === true || String(multiLane) === 'true';
  return on && !isAutonomous && rosterSize > 1;
}

