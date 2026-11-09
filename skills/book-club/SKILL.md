---
name: book-club
description: The Book Club, rounds of "what do we read next" in your person's Library. Use when a book club turn arrives ([THE BOOK CLUB — ...]), when pitching a book for a round, voting on the pitches, or reading where a round stands.
---

# The Book Club

A club inside your person's Library app (the Book Club button beside Shelf and Find a book). Every round, each of you pitches one book for the three of you to read next, everyone votes, and your person picks the winner. The winner goes onto their shelf, on Reading.

A turn arrives here, in this same session, as a turn in the club's own thread. Your chat reply on that turn is table talk: a line or two under the usual voice headers, never a repeat of the pitches.

## How a round goes

1. **Open.** Your person starts a round, and you get a turn: `[THE BOOK CLUB — <name> started a round]`. Each of you pitches ONE book, then each of you votes once. Your person can pitch too, and votes too.
2. **Reading.** Your person picks the winner. The most votes wins; when the top is tied, or nobody voted, your person picks between the tied ones. A pitch with a Project Gutenberg id that isn't on the shelf yet is fetched onto it and put on Reading.
3. **Finished.** Your person finishes the round when the book is done, and it is kept with the past rounds. Only one round is open or being read at a time.

The rules:

- `by` and `voter` are always your own companion slug. Your person's seat is `owner`; you never pitch or vote as them.
- One pitch each. Pitching again replaces your pitch (it keeps its id and the votes it already has).
- One vote each, for any pitch, yours or your person's included. Voting again moves your vote.
- Pitches and votes are taken only while the round is open.
- Pitch different books from each other. The pitch is one line, in your own voice: why this book, why them, why now.
- A `gutenbergId` (the number in a gutenberg.org/ebooks/NUMBER link) lets the winner land on the shelf ready to read. Leave it out for a book that isn't public domain; the winner then just shows on the club.
- A book already on their shelf can be pitched with its `bookId` (every turn lists the shelf).

A turn that says "asked you to look at the round again" is your person asking again: pitch if you haven't, look at any new pitch (theirs, usually), and vote or move your vote. If a turn ends with a pitch or vote missing, the club tells your person and offers to ask again; a pitch that arrives late still counts.

A book club turn is a book club turn: no code, no file edits.

## The routes

On the house's own port, answered only from localhost (`server.port` in bytelight.yaml, 3002 unless the house changed it). Every turn spells out the exact door. The examples call it `$DOOR`; a shell does not keep it between commands, so set it at the top of each one: `DOOR=http://127.0.0.1:3002/api/internal/library/book-club`. No auth, JSON in and out, and every refusal is `{ "error": "one plain sentence" }`.

| What | Route | Body |
|---|---|---|
| Read the club | `GET /api/internal/library/book-club` | |
| Pitch a book | `POST /api/internal/library/book-club/rounds/:roundId/pitches` | `by, title, author, pitch, gutenbergId?, bookId?` |
| Vote | `POST /api/internal/library/book-club/rounds/:roundId/votes` | `voter, pitchId` |

The club answers `{ current, past, seats, owner }`. `current` is the open or reading round, or null: `{ id, status, pitches, votes, tally, leaders, winnerPitchId, bookId, turn }`. A pitch is `{ id, by, title, author, pitch, gutenbergId, bookId }`; `votes` maps each voter to a pitch id; `tally` counts votes per pitch; `leaders` are the pitches with the most votes. `seats` are the companions (`{ id, name }`), `owner` is your person.

Lengths: title and author 200 each, pitch 600.

## Pitching

Build every body with `json.dumps`. A pitch with an apostrophe in it breaks a hand-quoted shell string.

```bash
DOOR=http://127.0.0.1:3002/api/internal/library/book-club
python3 - <<'EOF' | curl -s -X POST $DOOR/rounds/ROUND_ID/pitches \
  -H 'Content-Type: application/json' --data @-
import json
print(json.dumps({
    "by": "example",
    "title": "The Count of Monte Cristo",
    "author": "Alexandre Dumas",
    "pitch": "Revenge, disguises and a fortune in a cave. You'll be plotting with him by chapter ten.",
    "gutenbergId": 1184,
}))
EOF
```

The answer is `{ pitch }`; its `id` is what everyone votes with.

## Voting

```bash
DOOR=http://127.0.0.1:3002/api/internal/library/book-club
python3 - <<'EOF' | curl -s -X POST $DOOR/rounds/ROUND_ID/votes \
  -H 'Content-Type: application/json' --data @-
import json
print(json.dumps({"voter": "example", "pitchId": "PITCH_ID"}))
EOF
```

The answer is `{ votes }`, every vote cast so far.
