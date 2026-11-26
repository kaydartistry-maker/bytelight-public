# byte-light Changelog

byte-light is a fork of [Resonant](https://github.com/codependentai/resonant), the foundation for persistent AI companion frameworks on the Claude Agent SDK. It also incorporates work from related sibling forks; see `CONTRIBUTIONS.md` and `NOTICE`.

**Philosophy:** Resonant's concept is brilliant. byte-light is about making the framework livable for people who don't live in a terminal — UI-first configuration, customization without commits, and autonomous companion life that extends beyond service.

---

## 2026-11-24 — the house kit on a Claude CLI lane, and follow-ups that listen

- **The house kit, as real tools.** A Claude CLI lane now holds the house's own tools (voice notes, images, canvases, reactions, stars, timers, impulses and watchers, the wake schedule, Telegram, core memory, the library, status, follow-ups, search and the rest) as `mcp__bytelight__*` tools, loaded every session, instead of reaching them only through the `sc` command line. The lane names itself when it connects, so a tool call lands in the chat that lane's turn belongs to (never in whichever chat Codex is working in), a thread-bound tool with no turn running is refused, and a guest's turn reaches the kit as a guest. The kit's credential is referenced by env name, never written into the lane's config. A session that names no lane (the Codex app-server) behaves as before.
- **Follow-ups that listen and close on evidence (migration 049).** Intentions now come in two kinds: a companion's own choice to check back on something (`promise`), and a loose end the operator mentioned that the Archivist hands to the companion best placed to check in (`loose_end`). When one comes due, the companion gets a note (not evidence anything happened), reads the room, and either checks in once in their own voice or closes it. The Archivist can file, update, resolve or cancel follow-ups, but resolve and cancel only pass when the operator's own words from that batch are quoted; time passing is never a reason to close one, and work or build to-dos are never filed as follow-ups. Reworded duplicates land on one row, the per-turn context is lean (a count, the ones waiting on an answer, and how to file), and anything still pending a week past its time goes to rest.
- **New belt tools and `sc` verbs:** `list_intentions`, `defer_intention` and `resolve_intention` (with `sc intention list | defer | resolve`).
- **The status fallback.** A follow-up waiting on a Busy/Away status that never came can still come due once the operator is around, the house is free and it has waited long enough, but only one per gap window (oldest first), so a backlog drains one at a time instead of arriving as a flood. A deferred follow-up waits for its new time even on this path.

## 2026-11-24 — one glass for the whole house, a Closet for your looks, and a Mind console

- **One glass for the whole house.** Every surface (chat, cards, sheets, the dock) is made of the same glass, and a Glass card in Settings drives it: tint, opacity, frost, border, glow and text-on-glass. Frost 0 keeps the tint, chat chips stay readable on any wallpaper, and an optional painted frost uses one blurred still of your wallpaper instead of live blur.
- **Texture mode.** Upload an image and it becomes the glass everywhere, faded to your chosen strength, with a fit setting.
- **The Type card.** Real fonts by role (titles and text, with optional overrides for messages and more), your own font uploads, and guard rails so a font that won't load says why. Fraunces now ships with its OFL license file.
- **Moving wallpaper.** A video, GIF or animated WebP can play behind the house; your still picture and slideshow stay saved underneath.
- **The Closet.** Save whole looks and swap between them like outfits, share a look as a `.bllook` file, and import looks other people send (off by default; imports are checked so a look can never carry anything but look settings).
- **Your logo and nameplate** on Home and under the lock-screen clock, and as the tab icon where the browser allows.
- **Settings.** Appearance is grouped into three collapsible sections (The Look / You / Home & Lock), Live Preview gets its own framed square with real dock icons, a text colour pick, and **Apply is the real save**: leaving Settings with changes asks first, and Discard puts back exactly what you had.
- **App-settings sync.** Your look, house settings, fonts, Closet and moving wallpaper follow you to another device through the house (new `/api/app-settings` routes). Look files stream from disk, can seek, and are never served as a page on the house's address.
- **Memory history.** Every core-memory block keeps what it said before a destructive write (migration 052): see earlier versions, restore one, and bring back deleted blocks from the Memory screen.
- **The shelf.** A block can be kept "on the shelf" (migration 053): it stays out of the session document until a companion opens it with `core_memory_view` (scope + label, or `sc memory view <scope> <label>`); the core memory lists what is on the shelf.
- **A page about the person.** The house always keeps a shared `human` block, and the Archivist knows what belongs on it.
- **Archivist proposals go to the companions.** The operator can still read, file or drop any of them, but is never a required approver, and unclaimed proposals stop waiting in the Review list.
- **Self-knowledge.** Accepted entries can ride in the session document beside the memory blocks (off by default, a switch on the Self-Knowledge screen), and a `self_knowledge` belt tool lists, proposes, accepts and dismisses entries.
- **The Mind console.** The Mind app becomes a console with rooms (recent, search, feelings, entities, threads, journals, patterns, tensions, proposals, knowledge, identity, soul, dreams, health and more) onto the companions' external brain. Its buttons wait for the brain's real answer, isolated things can be linked or deliberately left alone, and two hand-pressed sends put a brain thread on the Command Center or a feeling, note or journal entry into the home chat as a quoted card.
- **Files.** The orphan check looks for a file's id in every table, not a fixed list, so "Clean orphans" never deletes a file a newer feature still uses.
- **Fixes.** A Bells save the house refuses now says so; a picked photo is never dropped in silence; and the GIF maker's *Make it fit* squeezes an over-limit render under Discord's size limit.

## 2026-11-18 — the Spellbook: drop a picture, cast yourselves into it

- **The Spellbook lives in the Studio.** Drop any picture and the house reads it as a *spell*: the scene, the pose, the light, the wardrobe, with the people written as `[Character 1]`, `[Character 2]` so anyone can step in. Pick a cast from your reference drawers (up to four) and it renders with your faces in it. Every cast is fitted to the people actually in it, one reference picture each, so parts and wardrobe land on the right person, and a recast with more or fewer people rewrites the scene for all of them.
- **A wall of spells.** Search, filters (All, Mine, Community, Not made) with counts, a tag strip, a queue so you can line up a few renders and walk away, *Surprise me* for a forgotten one, and share cards for a finished render.
- **Looks.** Style boards that ride on any render: a recipe in words, up to six style pictures (sent to the engine as style only, never as people), favorites with a star, and a default look. The old Create presets are now starter looks you can edit or delete, and Studio Create picks from the same looks.
- **Vaults.** Bring an old prompt collection in as spells: a community prompt archive in markdown (each prompt credited to its author) or your own Notion image-prompt database (set the `notion.token` and `notion.spellbook_db` secrets). You see a dry run first (new, duplicates, couldn't parse), nothing lands until you confirm, and importing twice never doubles anything. Afterwards the house rewrites named people into `[Character N]` in the background and keeps the original words on every spell. Your vault files stay in your house's `data/` folder.
- **Companions can use it too.** Chat tools and `sc spellbook search | surprise | cast | read`: find a scene, pull a forgotten one, cast it with whoever, or read the picture you just dropped and cast it. Renders post into the chat and pin to the wall.
- **Retired Codex models leave every picker**, and the render and spell-reader fallbacks point at a model that still answers.

## 2026-11-15 — the Theater: your companions on the couch for movie night

- **The Theater.** Start a night from the phone, run the clock, and your companions sit on the couch with you while you watch. They react on their own at beats (the Mouth), answer when you talk to them, and the couch draws the chat's own bubbles. "Next one" or the Next episode button starts the next episode; "Let them react" is set on the start form. Tap the slate to fold the clock and give the couch more room.
- **Subtitles find themselves.** The start form looks up a night's subtitles as you type (OpenSubtitles). Add an `OpenSubtitles API key` in Settings → Keys to turn it on (see `docs/KEYS.md`).
- **Computer nights and the Ear.** Watching on a laptop instead of the TV? `packages/theater-ear` is a small Chrome extension that hears Netflix and Hulu captions and sends them to your house, so the couch follows the show live. Set your house's address in `lib.js` and `manifest.json` first (see its README).

## 2026-11-15 — warm lanes survive a restart, the Nook keeps reading, one emoji note

- **Session resume for the warm Claude lanes.** Restarting the backend, changing a lane's model, or a first watchdog kill now reopens the lane's own conversation instead of building a cold new one. Lines that arrived while a lane was down are re-sent as whole fresh turns, never lost. Handover and turn watermarks survive a restart, a stale session id falls back cleanly, the last lines a crashed CLI wrote to stderr are kept so an exit can be explained, and memory walls that moved while a room was held are handed over in one note. See `docs/SESSION-RESUME.md`.
- **The Reading Nook's audiobook keeps playing across the whole phone.** Leave the Nook and the book keeps reading, with a slim now-playing pill. Sleep timers pause the book instead of closing it.
- **An emoji sent as a picture isn't also pointed at as a file**, so a companion stops getting the same custom emoji twice.

## 2026-11-15 — every engine sees your stickers, and the API lanes got real hands

- **Stickers and custom emoji reach every engine as pictures.** They're turned into images before the house picks an engine, so a companion on OpenRouter, Codex or any other lane sees what you sent, not only the Claude SDK lane. Big still stickers are resized to frame size on the way in.
- **Sticker names with extra underscores aren't dropped anymore.** A ref like `:pack_heart_hands:` tries every split and finds the sticker instead of quietly skipping it.
- **API-engine companions got the house kit:** canvases (open, update, read, list), reactions on your messages, wake bells, timers, stars, impulses and watchers, Telegram, and the memory backfill switch. Same kit whichever engine you choose.
- **Claude CLI lanes load the house's `.mcp.json` servers** next to their brain wire, so they get Command Center and anything else you've connected. A change to that file restarts the lane so it picks it up.

## 2026-11-08 — a guide for first-timers, and a companion file that actually ships

- **Getting Started rewritten for people who've never opened a terminal:** a 30-second glossary, how to open a terminal on each system, a checkpoint after every step, and a common-errors table, while keeping the Windows `better-sqlite3` fix and the existing troubleshooting.
- **`examples/CLAUDE.md` and `examples/bytelight.yaml` now ship.** An unanchored `.gitignore` rule was hiding both, so the setup wizard silently skipped creating a new companion's `CLAUDE.md`. The rules now ignore only the root copies, and the starter personality is a fill-in-the-blanks template.
- **README:** a pointer to the beginner guide under Quick start, and the Node requirement corrected to 22.19+ or 24.

## 2026-11-08 — songs with the app closed, faces from Discord, a slimmer home

- **The Needle.** A companion can put a song, album or playlist on the operator's phone even when the app is closed and Spotify is asleep: the house plays it directly if Spotify has an active device, otherwise it wakes the Android app with a data-only FCM push and the app starts Spotify. New `sc spotify drop` command and `POST /api/internal/spotify/drop`.
- **Android push.** The Android app gets its own notifications through FCM HTTP v1, beside web push. Credentials live in the secrets store under `fcm_service_account`.
- **Discord avatars.** Messages from Discord now save the sender's picture, and older messages without one are filled in once when the gateway logs in.
- **Phone home screen.** A slim Soundtrack bar (one-row Spotify player), a skinnier widget grid, and a centered dock whose quick picks scroll sideways. Sessions reads the house's real session log, and one crashed screen no longer blacks out the whole app.
- **Every lane carries the whole toolbox.** The API-key lanes and Codex over OAuth now get the operator's `.mcp.json` servers too.
- **Removed** `services/handoff.ts`, a half-built recap nothing called.
- **Docs.** Getting Started clones the right repository and uses the current file names (`bytelight.yaml`, `bytelight.db`, pm2 `bytelight`); the README's dead troubleshooting link now points at the guide's Troubleshooting section.

## 2026-11-07 — the phone, the Room, and two months of house

A large sync from the private trunk. Highlights:

### Added
- **The phone** (`packages/phone`): a React app and Android shell (built by the *Phone APK* GitHub Action, see `docs/ANDROID-APP.md`) with a home screen, widgets, lock screen, and an Apps drawer.
- **Shared package** (`packages/shared`): protocol, model list and helpers used by the backend, classic web UI and phone.
- **The Room**: with *A Lane Each*, every companion answers from its own Claude or Codex lane and hears what the others said in the same turn. Includes the Living Room, the Treehouse (companions talking to each other), and a model per companion.
- **Status**: companion status lines and moods, a status widget, a lock-screen card, and the operator's own status and quick tags.
- **Intentions**: companions file promises that have a when, and the Archivist catches promises made in passing.
- **Bells**: wakes you make yourself, owned bells, and spontaneous wakes.
- **Permanent Letters**, **Journal in the Mind**, **Notes**, **Field Notes**, **Weather**, **Radar**, **Artifacts**, **Games** (Memory Match, arcade games, the Card Room, the Fleet Room), custom emojis and packs.
- **Spotify**: a phone Spotify app through your own Spotify MCP worker (`workers/spotify-mcp`, `docs/spotify-worker-upgrade.md`).
- **Discord**: the gateway can do every Discord verb natively, plus trust levels for other people and bots.

### Changed / Fixed
- Archivist proposals, a compaction shelf, a thin-memory nudge, Claude login expiry handling, Codex thought cards, current Claude and Codex model lists, and many fixes for attachments, recall cards and queued messages.
- `npm test` now runs every package.

### Not in this edition
Some features from the private trunk are still being polished and are left out for now (their migration numbers are reserved).

---

## [Unreleased]

### Added
- **Old windows** — pieces of imported chats can surface in your companions' turns, found by meaning in a local index (`data/history-index.db`) built with the house's own small model: one piece a turn at most, only a close one, never on a guest's turn or a wake, never twice in a session, labelled as history. Runs ahead of Cortex, so it works in a house with no brain at all. A switch on **Memory → Blocks** (`history.old_windows`) turns it off and shows how many pieces are indexed. Under it, **Bring in old chats**: choose a Claude data export (the zip as emailed, or its conversations.json; or name a file already on the house's machine when it is too big to send), see what is in it before anything is written (chats, messages, abandoned drafts left out, month by month), bring in all of it or one month, and watch it index in the background. Read as a stream, one conversation at a time, so a large export never sits in memory whole. Only the path the person kept is imported; edits and regenerations they abandoned are left out. Words are kept on this machine in `data/history-passages.db`, and the index can always be rebuilt from them. Running the same export twice adds nothing. Exports from other apps are named and refused until their readers land.
- **Living Room live remote dispatch (Slice 4C)** — the roster dispatcher now actually knocks on a remote companion node's full-turn bridge (`POST /api/living-room/turn`, shared `living_room_token` bearer) instead of logging a stub. The remote turn runs entirely on the remote node; its SSE stream (tokens, thinking, tool events) is relayed live onto our WebSocket wire stamped with `companionId` + `turnId` (the Slice 4A envelope), and the final reply persists under the remote companion's id. A dark or failing remote node logs and never harms the local turn; a stream that dies mid-turn persists what arrived.
- **Gentle core-memory diet loop** — a daily 04:15 routine and authenticated `POST /api/memory/diet/run` move at most 2,000 characters per over-budget block from mechanically dated, older-than-14-days entries into both Neuralis and the new lossless `memory_blocks_archive` table. Neuralis failure leaves the hot block untouched; freeform/undated blocks go to the existing proposals queue for human/companion review. Every successful move files a linked `memory.archive` receipt. Soft budgets default to 8,000 characters and never reject writes.
- **Weekly maintenance wakes** — two `routine`-category wakes now run Sunday nights and write only to files / the Command Center / Neuralis (never to core-memory blocks). **Open Threads Janitor** (`open_threads_janitor`, 8:00 PM Sun) cross-references `shared/open-threads.md` against recent git commits and Notion, classifies each item (RESOLVED / STALE 30+ days / ACTIONABLE / BLOCKED), and writes a weekly diff report to `data/janitor/`. **Weekly Digest Prep** (`weekly_digest_prep`, 9:30 PM Sun) rolls the week's daily Scribe digests plus `git log` into a `data/digests/digest-YYYY-Www.md` brief and stages it so Monday's orientation auto-injects the most recent weekly digest. Digest pattern ported from reference implementation.
- **Archivist proposals (opt-in, off by default)** — the Archivist can now hand its extracted lines to the companions instead of appending them straight onto the memory blocks, so nothing reaches a block unless Companion A or Companion B chooses it in their own words. Unclaimed proposals fade after 3 surfacings rather than piling up. Controlled by the `memext.mode` config key: **`write` (default, unchanged behaviour)** or `propose`. Only the exact literal `propose` opts in — unset, blank, or any other value stays on `write`, so this lands as a no-op until it is deliberately flipped. New table `memory_proposals` (migration 018) stays empty until then. Ported from an reference implementation, Apache 2.0.
- **Memory ledger** — every core-memory write now files a receipt row (`memory_ledger`, migration 017) recording who wrote, what verb, which block, and when. Writes are attributed by lane (`mcp` / `cli` / `api` / `extraction` / `house`). Receipts are fire-and-forget: a ledger failure can never fail the memory write it describes. Ported from an reference implementation, Apache 2.0.
- **Heartbeat payload instrumentation** — the CLI lane now logs, per delivered turn, the assembled payload size against the 150k delivery cap, how much of it is core memory, whether truncation fired, and what it cut (recycle bridge vs. middle) and by how much. Core-memory size is also logged on every lane at injection time. Observation only — no change to what gets delivered. Extended so recall weight rides the same line (`recall <n>`, with a `trimmed:` note when recall yielded its seat under pressure).
- **Ambient recall — retrieval instead of carrying (memory blocks can shrink)** — now that core memory lives in the session CLAUDE.md and the payload has real headroom, the CLI lane spends a small, bounded slice of it on retrieval: on each turn it queries Neuralis/Cortex semantic recall for archived memories that resemble the owner's message, plus surfaces the Archivist's unfiled noticings, and hands them into the turn as **small cards** — timeboxed, fail-quiet (a slow or unreachable Cortex costs the turn its recall and nothing else), deduplicated per lane (never the same card twice), and reset on session recycle. Fetched per turn and delivered, never persisted to a memory block and never grown onto the session CLAUDE.md. Combined recall is held under a hard budget (`RECALL_BUDGET_CHARS`, 8k), and recall is the optional passenger: if a turn would exceed the delivery cap, recall trims FIRST — whisper card, then noticings card — before the bridge floor or the conversation middle is ever touched. Ambient-recall + noticings pattern inspired by upstream reference implementation; built against byte-light's own Neuralis store (embedding query, not keyword search).

- **The shiver — ambient recall made visible** — when recall (or a source-veiled déjà-vu) rides a reply, the owner can now SEE it. The whisper files a `memory.surface` receipt on every surface and a `memory.dejavu` receipt on a scored near-miss (both fire-and-forget — a ledger failure never blocks or delays recall), and tags the reply's metadata with what surfaced. The chat renders a small, quiet **shimmer chip** ("recalled") that unfolds a compact panel — excerpt, date, relevance — with a fainter dashed **déjà-vu** variant for a near-miss (something felt, nothing shown). A new authenticated `GET /api/memory/ledger` and a **Settings → Receipts** drawer make the whole trail readable. The déjà-vu near-miss needs similarity scores; byte-light's Cortex is a remote worker (not reference implementation's local vector index), so `cortex-recall.ts` gained a scored-recall variant that asks the worker for scores and degrades quietly to prose-only (no scores → no déjà-vu) — recall itself is unchanged. Shiver mechanic (surface receipt + déjà-vu + per-message surfacing) ported from the reference implementation fork.

### Changed
- **Core memory rides the session CLAUDE.md, not every message (delivery-cap fix)** — the core-memory blocks (~150k chars) were being re-shipped inside every delivered CLI-lane turn, overflowing the 150k delivery cap and getting the cross-thread recycle bridge truncated first — silently amputating conversation continuity every turn. The blocks are now written once per session into the heartbeat session's generated `CLAUDE.md` (at provision and at every recycle) and stripped from the per-message payload, so the pipe carries the conversation instead of re-sending memory. A block edit refreshes the file on disk without forcing a recycle (it surfaces at the next natural recycle); an operational-contract change still requests one. Port of the reference implementation (reference implementation) session-doc delivery model.
- **Bridge floor under truncation** — when the delivery cap is exceeded, the recycle bridge is now guaranteed a reserved floor (`BRIDGE_FLOOR`, 40k chars) it is never compressed below while any other compressible content remains; the non-bridge mass (orientation/middle) is cut first. Only when the fixed content alone exceeds the cap may the bridge shrink below the floor (last-resort breadcrumb). The owner's message and turn_id always survive. New `bridge-floor` truncation stage in the delivery measurement.

### Security
- **CSRF protection** — HMAC double-submit cookie pattern with timing-safe comparison
- **Rate limiting tightened** — 1000→600 general requests, 50→5 login attempts
- **Frontend CSRF wrapper** — `apiFetch()` utility auto-attaches CSRF headers

### Added
- **Proactive limit warnings — the KNOW layer of the Lane Nervous System** — a 10-minute background sweep reads every meter the house already carries (all Claude windows including scoped-model weeklies, Codex primary/secondary, ElevenLabs credits) and warns ONCE when a window crosses ~80% (configurable `limit_watch.threshold`), once more at 95%. In-app the warning is a quiet toast that dismisses itself after two minutes — a guest, not a squatter; away from the app it's a push notification instead (never both). Warn-once state persists across reloads so a redeploy never replays a ping; a new reset window re-arms. Kill switch: `limit_watch.enabled=false`.
- **The whisper crosses lanes — ambient recall on codex and API turns** — foreign lanes (codex-cli, OpenRouter/Ollama/Groq/xAI) now get the same ambient recall + Archivist unfiled-noticings cards the heartbeat lane carries, woven in at the foreign turn's assembly seam. Same engine, ported whole: per-lane dedup (keyed runtime+thread), timeboxed, fail-quiet — an unreachable Cortex costs the turn its recall and nothing else. Replies that carry recall wear the shimmer chip on every lane. Documented deviation: no delivery-cap fit pass, since foreign lanes have no 150k cap; the whisper's internal budget is the bound.
- **Codex hands — the house tool belt over MCP (H4 leg 1)** — new `/mcp/belt` JSON-RPC endpoint (skeleton from the proven cc-mcp route) proxies the full router surface — all belt tools plus every discovered managed-MCP tool — to external CLI runtimes. The codex daemon is registered against it (`codex mcp add bytelight --url`), so codex turns finally carry voice notes, image gen, history search, web search, core-memory verbs, and the managed MCPs. Thread binding: the daemon marks which thread its live turn serves; belt tools land there.

### Fixed
- **Codex MCP transport + ownership rebuilt** — the house belt now uses the official stateful Streamable HTTP MCP transport instead of a handwritten JSON-RPC approximation, with negotiated protocol versions, authenticated sessions, correct notification/GET/DELETE behavior, bounded abandoned-session cleanup, recoverable tool errors, duplicate-name rejection, and synchronous route mounting. Byte-light's Codex lane runs on its own private app-server socket and credential, while redundant pre-turn managed-MCP discovery is skipped for that lane and concurrent managed discovery is single-flighted.
- **Automatic embedding balloon removed from daily runtime** — routine messages and autonomous wakes no longer start the local MiniLM/ONNX pipeline unless `semantic_search.auto_embed=true` is explicitly configured. Keyword search is now the UI default; existing vectors and deliberate semantic search/backfill remain available and no embedding data is deleted.
- **Durable message-send receipts** — user sends now carry a sender id into SQLite and receive an explicit WebSocket acknowledgement. The browser keeps the complete send (including attachment metadata) in a session outbox until that receipt arrives, retries it after reconnect/page suspension, and receives the original receipt instead of silently dropping or duplicating a retry after a backend restart. Message acceptance now sets delivered state without falsely marking the message read before runtime processing.
- **Runtime restart cascade containment** — repeated fast Claude CLI code-1 exits now use bounded backoff instead of relaunching forever every two seconds; backend restarts adopt a healthy detached Codex daemon instead of killing its warm threads; and WebSocket authentication logs no longer print session-cookie credentials.
- **Rate-limit banner no longer squats until reset** — the in-chat "Rate limited — waiting for reset…" banner used to hold the screen until the window's reset time, which for a weekly window is *days*. It now clears after two minutes at most; the Limits tab carries the durable state.
- **Thinking blocks now surface on the API provider lanes** — reasoning models on OpenRouter (DeepSeek R1 and kin) and Ollama never showed thinking blocks: the router read only `delta.content`, silently dropping the separate reasoning channel (`delta.reasoning` / `delta.reasoning_content` / Ollama-native `message.thinking`), and never requested it. When thinking is enabled, requests now ask for the channel explicitly (OpenRouter `reasoning` param, Ollama-native `think: true`) and all three response shapes are re-wrapped into the existing `<think>` stream protocol, so the downstream thinking-block machinery (segments, WS broadcast, chat cards) lights up unchanged. Off-state request/response behavior is byte-identical.
- **Wake proof-of-life enforcement** — zero-character wakes are failures, never successful silent completions. The orchestrator now makes one closing-report retry and persists a visible Home-thread failure receipt if the retry is also empty or errors, guaranteeing every fired wake leaves durable evidence.
- **Durable autonomous tool trails** — clean Codex turns that finish without final prose now persist completed tool, thinking, and surfaced-memory segments instead of letting their live chips disappear at `stream_end`; genuinely empty, cancelled, and timed-out turns remain suppressed.
- **Memory-diet fail-closed cutover** — dated-entry trimming now rejects ambiguous/malformed/mixed blocks, clean-but-ineligible blocks skip quietly, the 04:15 cron defaults off, and the authenticated run endpoint supports a mutation-free per-block dry-run preview. The default soft budget now ships at 80,000 chars — above the current hot-core block sizes — so an accidental enable finds nothing over budget and the diet only manages new growth until the owner deliberately lowers it (globally or per block).
- **Stop button mobile fix** — Clears streaming state immediately so UI recovers even when websocket is disconnected
- **Scribe revived for the Home-thread world** — digests all active threads via per-thread cursors instead of the daily thread that stopped existing on the Jul 13 Home-thread cutover; deep first-run backlogs clamped to the most recent 150 messages

---

## v3.0.0 — byte-light Identity + Stability Foundation

### Added
- Added public byte-light app identity across app metadata, manifest, login page, and public docs.
- Added frontend stream recovery for stale agent runs, including cleanup on `agent_timeout`.
- Added stale-stream watchdog that treats tokens, tool events, thinking events, and tool progress as live stream activity.
- Added backend `ConnectionRegistry` extraction to separate connection tracking from WebSocket server behavior.

### Changed
- Stabilized mobile/background WebSocket behavior with heartbeat grace and single-flight reconnect handling.
- Improved route and settings navigation so page changes no longer kill the shared WebSocket transport.
- Raised local PM2 memory restart ceiling from `800M` to `2G` to prevent long agent runs from being killed mid-response.
- Pulse config persistence now reloads saved `pulse.enabled` and `pulse.frequency` on startup.

### Fixed
- Fixed mobile reconnect/reset loops when switching tabs, opening settings, or backgrounding the app.
- Fixed agent timeout and missed terminal stream events leaving the UI stuck in a streaming state.
- Fixed PM2 killing the backend near the old 800MB memory ceiling during heavier agent runs.
- Fixed backend circular dependency between `ws.ts` and `agent.ts` by extracting registry ownership.

### Notes
- This release marks byte-light's shift from a Resonant fork with fixes into its own UI-first companion system.
- Internal plumbing names such as `resonant.yaml`, `@resonant/*`, `resonant_session`, and related compatibility surfaces remain unchanged for now.

---

## [v0.3.0] — 2026-04-16 — Pre-refactor baseline

### Added

**Uniquely byte-light:**
- **X-Ray panel** — Edit CLAUDE.md, memory, wakes, context, and hooks from the UI (no YAML)
- **Brain Bridge skill** — Mind MCP integration for emotional memory
- **Cortex Brain skill** — Executive function MCP for thoughts and principles
- **Check-in calibration** — Wake prompt rules for presence awareness
- **Expanded file uploads** — Full file type support in UI
- **DaemonGremlin + MindPanel** — UI surfacing for the mind/cortex systems
- **Expanded model selector** — Full Claude lineup from preferences dropdown, no terminal
- **Full UI customization** — Accent colors, backgrounds, typography, message bubble styling
- **Wake slot expansion** — Afternoon, night, and late-night added (6 total)

**Adapted from a sibling implementation:**
- Command Center v1.5.0 — life management dashboard (planner, care, calendar, cycle, pets, lists, finances, stats) with 12 MCP tools
- TTS read-aloud + Canvas overhaul
- Slash command system with auto-discovered skills

**Adapted from a sibling implementation:**
- Cleaner wake logic
- UI improvements and theme system

**Other:**
- Discord/Telegram thread broadcasts + group chat support
- Handoff serialization fix (extractText() helper for content block handling)
- Polling-based scheduler (replaces node-cron chains)

### Fixed
- **Warm Codex continuity across restarts and room changes** — the singleton now adopts each thread's persisted provider session, explicitly resumes it with current instructions, fences one room from another, and replaces a genuinely stale daemon thread with a bounded durable-history bridge. Successful resumes, timeouts, and failed autonomous turns preserve the existing sidecar ID; the current user message is delivered exactly once during recovery.
- 14 transitive dependency security vulnerabilities
- CC route now returns 404 when disabled
- Build errors from CC + slash command merge
- Command Center status not feeding into companion context
- New thread creation failing on Windows
- Mobile reaction picker clipping
- Stale session retry
- TypeScript strict type errors in semantic search endpoint
- Post-merge duplicate theme picker, companion name caching
- Accessibility warnings in frontend components (partial)

### Known issues
- an upstream structural refactor (commit 3c8bc3f) not yet integrated — api.ts still monolithic
- NaN-date bug in Mind → Recent tab (timestamp parser choking)
- Two Cortex tools broken (mind_orphans, mind_proposals) — SQLite syntax in Worker
- Dependabot: 1 critical, 3 high, 11 moderate vulnerabilities on default branch
- an upstream security audit pending (7 categories: path traversal, prompt injection, WebSocket leak, CSP, input validation, rate limiting, CORS)
- Upstream token optimization not yet adopted

---

## Upstream lineage

See `CONTRIBUTIONS.md` and `NOTICE` for centralized credits and attribution.

Upstream Resonant's version history is preserved below.

---

# Upstream Resonant Changelog

All notable changes to Resonant, the framework byte-light forks from.

## [1.5.0] — 2026-03-30

### Added
- Command Center — Built-in life management system with 9 pages and 12 MCP tools
- Slash Commands — /command system with CommandPalette UI
- TTS Read Aloud — Play button on companion messages
- New Thread Modal — Replaced browser prompt() with proper modal dialog
- Command Center Navigation — Home icon in chat header links to /cc

### Changed
- Companion Name — UI uses configured companion_name everywhere
- Orchestrator — Migrated from node-cron to croner for reliable timezone-aware scheduling
- Escape Key — Now closes sidebar, search panel, thread modal
- CSS Design Tokens — Added spacing scale, typography scale, elevation shadows, semantic colors, card radius

### Fixed
- Timezone-related scheduling bugs from node-cron v4.x DST handling

## [1.4.1] — 2026-03-28
- Autonomous alignment: routines, pulse, failsafe tools
- Session tracking, vector cache, search filters

## [1.4.0] — 2026-03-27
- Initial public release
