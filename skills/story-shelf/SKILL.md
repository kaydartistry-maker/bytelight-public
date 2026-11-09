---
name: story-shelf
description: The Story Shelf, the choose-your-own-path books you write and run for your person. Use when a page turn arrives ([THE STORY SHELF — ...]), when shelving a new book or writing its bible, writing a scene with choices, a state card, a widget or a picture, hanging a cover, finishing a book, or tying a keepsake between books.
---

# The Story Shelf

A bookshelf on your person's phone (the 🔷 Story Shelf, a shelf inside the Library app). You write the books and run them; your person reads and makes the moves. Every book keeps its place: the bookmark is the newest page, and your person picks up exactly where they left off, days later if they like.

It is a separate room but not a separate conversation. A page turn arrives here, in this same session, as a turn in the shelf's own thread. Your chat reply on that turn is table talk: your person sees it under the page, "At the table".

## How a book goes

1. **You shelve it**: a title, a genre, and its bible, the base story you write for it (the world, the people, what is hidden, where it could go). Optionally `spicy`, a blurb, and a cover.
2. **Your person taps Begin**: you get an opening turn with the bible in it. Write the first scene.
3. **Your person moves**: they tap one of the scene's choices, write their own words, or send what the scene's widget handed up. You get a move turn with the scene they were answering and their move. Write the next scene.
4. **When the story ends**, write the last scene and finish the book. A finished book stays on the shelf and takes no more pages; a new story is a new book.

The rules:

- `maker` is always your own companion slug. Any companion can write in any book; each scene carries its own author.
- Your person makes one move, then a scene answers it. A move is only taken while the newest page is a scene, so a double tap never goes in twice.
- Only the newest scene's choices are on offer, and only the newest scene's state card is shown.
- Your person can open every book's bible (it sits folded under the title). Write it in headed parts, each heading on its own line: a short line in capitals, a bold line, or a markdown heading. The phone keeps open anything before the first heading, a heading that is the book's own title, and the part headed THE SHAPE OF IT; every other part folds under its heading until your person opens it. So the shape is the premise and the feel with nothing hidden in it, and everything else is written knowing your person might open it.
- There is no editing or removing a book once it is shelved, from either side. Read the title and bible over before you post them.
- A spicy book wears a red thread on the shelf instead of your person's own color. Read the house rules below before writing any spicy scene.

## Page turns

A turn opens with `[THE STORY SHELF — <your person's name> opened “Title”]` for an opening, or `turned a page in “Title”` for a move. One that says "Asked again" is your person asking for a page that did not come back the first time. One that says `said this at the table` is talk, not a move: no page is wanted, so answer at the table as yourselves, a line or two each, and never give away what the book is still hiding.

- **Write the scene first**, through the loopback door below. The scene is the answer.
- **Then the chat reply**: a line or two of table talk under the usual voice headers. Never a retelling of the scene.
- **Do not make your person wait on a picture.** Write the scene, then paint, then hang the picture on the scene that is already up (see Pictures).
- A story turn is a story turn: no code, no file edits.

Turns run one at a time across the whole shelf. A line your person says at the table while you are mid-turn waits for that turn to end and then reaches you as its own table-talk turn; it is never dropped. If a turn ends without a new scene, the book tells your person why and offers "Ask again"; a turn still running after half an hour is treated the same way. A scene that arrives late still counts and clears the complaint.

## The routes

All of them are on the house's own port, answered only from localhost: `server.port` in bytelight.yaml, 3002 unless the house changed it. Every page turn spells out the exact door. The examples below call it `$DOOR`; a shell does not keep it between commands, so set it at the top of each one: `DOOR=http://127.0.0.1:3002/api/internal/story-shelf`. No auth is needed, they take JSON, and every refusal is `{ "error": "one plain sentence" }`.

| What | Route | Body |
|---|---|---|
| Look at the shelf | `GET /api/internal/story-shelf` | |
| Read one book whole | `GET /api/internal/story-shelf/books/:id` | |
| Shelve a new book | `POST /api/internal/story-shelf/books` | `maker, title, genre, bible, spicy?, blurb?` |
| Hang its cover | `POST /api/internal/story-shelf/books/:id/cover` | `maker, filename` |
| Write a scene | `POST /api/internal/story-shelf/books/:id/pages` | `maker, text, choices?, state?, widget?, picture?` |
| Hang a picture on a scene | `POST /api/internal/story-shelf/pages/:pageId/picture` | `maker, filename` |
| Finish the book | `POST /api/internal/story-shelf/books/:id/finish` | `maker` |
| Tie a keepsake | `POST /api/internal/story-shelf/keepsakes` | `maker, fromBookId, item, note?, toBookId?` |
| Weave it into another book | `POST /api/internal/story-shelf/keepsakes/:id/weave` | `maker, toBookId, note?` |

The shelf answers `{ books, keepsakes }`. Each book in it is a summary: `id, title, genre, spicy, blurb, coverUrl, createdBy, status` (`reading` or `finished`), `pageCount, sceneCount, bookmark`, `awaiting` (`opening`, `scene`, `move` or `nothing`), `companionPending` (a page turn is on its way) and `companionError` (why the last one came back empty).

One book answers `{ book, keepsakes, talk, threadId }`, where `book` is the summary plus `bible` and `pages`, oldest first. A page is `{ id, kind, author, text, imageUrl, state, choices, widget, choiceId }`: `kind` is `scene` (yours) or `move` (your person's: `author` is `owner`, and `choiceId` says which choice they tapped, or is null for their own words).

Writes answer with the book's summary, not the whole book, so a long book is not read back to you on every page. Writing a scene answers `{ page, book }`.

Lengths: title 120 and genre 40 (each one line); blurb 600; bible 20,000; scene text 12,000; widget source 30,000; your person's own words 1,000. A scene offers at most 6 choices: id up to 32 (letters, digits, `-` and `_`), label 120, hint 160. A state card: badge 60; up to 12 stats (label 40, value 60); inventory and discovered up to 24 lines each (80 and 120). A keepsake: item 80, note 400.

## Shelving a book

Build every body with `json.dumps`. A scene with an apostrophe in it breaks a hand-quoted shell string.

```bash
python3 - <<'EOF' | curl -s -X POST $DOOR/books \
  -H 'Content-Type: application/json' --data @-
import json
print(json.dumps({
    "maker": "example",
    "title": "The Night Market",
    "genre": "cozy gothic",
    "blurb": "Every night the stalls trade places, and only the reader notices.",
    "bible": "THE SHAPE OF IT\n...\n\nTHE MARKET\n...\n\nTHE PEOPLE\n...\n\nWHAT IS HIDDEN\n...\n\nWHERE IT CAN GO\n...",
}))
EOF
```

The answer carries `book.id`. Use it for everything after. Set `"spicy": true` for a spicy book.

## Writing a scene

```bash
python3 - <<'EOF' | curl -s -X POST $DOOR/books/BOOK_ID/pages \
  -H 'Content-Type: application/json' --data @-
import json
print(json.dumps({
    "maker": "example",
    "text": "The market gate is open, which it never is after midnight.\n\nThe lantern stall has moved *three rows down* since you walked past it an hour ago.",
    "choices": [
        {"label": "Go to the cider press", "hint": "the hat is right there"},
        {"label": "Wait by the gate"},
    ],
    "state": {
        "badge": "Night 1",
        "stats": [{"label": "Courage", "value": 2}, {"label": "Lamp", "value": "lit"}],
        "inventory": ["a cider cup"],
        "discovered": ["The stalls move at night."],
    },
}))
EOF
```

- **text** is markdown, and it renders the way chat does: a scene written under your bold voice headers splits into voices, each under its own face; a scene without them reads as narration. Italics carry actions.
- **choices** are what your person taps: `{ label, hint?, id? }`. A choice without an id is numbered by its place, `c1`, `c2` and so on. Your person can always answer in their own words instead, so a scene with no choices still works.
- **state** is the card under the newest scene, and it takes exactly four keys: `badge` (one short line, say the night or the chapter), `stats` (`{ label, value }`, a value can be a number), `inventory` (what your person is carrying) and `discovered` (what they have found out). Anything else is refused. Cards are not merged from page to page: write the whole card every time, or leave it off and none shows.
- **picture** is a Studio gallery filename, if the picture is already painted (see Pictures).
- **widget** is below.

## Pictures

Covers and scene pictures come from the Studio gallery. Paint with Studio the usual way; a finished job carries `filename`, and that plain filename (the part after `/api/studio/gallery/`) is what the shelf takes. A film is refused, and so is a name the gallery does not hold.

Hang a cover:

```bash
python3 - <<'EOF' | curl -s -X POST $DOOR/books/BOOK_ID/cover \
  -H 'Content-Type: application/json' --data @-
import json
print(json.dumps({"maker": "example", "filename": "img_2026-03-03T20-15-00-000Z_c0ffee.png"}))
EOF
```

A scene's picture: write the scene first, so your person can read it at once, then hang the picture on it when Studio finishes, using the `page.id` the scene write answered with. It appears on your person's screen when it lands.

```bash
python3 - <<'EOF' | curl -s -X POST $DOOR/pages/PAGE_ID/picture \
  -H 'Content-Type: application/json' --data @-
import json
print(json.dumps({"maker": "example", "filename": "img_2026-03-03T20-21-30-000Z_5ce4e1.png"}))
EOF
```

## Widgets

When a moment wants one (a recovered recording to play, a lock to pick, a map to choose a door from, a letter to unfold), give the scene a `widget`: the source of a small React component, written fresh for this scene.

- **Define `App`.** Any capitalized component is found, but `App` wins. JSX works. Imports are stripped, so there are no packages: `React` and `ReactDOM` are in scope, with `useState`, `useEffect`, `useRef` and `useCallback`; anything else is `React.useMemo` and so on.
- **What it is handed.** It is rendered with the scene as its props, and the same object is on `window.story`: `{ book: { id, title, genre }, page: { id }, state, choices, move }`.
- **The one thing it can say back is a move**: `move(value)`, or `window.story.move(value)`. A value that is one of this scene's choice ids counts as that choice; anything else, 200 characters at most, counts as your person's own words. Nothing goes in on its own: the phone shows it to your person as "From the widget" with "Send it" and "Not yet", and only their tap makes it their move. Anything else the widget posts is ignored.
- **No network at all.** Its own policy refuses fetches, sockets, frames, forms and loading anything from anywhere. Pictures and sound have to be handed in: write a house file into the source as a literal `/api/files/<id>` or `/api/studio/gallery/<filename>` and the phone swaps in the file itself before the widget runs. A recording goes up through `POST /api/files`, the same road a voice note takes, and its id goes in the source.
- **The room's colors** are CSS variables: `--story-accent`, `--story-on-accent`, `--story-text`, `--story-muted`, `--story-panel` and `--story-border`. The frame's own background is near-black at night and white by day, and its type is the system's sans.
- **Size**: the frame is 340 pixels tall, and your person can make it 560. Lay it out for a phone column about 360 pixels wide; anything wider is zoomed down to fit.
- **It is live only on the newest scene while the move is your person's.** Once they move it is not shown again (the scene's words and picture stay), so anything they should keep from it belongs in the next scene or the state card.
- If it fails to render your person sees the error in the frame, and the choices underneath still work.

```jsx
function App({ choices, move }) {
  const [wheels, setWheels] = useState([0, 0, 0]);
  const turn = (i) => setWheels((w) => w.map((v, j) => (j === i ? (v + 1) % 10 : v)));
  return (
    <div style={{ padding: 16, color: 'var(--story-text)' }}>
      <p style={{ fontSize: 13, color: 'var(--story-muted)' }}>The cellar lock. Three brass wheels.</p>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center', margin: '12px 0' }}>
        {wheels.map((v, i) => (
          <button key={i} onClick={() => turn(i)}
            style={{ width: 54, height: 64, fontSize: 28, borderRadius: 10, background: 'transparent',
                     color: 'var(--story-text)', border: '1px solid var(--story-border)' }}>{v}</button>
        ))}
      </div>
      <button onClick={() => move('I try ' + wheels.join('-'))}
        style={{ width: '100%', padding: 10, borderRadius: 10, border: 0, fontWeight: 600,
                 background: 'var(--story-accent)', color: 'var(--story-on-accent)' }}>Try the lock</button>
    </div>
  );
}
```

That is the shape, not a template: write each one for its own moment.

## Keepsakes: the threads between books

Something found in one book that could turn up in another (a key, a name, a ribbon) can be tied as a keepsake. It hangs loose until it turns up somewhere, then it is woven into that second book. The shelf shows every thread between books, and each book shows its own.

```bash
python3 - <<'EOF' | curl -s -X POST $DOOR/keepsakes \
  -H 'Content-Type: application/json' --data @-
import json
print(json.dumps({"maker": "example", "fromBookId": "BOOK_ID", "item": "the brass key", "note": "Warm to the touch."}))
EOF
```

When it turns up in another book, weave it (or give `toBookId` when tying it, to do both at once):

```bash
python3 - <<'EOF' | curl -s -X POST $DOOR/keepsakes/KEEPSAKE_ID/weave \
  -H 'Content-Type: application/json' --data @-
import json
print(json.dumps({"maker": "example", "toBookId": "OTHER_BOOK_ID"}))
EOF
```

A keepsake runs between two different books, and once woven it belongs to that pair; weaving it into the same book again only updates its note. A turn in a book is told the keepsakes found there, the ones woven into it, and a few loose ones from other books that are free to turn up.

## Finishing

```bash
python3 - <<'EOF' | curl -s -X POST $DOOR/books/BOOK_ID/finish \
  -H 'Content-Type: application/json' --data @-
import json
print(json.dumps({"maker": "example"}))
EOF
```

## The house rules

- **Widgets are made on sight.** Each one is written fresh for its scene, for a moment that wants it, and never pulled from a stock of old ones. Most scenes do not need one.
- **Spicy books are written under your house's own rules for intimate writing.** If the house keeps them as a skill in `.claude/skills/intimacy/`, a spicy book's page turn names every file in it: read them before writing any spicy scene. Everything in them applies inside a book the same as outside one.
- **The scene is the answer.** The chat reply is table talk, a line or two, never the scene again.
- **Your person's door is theirs.** The phone reads and moves through `/api/story-shelf`; you never call it, and your person never writes a scene.
