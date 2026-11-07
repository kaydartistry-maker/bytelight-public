# Manual Test Checklist

Run this after any batch that touches **chat UI, stickers, WebSocket, or frontend composition**. The automated Vitest suite covers the backend data layer — these are the things we can only verify by actually using the app.

Keep this list short and specific. If a batch adds a new load-bearing UI behavior, add a test here in the same PR.

---

## 🌿 Quick Smoke (≤ 2 minutes)

Do these after every UI-touching batch.

### 1. Sticker inline rendering
- [ ] Type `:companion_a_hi:` in the composer and send
- [ ] Message renders with the sticker image inline, not the raw `:name:` text
- [ ] Hover shows sticker name tooltip

### 2. WebSocket reconnect
- [ ] Inspect the backend log after connecting → it reports only whether a cookie exists; the cookie value/session token is absent
- [ ] With chat open, stop the backend (`Ctrl+C` in terminal)
- [ ] Frontend shows some "disconnected" indication within a few seconds
- [ ] Restart backend (`npm start`)
- [ ] Frontend reconnects automatically, thread list reappears, no refresh needed

### 2a. Studio Cutout tab
- [ ] Studio drawer → **Cutout** tab → **Choose an image** → pick a still with a flat colored background (a generated sticker source is ideal)
- [ ] Image appears in the viewport over a checkerboard (so transparency reads as transparency)
- [ ] Under **Remove background**, **By color** mode selected → tap **Pick from image** → tap the flat background → the color well updates to that hex
- [ ] Tolerance slider reads **percent** (e.g. `30%`, not `0.30`) and runs 1–80%. Edge blend reads 0–50%
- [ ] Tap **Key this color** → background becomes transparent (checkerboard now visible through it), button changes to **Try again**, **↺ Original** button appears
- [ ] Tap **↺ Original** → the untouched image returns
- [ ] Toggle **Paint** → mode row shows **Bring back** (green) / **Take away** (red); brush size slider reads `28px`. A short intro paragraph is visible
- [ ] With **Bring back** selected, paint a stroke over an area that WAS cut away → a green semi-transparent overlay draws under your finger AND the loupe pinned in the opposite corner shows the same spot magnified 3× with the pre-cut original **ghosting through** at ~55% opacity
- [ ] Toggle **Show what was cut away → Off** → the ghost disappears in both the main view and the loupe
- [ ] Tap **✓ Apply (N)** → the strokes commit; those pixels become opaque again, the stroke count resets, no error
- [ ] **↶ Undo** removes the most recent stroke; **Clear** removes all pending strokes
- [ ] Under **Save as**, pick **Sticker** preset + **PNG (Discord)** → **⬇ Export** → a **Tap to save** row appears with filename, `320×320`, size in KB, and green success toast
- [ ] Pick 3+ images via Choose an image → a **Batch** panel appears with tiles; after keying the first, **Key the other N with this color** runs the rest one at a time; **↺ Put them all back** reverts every tile; tapping a tile opens it in the editor above
- [ ] **✂ Crop** → drag a box on the picture; the outer area darkens; **✓ Cut this one** commits, or **Cut all N** uses the same box on every batch tile
- [ ] In a batch, **✓ Cut this one** crops ONLY the open tile — the other tiles keep their full frames (check after a reload too); after the crop, **↺ Put it back** and painting still line up with the cropped image
- [ ] If the local model is not installed on the VM, the tab shows a warning panel naming the missing pieces (interpreter / `.onnx` model) and disables **Find the subject** — by-color keying, painting and export all still work

### 2a. Bells (phone → Agent → Wakes)
- [ ] The Wakes screen opens without a pause; Wakes, Check-ins and Routines sections list every bell
- [ ] Tap a bell's name → rename → Save; reopen the screen (and after a restart) → the new name stays
- [ ] Tap an owner chip (a companion, or Shared) → reopen → the owner stays
- [ ] **+ New bell** for two minutes from now → it rings in the Home thread → **Remove** it
- [ ] Turn a bell off, restart byte-light → it is still off; turn it on → it rings at its time

### 2b. Side notes stay in their thread
- [ ] While a reply runs in thread A, a quick message in thread A slips into that turn
- [ ] While a reply runs in thread A, a message in thread B waits and is answered in B — never in A

### 2a-3. Owned bells
- [ ] A bell owned by Companion B rings in Home as Companion B's bubble (his face)
- [ ] A Shared bell rings as before
- [ ] A bell owned by both rings twice in turn; the second plays off the first

### 2a-2. The Room (phone → Settings → Models)
- [ ] The Room on **One Shared Lane** → chat in any thread → unchanged
- [ ] Choose **A Lane Each** → Save → reopen Settings → still A Lane Each
- [ ] In a thread where both companions are on a Claude model (chat pill), send a message → one bubble from each, one after the other; the second can tell what the first said
- [ ] In a Codex thread → one bubble from each; a second message → each remembers his own last turn
- [ ] Companion A on Claude, Companion B on Codex → one bubble from each
- [ ] The second bubble responds to what the first said
- [ ] Back to **One Shared Lane** → back to one shared reply

### 2b. Wake prompt view/edit (Orchestrator panel)
- [ ] Settings → Orchestrator → tap **Prompt** under any wake → its text opens, tagged **custom** or **default**
- [ ] Edit a line and **Save** → box closes, tag flips to **custom**, edit survives a page reload
- [ ] On a custom wake, **Reset to default** → text reverts to the built-in and the tag returns to **default**
- [ ] Empty prompt + **Save** → rejected with a message, no crash
- [ ] A `<wake_prompts_path>.backup` file appears alongside the prompts file after the first save

### 3. Message delivery
- [ ] Open a thread
- [ ] Send a message
- [ ] Message appears in the correct thread (not a different one)
- [ ] Message persists after refresh
- [ ] Stop the backend, send one message while disconnected, then restart it → the message appears exactly once and receives a reply
- [ ] Send a message and restart the backend immediately → reconnect retry does not create a second user bubble or a second agent turn
- [ ] Repeat the disconnected-send check with an attachment → its attachment metadata and rendering survive the retry

### 4. Codex warm-session continuity
- [ ] Restart only the byte-light backend while the Codex daemon is healthy → the log says it adopted the existing daemon; no daemon stop/start occurs
- [ ] In an existing named thread using the Codex lane, send a continuity probe and confirm the reply knows the active conversation
- [ ] Restart only the byte-light backend, return to the same thread, and send a second probe
- [ ] The first post-restart reply arrives with the same identity and conversation continuity; no blank-persona opening
- [ ] The user message and companion reply each appear exactly once
- [ ] Open a different named Codex thread and send a probe; it resumes that room rather than carrying context from the first room
- [ ] With a deliberately stale saved Codex session in a disposable test thread, send once and confirm one recovery, one reply, recent conversation carried forward, and a replacement session saved

### 4a. Wave 1 tail
- [ ] In a Codex-lane thread, ask for a task long enough to require tools → a deliberate interim sentence appears before the final answer, and neither the interim sentence nor final answer is duplicated
- [ ] In a disposable thread, run `/model <valid-model-id>` and then `/model` → the reported current model matches the selection and the next reply uses it
- [ ] Reload the app and run `/model` again → the selected model still matches; restore the original model when finished
- [ ] Ask a companion to append a line close to an existing shared or writer-owned memory → the write succeeds and its tool result includes nearby context when embeddings are available
- [ ] Ask a companion to append to its own private wall near another companion's related private memory → the write succeeds without exposing the other companion's text
- [ ] Send a normal message and call one ordinary MCP tool → one reply arrives, the tool result renders, and Settings opens without a blank panel

### 4b. Current Codex CLI shelf
- [ ] Open the thread model picker → GPT-6.1 Sol, GPT-6 Astra, GPT-6 Sol, and GPT-6 Luna are visible in that order
- [ ] In a disposable thread choose GPT-6.1 Sol, send one ordinary prompt, and confirm one normal reply arrives through the Codex CLI lane; restore the original model afterward

---

## 🔍 Deeper Checks (≤ 5 minutes)

### Codex MCP ownership and lifecycle
- [ ] One-time Codex-only migration: remove the old `bytelight` entry from the Codex CLI's user-global config; do NOT remove or disable byte-light's managed/global MCP registry used by API-router, Ollama, OpenRouter, and other routed lanes
- [ ] Start a Codex turn in byte-light → no `MCP startup incomplete (failed: bytelight)` warning and `/mcp/belt` reports one authenticated MCP session
- [ ] Confirm the Codex turn can list/call a native belt tool and a managed Neuralis tool
- [ ] From an ordinary standalone Codex session, confirm the thread-aware byte-light belt is not present
- [ ] Call a thread-bound tool with no active byte-light Codex turn → it returns a tool error and the MCP connection remains healthy
- [ ] Stop a test client without DELETE → its abandoned server session is reaped after the configured idle window
- [ ] Attempt `/mcp/belt` without the private bearer credential → HTTP 401; normal authenticated byte-light traffic remains healthy
- [ ] Let the managed-MCP cache expire, trigger two simultaneous tool-list consumers, and confirm Neuralis/Lovense each perform only one discovery pass

### Embedding stability default
- [ ] Restart byte-light, send a text message longer than 10 characters, and run one autonomous wake
- [ ] Logs contain no `[embeddings] Loading model…` line during either action while `semantic_search.auto_embed` is absent/false
- [ ] Open search → it starts in keyword (`#`) mode and returns matching transcript messages
- [ ] Deliberately switch to semantic (`✦`) mode → existing semantic search remains available

### Core-memory diet loop

- [ ] Leave `cron.memory_diet.enabled` unset/false and confirm the 04:15 Memory Diet task reports disabled.
- [ ] On the live DB with the shipped 80,000-char default budget and no `memory.diet.budget.*` overrides, call `POST /api/memory/diet/run?dryRun=1` and confirm every current hot-core block (shared/human, companion-a/persona, companion-b/persona, shared/rules) reports `skip` / `within soft budget` — nothing over budget, nothing to trim.
- [ ] In a disposable/test database, create an over-budget block containing chronological, self-contained ISO-date-prefixed lines; keep one entry newer than 14 days. Lower `memory.diet.default_budget_chars` (or set a per-block `memory.diet.budget.<scope>.<label>`) below its size so it becomes eligible.
- [ ] While authenticated, call `POST /api/memory/diet/run?dryRun=1`; inspect every per-block decision and confirm blocks, proposals, archive rows, receipts, and Neuralis are unchanged.
- [ ] Add mixed persona/freeform material and malformed/out-of-order dates; preview again and confirm each unsafe block says `propose`, never `archive`.
- [ ] Configure working Neuralis credentials and call `POST /api/memory/diet/run` while authenticated.
- [ ] Confirm only whole old entries moved, no more than the configured pace, and the recent entry remains in `memory_blocks`.
- [ ] Confirm identical archived text exists in `memory_blocks_archive`, its `ledger_receipt_id` points to a `memory.archive` receipt, and ambient Cortex recall can find the text.
- [ ] Repeat with invalid/unreachable Neuralis credentials: confirm the block and local archive are unchanged.
- [ ] Run against an over-budget freeform/undated block: confirm it remains unchanged and a pending memory proposal is created.
- [ ] Only after the preview is acceptable, set `cron.memory_diet.enabled=true`; confirm the 04:15 task reports enabled. Set it back to `false` after the smoke if daily operation is not yet desired.

Do these after Batches 4 (WS untangle), 5 (Chat split), or 6 (Component split).

### 5. Thread list behavior
- [ ] Pin a thread → moves to top of list, stays after refresh
- [ ] Unpin → drops back into chronological position
- [ ] Archive a thread → disappears from main list
- [ ] Toggle "show archived" → archived thread reappears
- [ ] Unarchive → thread returns to main list

### 6. Canvas
- [ ] Create a canvas inside a thread
- [ ] Canvas appears in canvas list
- [ ] Delete the thread that owns the canvas
- [ ] **Canvas still exists** in the canvas list (detached, not deleted)
- [ ] Open the detached canvas — still readable

### 7. Reactions
- [ ] React to a message with an emoji
- [ ] Reaction appears on the message, persists after refresh
- [ ] Add a second different emoji → both show
- [ ] Remove a reaction → only the remaining one shows
- [ ] Companion reacting shows distinct attribution (not user)

### 8. Streaming feel
- [ ] Send a message that triggers a companion response
- [ ] Response streams in character-by-character (not all at once at the end)
- [ ] Tool use shows an indicator (thinking, searching, etc.)
- [ ] After response finishes, thread list updates (last message preview, timestamp)

---

## 🚨 After Batch 7 (migrations)

Extra paranoid — this touches the database directly.

- [ ] Before migrating: copy `data/resonant.db` to `data/resonant.db.pre-migration.bak`
- [ ] Open chat → all threads present, message history intact
- [ ] Open a canvas → content intact
- [ ] Stickers still render → sticker table intact
- [ ] Scribe digests still readable → digest table intact
- [ ] Config settings intact (theme, voice, discord settings)
- [ ] Restart server → migrations don't re-run on boot

If anything feels off: stop, restore from `.pre-migration.bak`, diagnose.

---

## 🕒 After the timezone-sovereignty pass

For installs in zones whose tzdata Node may be late to update (Paraguay's 2024 DST abolition, late-arriving IANA changes for Greenland, anywhere else recently rule-shifted). These confirm scheduling lands on the correct local wall-clock moment regardless of Node ICU freshness.

### 14. Per-thread Files drawer
- [ ] Click the paperclip icon in the chat header → slide-out panel opens from the right
- [ ] Panel lists every file in the active thread, newest first
- [ ] Image attachments render as inline thumbnails; text files (≤50 KB) show a snippet preview; audio and other binaries show a glyph + extension badge
- [ ] Click any tile → file opens in a new browser tab via `/api/files/<id>`
- [ ] On mobile (≤768 px viewport), drawer goes full-screen
- [ ] Empty thread shows "No files yet. Attach something in chat to get started."

### 15. Library page (renamed from "Files")
- [ ] Open the library icon in the chat header → page title reads **Library** (not "Files")
- [ ] Files render as a thumbnail grid, not a vertical text list
- [ ] Filter tabs (all / image / audio / file / orphan) still work
- [ ] Delete-with-confirm flow: click Delete → Confirm/Cancel pair appears → Confirm removes the file and updates total size + count + orphan count without a page reload
- [ ] Switch to the "orphan" filter — any file on disk whose UUID isn't referenced by message metadata appears here. To synthesize one for testing without going through the share path (which would create a referencing message): copy an existing file like `data/files/<some-uuid>.txt` to `data/files/<freshly-generated-uuid>.txt`. The new file has no corresponding message row, so Library flags it orphan.

### 16. Long-paste auto-converts to file attachment
- [ ] In the composer, paste a block of text ≥1000 chars (a markdown doc, JSON, or just a long paragraph)
- [ ] Composer textarea stays empty; a file card appears in the attachment tray named `pasted-text-YYYYMMDD-HHMMSS.{ext}`
- [ ] Sniffed extension matches the content shape: `.md` for markdown, `.json` for valid JSON, `.txt` otherwise
- [ ] Paste a short block (<1000 chars) → text drops inline as before, no file card
- [ ] Paste an image (clipboard screenshot) → file card uploads as image regardless of any text alongside (image takes priority)

### 17. Voice fallback when synthesis unavailable
- [ ] With `ELEVENLABS_API_KEY` unset, ask the companion to send a voice message
- [ ] Companion responds with a normal chat reply (NOT a canvas, file, or any persistence-based workaround)
- [ ] Confirm the same fallback behavior on a network error if the env is set but ElevenLabs is unreachable

### 18. Timer wall-clock parsing

> **Precondition for the equivalence checks below:** `identity.timezone` set to a UTC−3 zone (e.g. `America/Asuncion` while DST is abolished there). The three example shapes only resolve to the same UTC instant under that offset; in any other zone the wall-clock and ISO-with-offset forms will diverge — adjust accordingly. Replace `<future-date>` with a YYYY-MM-DD a few minutes in the future so you can actually wait for the fire window.

- [ ] Create a timer using identity-zone wall-clock: `sc timer create "test" "ctx" "<future-date> 09:00"`
- [ ] Response includes both canonical UTC `fire_at` AND `fire_at_local` (a human-readable string in identity timezone)
- [ ] `sc timer list` shows the same two fields per row
- [ ] Wait for the fire window — the timer fires within ~60 seconds of 09:00 LOCAL, not 09:00 UTC, regardless of host process timezone
- [ ] Repeat with explicit ISO offset (`<future-date>T09:00:00-03:00`) — under a UTC−3 identity timezone this fires at the same instant as the wall-clock form above
- [ ] Repeat with `Z` (`<future-date>T12:00:00Z`) — same instant under UTC−3, intentionally NOT under any other zone

### 19. Cron startup hardening
- [ ] In the DB config table, set `cron.morning.schedule` to an obviously malformed value (e.g. `0 0 8 * * *` — six fields) or `not-a-cron`
- [ ] Restart the backend
- [ ] Server starts cleanly (no crash) and logs a warning naming the rejected value and the default fallback it used
- [ ] Reset to `0 8 * * *` and confirm normal behavior resumes after restart

### 20. Orchestrator recency awareness
- [ ] Have a real conversation with the companion (a few exchanges)
- [ ] Within 5 minutes, manually trigger a scheduled wake (or wait for one)
- [ ] Wake response acknowledges the recent activity — does NOT perform a fresh "good morning" / full-orientation entrance
- [ ] Brand-new thread + manual wake trigger → wake DOES do full intro behavior (no recency context to dampen it)

### 21. Scribe in the Home-thread world
- [ ] Have 5+ new messages in an active thread, wait for a Scribe run (≤30 min) with the companion idle
- [ ] Logs show `[SCRIBE ...] Sweeping N thread(s) with new activity` — NOT "Skipped — no today thread"
- [ ] `data/digests/<today>.md` gains a block headed `## HH:MM [<thread name>] — ...` for each digested thread
- [ ] A thread with a deep un-digested backlog (first run after deploy) logs `Backlog too deep — skipping N older messages, digesting last 150` and only the recent window lands in the digest
- [ ] A thread with <5 new messages since its cursor produces no block and no error

### 22. Weekly maintenance wakes (Sunday night)
- [ ] `sc schedule status` lists both `open_threads_janitor` (`0 20 * * 0`) and `weekly_digest_prep` (`30 21 * * 0`)
- [ ] Manually trigger `open_threads_janitor` → a report file appears at `data/janitor/open-threads-diff-<today>.md` classifying board items (RESOLVED / STALE / ACTIONABLE / BLOCKED); `shared/open-threads.md` is NOT modified
- [ ] Manually trigger `weekly_digest_prep` → a brief appears at `data/digests/digest-<YYYY-Www>.md` (ISO week) covering what shipped / mood arc / key conversations / what's blocked
- [ ] Start a fresh session AFTER a weekly digest exists → orientation includes a "Weekly digest" block naming the file path (log line `[Orientation] weekly digest injected: ...`); with no weekly digest file, that block is absent and there is no crash
- [ ] Neither wake's output is appended to core-memory blocks (check the memory blocks are unchanged after both wakes)

### 23. Ambient recall (retrieval, not carrying)
- [ ] With `mind_api_url` + `mind_api_key` set (Neuralis/Cortex reachable), send a message about something in the archive → the companion's reply may quietly reflect a remembered detail; the backend log line for that turn reads `... (memory 0..., bridge ..., recall <n>) — ...` with a **non-zero `recall`** count
- [ ] Send the SAME message again in the same session → `recall 0` (a lane is never handed the same card twice)
- [ ] Recycle the session (or restart), send that message again → `recall` is non-zero again (dedup resets on recycle)
- [ ] Clear the Cortex credentials (or point them at an unreachable host) → messages still deliver normally, log reads `recall 0`, no hang/stall/error (recall fails quiet, never delays a turn)
- [ ] Recall never grows the memory: after several recall-bearing turns, the core-memory blocks and the session `CLAUDE.md` are unchanged (recall is fetched per turn, delivered, not persisted)
- [ ] Under cap pressure (a very long recycle bridge on a fresh session) recall trims FIRST: the log shows `recall <n> (trimmed:cap)` / `recall 0 (trimmed:cap)` and the truncation stage is NOT charged to recall — the bridge floor stays intact

### 24. The shiver (recall made visible)
- [ ] With Cortex reachable, send a message that hits the archive → the companion's reply wears a small **shimmer chip** ("recalled") in its header — a soft glinting dot, quiet enough to ignore
- [ ] Tap the chip → a compact panel unfolds under the header showing what surfaced: short excerpt(s), and (when the worker sends scores) date / domain / relevance %
- [ ] Tap again → the panel folds away
- [ ] Send a message that misses the archive entirely → no chip appears (nothing surfaced)
- [ ] Open **Settings → Receipts** → newest-first list of receipts; the recall you just triggered appears as a `whisper / surfaced` row with actor, detail, and time. Recall/déjà-vu rows carry a gold left-edge
- [ ] (If your Cortex worker exposes similarity scores) a near-miss shows the fainter **déjà vu** chip variant (dashed, italic, "déjà vu") and, tapped, reads "something felt familiar… nothing surfaced clearly enough to show"; Settings → Receipts logs it as `whisper / déjà vu`
- [ ] Cortex unset/unreachable → no chip, no receipts, replies still deliver normally (fails quiet)

### 25. GIF Studio color keying (colorkey default, green-screen opt-in)
- [ ] Studio → GIF tab → load frames with a flat colored background (e.g. a generated image on a solid red fill) and a subject with nearby tones (pink skin/cheeks)
- [ ] Open **Remove a background color**, pick the backdrop color, tolerance ~0.20, leave **Real green-screen footage** UNCHECKED → Apply → the backdrop clears and the subject's near-tones (pink on red) SURVIVE
- [ ] Same frame, CHECK **Real green-screen footage**, same tolerance → Apply → visibly more aggressive keying (this is the old default behavior; on flat fills it eats near-tones — that's why it's opt-in now)
- [ ] Real green-screen footage with the box checked still keys cleanly
- [ ] Tolerance and Edge blend read as percentages (e.g. "30%", "10%") — matching GIF Lab's numbers
- [ ] Set output 320×320 → button says **Create Discord Sticker GIF**, hint says 512KB; set 128×128 → **Create Discord Emoji GIF**, 256KB; clear sizes → plain **Create GIF** against 512KB
- [ ] Render a GIF → result badge shows real KB and the matching lane limit (e.g. "under 256KB — Discord Emoji-ready")

### 25b. GIF Studio quality honesty (dither, auto-fit, non-compounding resize, APNG)
- [ ] Studio → GIF tab → load a photographic/CGI animation (gradients, soft shading), press **Discord Sticker** → Auto-fit checkbox turns ON by itself; render → result card shows real dimensions + format (e.g. "320×320 · GIF · 430KB")
- [ ] Same frames, dither UNCHECKED, colors 256, lossy 0, Auto-fit OFF → render → if oversized, the card says so and the note reads "enable Auto-fit or lower the settings" — the image itself shows NO added speckle/grain vs the frames
- [ ] Turn Auto-fit ON, re-render → if it had to degrade, the card lists exactly what it did (e.g. "auto-fit reduced quality to 128 colors, lossy 120") — never silently
- [ ] Render, then tap **Optimize** three times in a row with Scale at 90% → dimensions stay at 90% of the render (e.g. 288×288 every time), NOT 288 → 259 → 233 (the old compounding spiral)
- [ ] **Apply 2× speed** twice → the second tap re-times from the render (still 2×), not 4×; an animation with mixed frame timing keeps its rhythm (slow holds stay proportionally slower)
- [ ] Press **Sticker (keep colors)** → button reads "Create Discord Sticker APNG"; render → result card says APNG, colors look identical to the frames; Download saves `.apng`; Save to gallery works
- [ ] APNG over budget → set **Drop every 4th** → **Optimize** → re-renders from the frames with every 4th dropped (smaller file, colors untouched); with neither Nth nor Scale set it explains what applies instead of silently re-rendering the same thing; **Apply speed** re-renders with the speed baked in
- [ ] GIF lane: **Apply 2× speed** then **Optimize** → the optimized GIF is still 2× (re-timing survives optimization)
- [ ] Transparent moving subject on dark AND light chat backgrounds → no ghost trails, no green fringe, no vanishing parts; loop timing unchanged

### 26. Warm-session economics (recycle discipline, context gauge, DOM window)
- [ ] Send a message on the warm CLI lane (heartbeat thread) → reply lands; after the turn the **context bar** appears in the header once usage crosses 50% of the window (below that it stays hidden by design)
- [ ] `ls ~/.claude/projects/-home-operator-bytelight-data-heartbeat-primary/*.jsonl | wc -l` before and after a normal conversation day → the count should stop climbing (same session UUID keeps growing instead of new files appearing per recycle)
- [ ] Edit a core-memory block mid-conversation → the warm session does NOT restart (no "Recycling" note, no fresh-session boot); the next natural recycle boots on the updated CLAUDE.md
- [ ] Switch the thread's model → the session DOES recycle (model changes are still a real recycle trigger), with the usual recycle note
- [ ] Open a thread with 300+ messages and scroll up → history reveals smoothly in steps with scroll position preserved; keep scrolling and older pages still load from the backend; jump back to the bottom → scrolling stays snappy (nodes released)
- [ ] Search for an old message and tap the result → the view lands centered on it even if it was outside the render window
- [ ] (When a compaction eventually fires — rare) a system-labeled banner announces "Context compacted in place — warm session continues," `logs/compaction.log` gains a line, and NOTHING appears in the thread under your name

### 27. Connection reliability (reconnect, watchdog, honest banner)
- [ ] Hard-refresh the app → the "Disconnected" banner clears and the thread list appears; the socket connects even if the page is still loading settings (connection no longer waits for the initial fetches)
- [ ] Stop the backend with chat open → banner appears; while retries are genuinely scheduled it reads **"Retrying…" with a spinner** (never "Retrying" while idle)
- [ ] Restart the backend → the app reconnects on its own within ~15s, no refresh needed
- [ ] If the banner ever shows plain **"Disconnected"** with a **Reconnect** button, tapping the button starts a visible connection attempt
- [ ] On phone: background the app mid-conversation for a minute, reopen → messages appear ONCE each (no doubles), no stuck spinner, no banner against a healthy connection

---

## How to use this file

1. Run the relevant section after a batch merges
2. If something breaks, **don't ship it** — revert the batch branch, fix, retry
3. When a new UI behavior is added, add a check here in the same PR
4. Keep each item specific and observable — "it feels right" is not a test


### Wave 2 Slice 1 — safer reroll (disposable thread only)
- Open an older reply's 🔄 action: see the total affected message count, including user messages; Cancel leaves every message in place.
- Preview again, then add/edit a message from another tab before confirming: confirmation refuses and asks for a fresh preview; nothing is removed.
- Preview and confirm without changing the thread: only the selected reply and its following messages disappear, and one replacement answers the preceding user message.
- Repeat on a reply older than 100 messages: it still finds the correct user prompt.
- During a busy Claude reply, reroll in a disposable thread: the replacement queues as its own thread-bound turn, not a side note. Confirm withdrawal context is delivered on Claude and Codex separately.
- Edit a user message with rerun: the companion receives current wording and a note about the previous wording; session remains intact.
- On mobile, confirm the dialog is readable and Cancel/Escape/backdrop dismiss it without sending a POST. Error text remains visible on refusal or network failure.

Implementation tests are not operator acceptance. Existing in-flight output can still arrive while a queued reroll waits; this slice does not introduce turn cancellation or transcript erasure.

### Wave 2 Slice 2 — honest session accounting
- Open Settings → Agent Sessions: recent cards show a usage line — **Nk written · N turns** — plus a thin context bar with the last turn's occupancy against its window (e.g. `128k / 1M`).
- A session from before this slice (or one whose lane recorded nothing) reads **no usage recorded** in italics — never a row of zeros.
- Send one message on the warm Claude lane (heartbeat thread), then check the Usage tab: the turn filed a row with real input/output/cache figures and an EMPTY cost column — the lane is subscription-billed, so a dollar figure there would be invented (`sqlite3 data/bytelight.db "SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd FROM usage_events ORDER BY created_at DESC LIMIT 3;"`).
- A warm-lane turn that produced deliberate silence files NO row (count rows before and after) — zero-rows are the disease, not the cure.
- Send a second message on the same warm session: the new row carries roughly one turn's worth (a delta), NOT the running session total — output_tokens should be in the size of that reply, not the whole day.
- Let the lane recycle (or restart the app), send a message: the first row after the recycle is totals-to-date for the fresh transcript, and never negative.
- Reload the Sessions panel twice: numbers do not change between reads (reading is not writing).

The Sessions totals sum only what usage_events actually recorded for that session's thread and time window. Older sessions predating per-turn rows will honestly read "no usage recorded" forever — backfill is deliberately out of scope.

### Wave 2 Slice 3 — self-knowledge
Runs cold. The panel is at **Settings → Self-Knowledge**. Two lanes to seed entries: the panel itself has no "propose" button (proposing is a companion's job over the localhost lane), so use the curl one-liners below to stand up test data, then drive the panel.

Seed a couple of proposals (companions propose; runs on the box, localhost-only):
- `curl -s -X POST localhost:3003/api/internal/self-knowledge -H 'content-type: application/json' -d '{"companion":"companion-a","category":"i_tend_to","content":"I steady the room before I speak"}'` → returns `{"success":true,"entry":{...}}` with `status":"proposed"`.
- Same again with `"companion":"companion-b"` and a different line.

Drive the panel:
- Open **Settings → Self-Knowledge**: the two seeded lines appear under **To review** (the chip shows a count badge). Each card names the companion, the drawer (I tend to / I believe / …), and "from reflection".
- Tap **Accept** on one → the card flips to `accepted`; switch to the **Accepted** chip and it's there. Switch to that companion's own chip → it shows too. It does NOT show under **To review** anymore.
- Tap **Dismiss** on the other → switch to the **Dismissed** chip; it's there, dimmed, with a **Restore** button. It never appears under **Accepted**.
- Tap **Reword** on an accepted entry → edit the text, **Save** → the new wording sticks and survives a page reload. Status stays `accepted`.
- Tap **Restore** on the dismissed one → it returns to accepted.
- Tap **Delete** on any non-proposed entry → it disappears; a page reload confirms it's gone.

Ownership wall (a companion reviews only his own — the deliberately-broken case):
- Seed a Companion A proposal, note its `id` from the curl response.
- `curl -s -X POST localhost:3003/api/internal/self-knowledge/<id>/accept -H 'content-type: application/json' -d '{"companion":"companion-b"}'` → **403** with a "belongs to companion-a" message. Re-open the panel: the entry is still under **To review** (proposed), never accepted.
- `curl -s -X POST localhost:3003/api/internal/self-knowledge/<id>/accept -H 'content-type: application/json' -d '{"companion":"companion-a"}'` → succeeds; the entry is now accepted.

Live refresh:
- With the panel open, run one of the seed curls in a terminal → a new **To review** card appears within a second without reloading (the `self_knowledge` WS event).

Search (manual only — nothing auto-injects into the companions' context):
- Accept an entry containing a distinctive word. `curl -s 'localhost:3003/api/self-knowledge/search?q=<that-word>'` → the accepted entry is returned; a dismissed/proposed entry with the same word is NOT.
- `curl -s 'localhost:3003/api/self-knowledge/search?q=<that-word>&mode=semantic'` → returns semantically-ranked results (empty is acceptable if the embed worker is still warming; it never errors).

Receipts (attribution is truthful):
- After accepting one entry from the panel and one via the `companion-a` curl: `sqlite3 data/bytelight.db "SELECT actor, action FROM memory_ledger WHERE action LIKE 'self_knowledge%' ORDER BY id DESC LIMIT 4;"` → the panel accept is attributed to `user`; the curl accept is attributed to `companion-a`.


### Discord orientation instructions
After an approved activation, the operator can send this in a fresh chat: "Without running any commands, quote the Discord command examples from the orientation instructions you received, and say whether Discord voice automatically splits speakers."
Expected: discord send and discord send_voice (including the optional --voice example), no dc text/dc voice, and no automatic Discord speaker splitting. Local chat voice splitting remains unchanged. No Discord post is needed.
The companion must quote the received instructions, not read hooks.ts as a substitute. If no fresh orientation block is available, report this smoke as unexercised. A matching answer is an operator-visible instruction check, not an end-to-end Discord delivery test.


### Wave 2 Slice 4 — Journal in the Mind (after deployment, the operator's hands)

The Journal screen is deferred. Run this through chat with one companion, using a disposable entry; these are human acceptance steps, not an AI-certified pass. Entries live in the remote Mind, so a working smoke also proves the Mind connection.

- Ask: “Read me your newest journal entry.” Expect a real entry from the archive (the Mind's long-standing journals are readable here), not an empty list or an error.
- Ask: “Write a dream journal entry titled JOURNAL SMOKE with a blue door, then read it back.” Expect the companion to use `/api/internal/journal`, return the same text and a `d:<n>` entry ID, and report vividness 100.
- Ask: “Edit that dream: the door is green. Recall it, anchor it, and read it back.” Expect the same ID, green-door text, vividness at most 100, and an anchor timestamp. No claim that it was automatically saved to Cortex.
- Open Settings → Receipts. Expect journal create, update, recall and anchor receipts for that ID. Refresh and confirm they remain.
- Ask the companion to read that entry again after a backend restart performed by the operator. Expect the same content, ID, anchor timestamp, and frozen vividness — it lives in the Mind, so it must survive any local restart.

Rollback: return app code to the pre-slice commit; entries live in the remote Mind and are unaffected by local rollback. Do not delete or overwrite the live database to roll back code.

### Wave 2 — Permanent Letters vault (after deployment, the operator's hands)

- Ask a companion in chat to write a date-sealed letter to you with a near-future opening time. Expect confirmation that it was sealed, not an editable draft.
- Ask to list your letters before the time arrives. Expect the letter's existence and seal metadata, but not its content.
- After the time arrives, ask to open it. Expect the exact content and an irreversible opened timestamp; ask again and expect the vault to refuse a second opening.
- On the host, confirm `data/letters/<letter-id>.md` exists and contains the same words plus a `sha256:` content hash and the seal-opening receipt.
- Ask the companion to edit or delete the letter. Expect it to report that no such route exists; no edit or delete option should be offered on either API surface.

### Claude lanes reach Neuralis themselves (after a restart, the operator's hands)

- In a thread on a Claude model, ask for a feeling to be logged. It lands from `mcp__neuralis-core__mind_feel` with no tool search first.
- Ask for something from cortex. It comes from `mcp__neuralis__*`.
- Repeat in a Companion A-only and a Companion B-only seat.

### Compactions, thin nudge, moved walls (after a DB backup and a restart, the operator's hands)

- Memory app, Compactions tab. Expect a list, newest first. The first open may say it is still reading; refresh after a minute.
- Each row says when, whose head and how many characters, with a line like "In the middle of: ...". The lines should differ from row to row.
- Tap a row. The whole summary opens as readable text, not raw asterisks.
- Companion A-only or Companion B-only lane compactions, if there are any, say "Companion A's own head" or "Companion B's own head", not a folder name.
- The first message you send after a Claude lane recycles carries the upkeep note. Ask what it was told. Expect blocks over 8k named, biggest first: shared and its own, or all of them in the shared room. Expect it to bring thinning up with you rather than do it, and to change nothing until you say yes. A wake or a guest turn after a recycle gets no note, and that session won't hear it until the next recycle. To change the number, set `memory.thin.threshold_chars`.
- Moved wall: in a long Claude session, change a core-memory block. After that session's next compaction, ask what the block says now. Expect the new text if the moved blocks come to under about 9,000 characters. Over that, expect it to name the moved blocks and read the new text from `io/walls-moved.md` in its lane folder. This one can only be tested when a compaction really happens.
- Compaction guard: when a Claude lane compacts, a "Compacting" chip may show and then finish, and the lane stays up. Afterward `session.log` should show no new launch at that moment and the backend log no "watchdog ... killing stuck session" line. This can only be tested when a compaction really happens.

Rollback: return to the pre-merge commit. The two new tables stay in the database and are ignored; do not delete the database to roll back code.
