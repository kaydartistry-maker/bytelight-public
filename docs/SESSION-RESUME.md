# Reopening a Claude lane instead of rebuilding it

A warm Claude lane is an interactive `claude` CLI process holding a
conversation (one per lane: `primary`, and each companion's own lane). When the
backend restarts, that process dies. Before this, every relaunch built a brand
new room and spent its first turn re-reading the last thirty messages back
("Session recycled — re-primed with recent thread history").

Now the lane reopens the conversation it was already in.

## How it works

- A fresh launch **names its session** with `--session-id <uuid>` and banks the
  id in `data/heartbeat/<lane>/io/.session-id` (the room's identity goes in
  `io/.room-id`).
- The **first launch after a backend restart** hands the id back with
  `--resume <id>`. Same history, same thread of thought. The `.fresh` flag is
  cleared, so the thirty-message re-prime is skipped; the room gets a short
  resume prompt instead (do not re-orient, do not greet, wait for a turn).
- A **model change** also reopens the same room. So does the **first watchdog
  kill** of a room (the house around it may have been the problem); a second
  kill before the reopened room has stayed up 30 minutes builds new.
- A usage-cap, login or refused-model backoff also reopens the room once the
  backoff ends; the room was never at fault.
- Everything else still builds a new room: the restart flag, two fully silent
  turns, a crash, sleep-mode wake.
- A room is only reopened if it has had at least one message handed to it
  (`io/.marks-room` names it). A room that launched and never got a turn never
  got its re-prime either, so it is rebuilt and primed instead.
- If the CLI left behind by the previous backend process does not exit within
  five seconds of being told to, that launch builds a new room rather than
  share the transcript with it.
- The first turn after a backend start still carries the full orientation
  manual once (nothing in a new process has handed it over yet). Later turns
  are lean, as before.

The launch log names the door it took:
`launching interactive claude --model … --resume <id>` or
`… --session-id <id> (new conversation)`.

## When it cannot reopen

If the banked id names nothing the CLI can find, it prints
`No conversation found with session ID` and exits within a second. The exit
handler drops the id, and the relaunch two seconds later builds a fresh room
and primes it exactly as before. A reopened launch that dies at the door for
no known reason is treated the same way. A usage cap, a lost login or a
refused model is never blamed on the room. Nothing waits on a person.

If a room dies before reading her message and the lane relaunches as a new
room, the unread line is set aside and handed to the new room again, with the
recent history and the full orientation (once per new room). If the backend
itself goes down in that moment, the next start gives the message back to
the missed-message check, so it is never lost.

Every non-zero exit now leaves a line in `io/exits.jsonl` with the child's last
stderr lines, so an exit can be explained after the fact.

Load-bearing detail: the id goes **immediately** after `--resume`. That flag's
value is optional, so a dash-argument there opens the CLI's interactive
session picker, a process that neither exits nor ticks. The Neuralis
`--mcp-config` flag is variadic, so it rides after the prompt with nothing
behind it. Tests pin both.

## What a reopened room learns

A reopened room is continuous with its own past, but the restart may have
swallowed things. The lane's marks now survive the restart (one ISO stamp per
file in `io/`):

- `.last-handed-user`: the newest of her messages this lane was handed. A
  fully silent turn rewinds it so her message is offered again.
- `.last-turn`: when the lane last finished a turn, and `.marks-room`: which
  room wrote the marks. Marks written by a different room are treated as
  unknown.
- `.other-lane-read.<hash>`: per thread, how far the other-lane net has read.

On a reopened room's first turn with her, the other-lane net hands over what
other lanes said in the thread since the room last read it (falling back to
the lane's last turn, then to the capped window), and her missed messages are
labelled as having landed during a restart. At most the ten newest of her
missed messages are listed in a turn; every one is still recorded in
`io/missed-inbound.jsonl`.

## The instruction copy

The CLI attaches the lane's `CLAUDE.md` to the transcript at every start, and
on a resume it attaches the whole new file again if it differs from the copy
the room already holds. Two things keep that from piling up:

- **Held instructions.** When only the core-memory walls moved, the room's own
  copy goes back on disk for a minute while the CLI starts, and just the walls
  that moved ride in the resume prompt. The current file is written back on the
  next turn. A change outside the walls takes the whole new copy.
- **Transcript trim.** Only when the room is going to take a whole new copy
  anyway (something outside the walls changed, or its copy cannot be found):
  stale instruction copies are cut out of a new copy of the transcript
  (parents re-linked) and that copy is resumed. When the file is unchanged or
  can be held, nothing is trimmed, because the CLI attaches nothing new and a
  trim would only write a whole transcript to disk. Transcripts over 32 MB are
  never trimmed (the trim reads the whole file into memory); recent lane
  transcripts here run about 1-18 MB.

  No fallback copy is kept, to keep disk use low. The trimmed copy is written,
  read back and checked (every line parses, every parent it names is present,
  the last record made it); only then is the original deleted, in the same
  step. If the check fails, the copy is discarded and the original is reopened
  untrimmed. A transcript that is missing or empty is not reopened at all; the
  lane builds a new room.

## The switch

`agent.claude_session_resume` in the config table. Default **on**. Set it to
`off`, `false` or `0` to build a fresh room on every launch, as before.

Optional: `heartbeat.autocompact_tokens` (100000 to 1000000) sets where a room
compacts. Unset, 200k-window models get 140000 so a reopened room has headroom.

## Not covered

Stop does not reopen anything. Here Stop flags the runtime and the CLI process
keeps running, so there is no exit to reopen from.

Sessions are files. Every room this house has opened is still under
`~/.claude/projects/<slug>/<uuid>.jsonl`, whether it was resumed or replaced.
