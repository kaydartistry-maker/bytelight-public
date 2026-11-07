// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Who can be the owner's partner at a partnership table (Spades, Euchre): the
// companions who live in this house, as GET /api/companions lists them, in
// their stored order. The first is preselected, and the server falls back to
// the same one when a request names nobody.

/** The companions offered as a partner, in order. */
export function partnerChoices(companions: Array<{ slug: string }>): string[] {
  return companions.map((companion) => companion.slug);
}

/** The partner chosen when the owner has not picked one: the house's first companion. */
export function defaultPartner(companions: Array<{ slug: string }>): string | undefined {
  return companions[0]?.slug;
}
