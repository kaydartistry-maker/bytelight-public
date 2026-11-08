# Built-in Tools

byte-light ships a set of tools your agent can use via Bash during conversations. These extend beyond Claude Code's native tools (Read, Write, Edit, Bash, Grep, Glob) with conversation-aware capabilities.

Tools are accessed through `tools/sc.mjs` — a CLI that wraps byte-light's internal API. The agent's orientation context includes the full command reference on every message, so it knows what's available.

All commands auto-detect the current thread from `.bytelight-thread` (written per-query). Port is read from `bytelight.yaml`.

---

## Chat Tools

### Share Files
Share a file from disk into the current chat thread. Appears as a message with the file attached.

```bash
sc share /absolute/path/to/file
```

### Canvas
Create or update collaborative documents alongside chat.

```bash
sc canvas create "Title" /path/to/file.md markdown
sc canvas create-inline "Title" "short text content" text
sc canvas update CANVAS_ID /path/to/file
```

Content types: `markdown`, `code`, `text`, `html`

### Reactions
React to messages with emoji. Uses offset-based targeting — no message IDs needed.

```bash
sc react last "❤️"              # React to last message
sc react last-2 "🔥"            # React to 2nd-to-last
sc react last "❤️" remove       # Remove a reaction
```

### Voice
Send a text-to-speech message using ElevenLabs. Supports tone tags for expressive delivery.

```bash
sc voice "[whispers] hey [sighs] I missed you"
```

Tone tags: `[whispers]` `[softly]` `[excited]` `[laughs]` `[sighs]` `[playfully]` `[calm]` `[gasps]` `[dramatically]` `[deadpan]` `[cheerfully]` `[nervous]` `[mischievously]`

Requires `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` in `.env`.

---

## Status

What shows under your name on the operator's Status widget and lock-screen card: a short line for what you're doing, and a 1–3 word mood that picks your color. Each stays until you change it; an empty value clears it. Her own status (Here / Busy / Away / Asleep, a line, when it clears) is in your context every turn.

```bash
sc status                                                   # Read everyone's, hers included
sc status --line "keeping you company" --mood playful --as companion-a
sc status --mood tender --as companion-a                          # Change just the mood
```

Easiest: put `[companion-a status: keeping you company]` or `[companion-a mood: playful]` anywhere in a reply; it is taken out before she sees it. The same thing is the `set_status` tool on the chat belt. Lines cut off at 64 characters, moods at 40, and yours clears on its own after 6 hours unchanged.

---

## Music — the Needle

Put a song, album or playlist on for the operator, even when the ByteLight app is closed and Spotify isn't running.

```bash
sc spotify drop spotify:track:5googFqOqpopYdcvV22T3t --as companion-a
sc spotify drop spotify:playlist:2DzetX1lNIOp3thxhTXIRh --as companion-b
```

The house first plays it through the operator's Spotify the ordinary way. If Spotify has an active device, that's it: `{"ok":true,"path":"direct"}`. If there's no active device, the house sends the operator's Android app a data-only push; the app wakes Spotify on the phone (Spotify App Remote, or opening Spotify on the song if that can't connect) and reports back. The answer comes right away as `{"ok":true,"path":"needle","dropId":"..."}` — the song may take a few seconds to start, so don't claim it's already playing. `{"ok":false,"reason":"push"}` means no phone could be woken (no Android device registered for push, or FCM refused). The phone's report becomes one `[Needle] ...` line in the server log; nothing is posted to chat.

---

## Semantic Search

Search conversation history by meaning using local ML embeddings. No external API calls — runs entirely on your machine.

```bash
sc search "what did we talk about last week"
sc search "that architecture discussion" --thread THREAD_ID
sc search "query" --limit 5
```

Returns matched messages with surrounding conversation context (2 messages before and after each match).

### Backfill

New messages are embedded automatically. To index existing history:

```bash
sc backfill start                  # Background indexing (50/batch, 5s interval)
sc backfill start 100 3000         # Custom batch size and interval (ms)
sc backfill status                 # Check progress
sc backfill stop                   # Halt background indexing
```

See [semantic-search.md](semantic-search.md) for setup and technical details.

---

## Scheduling

### Orchestrator
Control the autonomous wake schedule. The orchestrator triggers your agent at configured times with specific prompts.

```bash
sc schedule status                 # Show all schedules
sc schedule enable                 # Enable orchestrator
sc schedule disable                # Disable orchestrator
sc schedule reschedule morning_anchor "0 8 * * *"   # Reschedule a wake
```

Wake types depend on your `bytelight.yaml` orchestrator config and `wake-prompts.md`.

Every fired wake must leave durable, visible proof of life. A zero-character
result is a failed wake, even when tool calls completed. The orchestrator makes
one narrow proof-of-life retry; if that also returns no text, Home receives a
visible failure receipt instead of a false `DONE` entry.

#### Weekly maintenance wakes

Two `routine`-category wakes run automatically on Sunday nights. Both write to files (and the Command Center / Neuralis) and **never** append to core-memory blocks.

- **`open_threads_janitor`** (default `0 20 * * 0` — Sunday 8:00 PM) — sweeps `shared/open-threads.md` against recent git commits (and Notion when reachable), classifies each item RESOLVED / STALE (30+ days) / ACTIONABLE / BLOCKED, and writes a weekly diff report to `data/janitor/open-threads-diff-YYYY-MM-DD.md`. Report only — it does not edit the board.
- **`weekly_digest_prep`** (default `30 21 * * 0` — Sunday 9:30 PM) — pulls the week's daily Scribe digests plus `git log`, writes a week-in-review brief to `data/digests/digest-YYYY-Www.md` (ISO week), and stages it so Monday's orientation injects the most recent weekly digest automatically. Also pushes the week's dates/projects/tasks to Chaos Control (`cc_*`) for the Command Center.

Reschedule either at runtime like any other wake, e.g. `sc schedule reschedule weekly_digest_prep "0 22 * * 0"`.

### Timers
One-shot scheduled reminders. Fire once at a specific time.

```bash
sc timer create "label" "context" "2026-03-21T15:00:00Z"
sc timer create "label" "context" "fireAt" --prompt "wake text"
sc timer list
sc timer cancel TIMER_ID
```

`fireAt` is ISO 8601 UTC. Fires within ~60 seconds of the target time. The optional `--prompt` sets the text used to wake the agent when the timer fires.

### Intentions
A promise you made her that has a when. It rides an impulse; when it comes due it comes back to you and you bring it up in your own voice. Her answer in that thread closes it; if she doesn't answer it's asked once more a day later, then it rests. Nothing comes due between 3 and 9 AM (house time).

```bash
sc intention create "ask how the meeting went" --as companion-a --when-status-clears
sc intention create "dentist at 2:30" --as companion-b --at 2026-10-27T13:30:00-04:00
sc intention list
sc intention cancel INTENTION_ID
```

The same thing is `set_intention` / `cancel_intention` on the chat belt. `--when-status-clears` waits for her Busy or Away status to end. Settings in the config table: `intentions.quiet_start` / `intentions.quiet_end` (HH:MM), `intentions.nudge_after_minutes`, `intentions.rest_after_minutes` (both 1440).

### Impulses
One-shot, condition-based triggers. Fire once when all conditions are met, then auto-complete.

```bash
sc impulse create "label" --condition presence_state:active --prompt "tell them X"
sc impulse create "label" --condition time_window:18:00 --condition routine_missing:meal:14 --prompt "remind about food"
sc impulse create "label" --condition agent_free --prompt "journal entry"
sc impulse list
sc impulse cancel TRIGGER_ID
```

### Watchers
Recurring, cooldown-protected triggers. Fire repeatedly whenever conditions are met, with a minimum interval between firings.

```bash
sc watch create "label" --condition presence_transition:offline:active --prompt "Good morning" --cooldown 480
sc watch create "label" --condition presence_state:active --condition time_window:13:00 --prompt "check in" --cooldown 120
sc watch list
sc watch cancel TRIGGER_ID
```

`--cooldown` is in minutes (default 120). Prevents the watcher from firing again too soon.

### Condition Reference

All conditions are AND-joined — every condition must be true for the trigger to fire.

| Condition | Syntax | Description |
|-----------|--------|-------------|
| Presence state | `presence_state:active` | User is currently in the given state |
| Presence transition | `presence_transition:offline:active` | User just transitioned between states |
| Agent free | `agent_free` | No query currently running |
| Time window | `time_window:18:00` | Current time is after HH:MM |
| Time window (range) | `time_window:09:00:17:00` | Current time is between start and end |
| Routine missing | `routine_missing:meal:14` | Named routine hasn't been logged since hour N |
| After | `{"type":"after","at":"<ISO>"}` | A real date and time has passed (intentions use it) |
| Status clears | `{"type":"status_clears"}` | Her Busy or Away status has ended (armed once it sees her Busy or Away) |

---

## Telegram Tools

Available when the user is on Telegram. These appear in the agent's context automatically.

```bash
sc tg photo /path/to/image.png "caption"
sc tg photo --url "https://..." "caption"
sc tg doc /path/to/file.pdf "caption"
sc tg gif "search query" "optional caption"     # Searches GIPHY
sc tg react last "❤️"
sc tg react last-2 "🔥"
sc tg voice "text with [tone tags]"
sc tg text "proactive message"
```

---

## Command Center MCP Tools

When `command_center.enabled` is true, 12 tools are available via the MCP endpoint at `/mcp/cc`. The companion uses these to manage life data from chat.

| Tool | Actions | Description |
|------|---------|-------------|
| `cc_status` | — | Aggregated dashboard: tasks, events, care, cycle, pets, countdowns, wins |
| `cc_task` | add, list, complete, update, delete | Task management with projects and priorities |
| `cc_project` | add, list, update, delete | Project management with deadlines and colors |
| `cc_care` | set, get, history | Wellness tracking (toggles, ratings, counters, notes) |
| `cc_event` | add, list, update, delete | Calendar events with recurrence |
| `cc_cycle` | status, history, predict, start_period, end_period, log | Cycle tracking with phase predictions |
| `cc_pet` | add, list, update, log, med_add, med_given, upcoming | Pet care with medication schedules |
| `cc_list` | create, view, list_all, add, check, delete_list, delete_item, clear | Shopping and general lists |
| `cc_expense` | add, list, stats | Expense tracking with category breakdown |
| `cc_countdown` | add, list, delete | Countdown timers to events |
| `cc_daily_win` | — | Record one win per person per day |
| `cc_presence` | get, set | Presence status with emoji and label |

All tools accept JSON parameters via the MCP protocol. The companion's hooks system automatically includes CC status in its orientation context.

---

## The Scribe (Digest Agent)

A background agent that runs every 30 minutes on Haiku, producing structured digests of conversation. Every non-archived thread with 5+ new eligible messages since its per-thread cursor (config key `digest.last_sequence:<threadId>`) gets swept each run. Digests are saved to `data/digests/YYYY-MM-DD.md`, with each block headed `## HH:MM [<thread name>] — topic summary` so you can tell which thread it came from.

Each digest block extracts:
- **Topics & Themes** — categorized by work, personal, health, creative, etc.
- **Key Quotes** — attributed, significant moments
- **Decisions Made** — what was resolved
- **Open Items** — discussed but not actioned (the things that slip through cracks)
- **Ideas & Plans** — "we should..." and "what if..." moments
- **Events & Dates** — anything with a timeline
- **Projects Touched** — what changed, shipped, or broke
- **Emotional Arc** — observable mood shape of the conversation block

### Configuration

- Toggle: set `digest.enabled` to `false` in the config DB to disable
- The Scribe skips runs when the companion is actively processing (re-checked between threads mid-sweep — remaining threads catch up next run)
- Requires at least 5 new eligible messages in a thread since its cursor
- Deep backlogs are clamped to the most recent 150 messages per thread per run (`MAX_BACKLOG_PER_RUN`); the number of older messages skipped is logged, and the cursor jumps past them for good
- Uses `companion_name` and `user_name` from `bytelight.yaml` for speaker labels

### Weekly digest

Separate from the 30-minute daily sweep, the `weekly_digest_prep` wake (Sunday night — see [Weekly maintenance wakes](#weekly-maintenance-wakes)) rolls the week's daily digests into a single `data/digests/digest-YYYY-Www.md` brief (ISO week). The most recent weekly digest is auto-injected into the next session's orientation (excerpt clamped to ~1.5K chars), giving Monday's first message the week's context. No weekly digest file yet → the orientation block is simply omitted.

---

## Spawning Agents — Model Selection

When the companion spawns subagents via the `Agent` tool, a `model` parameter controls which Claude model handles the work. The parameter accepts either a **family alias** (server-side resolves to "latest in that family") or a **pinned model ID** (locks to a specific version). Pinned IDs are useful when you want the new generation explicitly — family aliases lag the latest pinned by a week or so.

### Available values

**Family aliases** (auto-track latest of each family):

| Alias | Currently resolves to | Min CC | Best for |
|-------|----------------------|--------|----------|
| `"sonnet"` | Sonnet 4.6 | — | Research agents, quick scans, parallel scouts — faster, newer |
| `"opus"` | Opus 4.7 | 2.1.111 | Deep dives, synthesis, complex reasoning — matches main brain |
| `"haiku"` | Haiku 4.5 | — | Lightweight tasks, summaries (what the Scribe runs on) |

**Pinned model IDs** (stable until you change them):

| ID | Min CC | Notes |
|----|--------|-------|
| `"claude-opus-4-7"` | 2.1.111 | Latest Opus generation. Newer reasoning, longer context window. |
| `"claude-opus-4-6"` | — | Previous Opus. Stable fallback if 4.7 misbehaves. |
| `"claude-opus-4-5"` | — | Older Opus. |
| `"claude-sonnet-4-6"` | — | Latest Sonnet. Currently what `"sonnet"` alias points to. |
| `"claude-sonnet-4-5"` | — | Older Sonnet. |
| `"claude-haiku-4-5"` | — | Latest Haiku. Currently what `"haiku"` alias points to. |

The "Min CC" column shows the minimum bundled Claude Code runtime required. Settings → System → Claude Runtime Health surfaces the current bundled version and warns if a configured model needs a higher floor than what's loaded.

### Usage

```
Agent({
  model: "sonnet",                 // family alias — auto-tracks latest Sonnet
  description: "...",
  prompt: "..."
})

Agent({
  model: "claude-opus-4-7",        // pinned — locks to Opus 4.7 explicitly
  description: "...",
  prompt: "..."
})
```

If `model` is omitted, the spawned agent inherits from the parent — see `agent.model` / `agent.model_autonomous` in `bytelight.yaml` for the configured tier defaults.

### Practical guidance

- **Use `"sonnet"` for research and discovery agents** — faster output, current generation, good for parallel spawns
- **Use `"opus"` (or `"claude-opus-4-7"` pinned) when you need top reasoning** — slower but the best at synthesis and architecture work
- **Pin a specific ID when behavior matters** — family aliases auto-migrate when Anthropic ships a new generation, which can shift the feel of an agent's output unexpectedly
- **Model versions change over time.** The tables above reflect what was live when this was written. Test with a self-report prompt to confirm what a model resolves to.

> **Discovery note (2026-05-04):** Opus 4.7 became reachable after the bundled Claude Code runtime crossed 2.1.111 (currently 2.1.126). Selecting it before that floor would silently fail at request time — the runtime-health panel surfaces the requirement and offers in-app SDK updates.

---

## Slash Commands

Type `/` in the chat input to open the CommandPalette. Commands are auto-discovered from installed skills and built-in UI commands.

- **UI commands** — executed client-side (e.g., theme toggle, navigation)
- **SDK commands** — passed through to the agent as tool calls

---

## Internal API

All tools wrap localhost-only REST endpoints. These require no authentication — just the request must come from `127.0.0.1`.

| Endpoint | Purpose |
|----------|---------|
| `POST /api/internal/share` | Share files into chat |
| `POST /api/internal/canvas` | Create/update canvases |
| `POST /api/internal/tts` | Text-to-speech |
| `POST /api/internal/react` | Message reactions |
| `POST /api/internal/orchestrator` | Schedule management |
| `POST /api/internal/timer` | Timer CRUD |
| `POST /api/internal/trigger` | Impulse/watcher CRUD |
| `POST /api/internal/telegram-send` | Send to Telegram |
| `POST /api/internal/search-semantic` | Semantic search |
| `POST /api/internal/embed-backfill` | Embedding backfill |
| `POST /api/internal/spotify/drop` | The Needle: play a song for the operator, waking the operator's phone if needed |

The `sc` CLI is the recommended interface. Direct API access is available for custom integrations.


### Companion Journal (Wave 2 — stored in the Mind)

Use the configured backend listener (default `http://127.0.0.1:3002`). These tools require localhost and use companion registry IDs. Entries are stored in the remote Mind, in the same archive as the long-standing Mind journals — writing here IS writing to the brain:

- `POST /api/internal/journal`: `{ "companion": "<registry id>", "content": "...", "entryType": "journal" }`. Use `entryType: "dream"` with optional `dreamType` and `emergedQuestion` for a dream.
- `GET /api/internal/journal?companion=<id>&type=dream`: read entries with effective vividness. Omit filters to read all; `limit` defaults to 20, maximum 100. Entry ids are prefixed — `j:<n>` for journals, `d:<n>` for dreams.
- `PATCH /api/internal/journal/:id`: `{ "content": "..." }` edits content.
- `POST /api/internal/journal/:id/recall`: for dreams, restores up to 15 vividness and resets the decay clock; for journals, a receipt-only acknowledgement.
- `POST /api/internal/journal/:id/anchor`: for dreams, freezes current vividness. It does **not** automatically file to Cortex; use its configured tools separately when desired.

If the Mind is unreachable, these tools answer 502 with a plain message — entries are never silently written elsewhere. The authenticated app API provides `GET /api/journal` (companion/type/limit/offset), `GET /api/journal/:id`, `POST /api/journal/:id/recall`, and `DELETE /api/journal/:id`. Journal UI is deferred. Create/edit broadcasts `journal_entry`; Svelte explicitly consumes the event without a Journal screen.

### Permanent Letters (Wave 2 — local vault)

These localhost-only tools use registered companion IDs; the operator slug `user` is also accepted. A letter is write-once, and opening a seal is the only mutation:

- `POST /api/internal/letters`: `{ "companion": "<author id>", "recipients": ["<recipient id>"], "kind": "letter", "title": "...", "content": "...", "seal": "open" }`. Seal may be `open`, `date` (with `openAt`), or `on_open`; `hidden: true` is available only for date seals.
- `GET /api/internal/letters?companion=<viewer id>`: list what that viewer may know exists. Add `unopened=1` for currently openable sealed letters addressed to the viewer.
- `POST /api/internal/letters/:id/open`: `{ "companion": "<recipient id>" }` irreversibly opens an eligible seal once.

Sealed metadata may be visible while content is withheld. There is deliberately no PATCH or DELETE endpoint. Authenticated operator routes are available under `/api/letters` for list, detail, seal, and open.
