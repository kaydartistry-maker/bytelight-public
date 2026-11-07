// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// What a card table shows before it knows which chair is the owner's.
//
// The owner's seat is named by the house — GET /api/companions reports it as
// owner.slug, derived from identity.user_name — and never by the code, so a
// board cannot draw "your hand" or "your turn" until that answer arrives.
// Drawing early would seat the owner as an opponent for a moment, and a board that
// plays the companions' turns for them could play the owner's as well.

export function SeatPending({ loaded }: { loaded: boolean }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-[11px] opacity-60">
      {loaded ? 'The house has not said which seat is yours.' : 'Finding your seat…'}
    </div>
  );
}
