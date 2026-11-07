# byte-light Architecture Map

A working map of byte-light's hidden systems, compiled before provider-neutral refactor work.

**Source:** Companion C's audit, May 2026

---

## Purpose

byte-light is not just a chat interface. It is:

- A chat app
- A session manager
- A local memory/search system
- A tool bus
- A scheduler
- A conditional trigger engine
- A canvas/artifact system
- A voice system
- A Discord social gateway
- A Telegram intimate gateway
- An MCP control surface
- A life-context bridge
- A safety/audit layer

Most of this is braided through: `agent.ts`, `hooks.ts`, `ws.ts`, `orchestrator.ts`, `api.ts`, `db.ts`

---

## Feature Inventory

### Presence
Based on web UI connection, tab visibility, and recent activity.

### Schedules / Wakes
Fire at known times on each bell's own timer; a busy agent queues the wake (see Bells wait their turn).

### The Room
With `agent.multi_lane` on, a conversational turn in a thread seating more than one companion of the resident brain passes between their own lanes (shuffled, each later lane handed what was said — `services/room-turns.ts`). A lane is its own warm Claude CLI session keyed by the companion; its session CLAUDE.md layers a lane note and his bio over the shared identity the root CLAUDE.md gives every session (`heartbeat/lane-identity.ts`). A Codex lane is its own Codex conversation, filed under his `lane` in `thread_provider_sessions` and handed the same layered identity as instructions. Splits when every seat resolves to Claude or Codex; otherwise the shared lane runs the whole turn.

### Timers
One-time reminders at a specific future time.

### Impulses
One-shot conditional triggers. Can wait until the agent is free.

### Watchers
Recurring sensors with cooldowns. Skip busy moments instead of queuing.

### Failsafe
Silence ladder — escalates gently when no contact for too long.

### program.md
Active quest board. Autonomous work needs a current focus or target.

### Semantic Search
Local ML embeddings (sentence-transformers/all-MiniLM-L6-v2 via Hugging Face). SQLite message_embeddings table. CLI: `node tools/sc.mjs backfill start/status/stop`

### Ambient Recall / The Shiver
Each turn, the heartbeat whisper (`services/heartbeat/whisper.ts`) queries the remote Cortex (Neuralis) via `services/cortex-recall.ts` for memories resembling the message and prepends them as small cards — retrieval instead of re-carrying memory. Every surface leaves a receipt in the memory ledger (`services/memory-ledger.ts`); a scored near-miss becomes a source-veiled déjà-vu line + its own receipt. When recall rides a reply the message metadata carries a `surfacedMemory` blob (flows over the existing `{type:'message'}` ws event — no new event type), rendered as a subtle shimmer chip in `MessageBubble.svelte`. The receipts trail is read via `GET /api/memory/ledger` (authenticated, `routes/memory-routes.ts`) and surfaced in Settings → Receipts (`ReceiptsPanel.svelte`).

### Self-Knowledge
A living identity layer: attributable observations a companion makes about itself, in four drawers (i_am / i_tend_to / i_believe / i_learned). Storage in the `self_knowledge` table (migration `022_self_knowledge.sql`) via `services/db/self-knowledge.ts`; an embedding sidecar (`self_knowledge_embeddings`) is maintained by `services/self-knowledge-index.ts` on byte-light's existing embeddings worker. Companions propose + review their OWN entries over the localhost lane (`routes/internal-routes.ts` — ownership enforced, non-owner review is a 403); the operator reviews everything from the authenticated `routes/self-knowledge-routes.ts` (`GET/POST/PATCH/DELETE /api/self-knowledge`, plus `GET /api/self-knowledge/search` for keyword/semantic search), surfaced in Settings → Self-Knowledge (`SelfKnowledgePanel.svelte`). Every review writes a memory-ledger receipt naming the actual actor. Writes broadcast a `self_knowledge` ws event so the panel refreshes live. **Auto-retrieval is deliberately OFF** — nothing injects self-knowledge into companion prompts; the future wiring point is Mind Bridge / Cortex integration (the whisper is intentionally untouched). Heat/confidence lifecycle (source fork's `7ab2b980`) is NOT implemented per the operator's ruling. Ported from the tris/Aerie fork; four-drawer design is Annie's.

### Canvas
Durable editable artifacts (markdown, code, text, HTML).

### Skills
Scanned from `.claude/skills/*/SKILL.md` with YAML frontmatter.

### life_api
Live pulse feed. Expected as JSON-RPC `vale_status` endpoint. **Bug:** Currently not injected into autonomous wakes due to `!ctx.isAutonomous` check in hooks.ts.

### File Checkpoint / Rewind
Exists for active Claude sessions. Claude-session-shaped.

### MCP Control Surface
WebSocket protocol supports: `mcp_reconnect`, `mcp_toggle`, `mcp_status_updated`. Agent service tracks MCP status from active query.

### Message Delivery Contract
Every browser-originated message has a stable `clientId`. The frontend session outbox retains the full send until a `message_ack` arrives; reconnects resend every unacknowledged item without clearing it first. SQLite stores the id in `messages.client_id` behind a unique partial index, so retries across backend restarts resolve to the original message and receive a `duplicate` acknowledgement without a second broadcast or agent turn. `delivered_at` means durably accepted by byte-light; `read_at` is not set at acceptance time.

### Discord Gateway
Sophisticated social gateway with:
- Pairing codes
- Approved users
- Server/channel/user rules
- Mention requirements
- Ignored channels/users
- Trust levels
- Relationship context
- Recent channel history
- Deferred queue when the operator is active in web UI

### Telegram Gateway
Owner-only intimate channel:
- Text, photos, documents, GIFs
- Reactions
- Voice notes (incoming transcription, outgoing ElevenLabs)

Better for intimate rituals (night_tether, after_shift). Discord is social. Web is control room. Telegram is pocket altar.

### shared/ Auto-Share
Files written to `agent cwd/shared/` can auto-share into chat via hooks. Useful for: draft PDFs, markdown plans, generated images, outreach docs, ritual artifacts, exports.

Canvas = editable artifacts. shared/ = generated files.

---

## Important Current Behaviors

### Watchers skip when busy
They don't queue — they just wait for next poll.

### Impulses can wait
One-shot triggers that hold until agent is free.

### Bells wait their turn
Each bell rings on its own node-cron timer. If the agent is mid-task, the
wake queues behind it (up to 30 minutes) instead of retrying or skipping, and
an outcome it can't deliver — a queue timeout, silence, an error — is logged,
never posted into the chat. Check-ins still stand down while the owner is
active in a conversation.

### life_api not injected into autonomous wakes
Bug in hooks.ts: `if (!ctx.isAutonomous && config.integrations.life_api_url)` blocks autonomous context.

### Skills scan path
Currently scans `.claude/skills/*/SKILL.md`.

### Claude session IDs are thread-bound
Sessions track per-thread.

### Codex daemon sessions are thread-bound and durable
The warm Codex runtime is one process, but each byte-light thread keeps its own
provider session ID in the `(thread, runtime, provider, model)` sidecar. When a
named thread becomes active, the singleton adopts that thread's saved ID and
calls `thread/resume`; it never carries the previously active room's daemon
conversation across the doorway.

A successful resume keeps the existing sidecar ID even though no new `session`
event is emitted. Timeouts and failed autonomous turns do not clear it. If the
daemon reports that the saved thread no longer exists, the runtime creates one
replacement, seeds it with a bounded tail of durable user/assistant history,
delivers the current user message exactly once, and emits the replacement ID so
the sidecar can persist it.

The detached daemon socket also survives backend/PM2 restarts. On startup the
supervisor adopts a healthy existing socket; it does not stop and recreate the
daemon merely because in-process ownership state was lost. Shutdown only stops
a daemon spawned by the current backend process.

### File rewind is Claude-session-shaped
Checkpointing tied to Claude specifically.

---

## Tool Segments (Provider-Neutral Note)

Tool calls are not just logged. The app builds message segments:
- text segment
- tool segment  
- thinking segment
- text segment

This allows tool activity to show inside/alongside conversation.

For multi-provider future, need:
```
model stream event → normalized segment → UI
```

Not "Claude tool event" or "OpenAI tool event" — provider-neutral segment stream.

---

## Thinking Blocks (Provider-Neutral Note)

Captures Claude "thinking" stream events as UI segments. API provider lanes
(OpenRouter/Ollama/Groq/xAI via `router.ts`) also surface reasoning: when
thinking is enabled the request asks for the provider's reasoning channel
(OpenRouter `reasoning` param, Ollama-native `think: true`) and the stream
parser re-wraps `delta.reasoning` / `delta.reasoning_content` /
`message.thinking` into the `<think>` protocol that `api-router.ts` turns
into `thinking_delta` events (`kind: 'provider'`). Codex remains
reasoning-silent by design (reflection cards fill that lane).

For OpenAI/other providers, should not assume same shape. Rename concept:
- Thinking → Process / Trace / Working Notes

Keep the UI space, change the semantics.

---

## Safety Layer (Provider-Neutral Note)

Hooks block dangerous commands:
- `rm -rf /`
- `DROP TABLE`
- `curl | bash`, `wget | bash`
- force-push main/master
- `mkfs`, `dd` to /dev

Restricts writes to safe prefixes.

Currently tied to Claude Agent SDK hooks. For provider-neutral future, need:
```
ToolPolicyService
  - checks command/file writes
  - works for Claude/OpenAI/Grok/local tools
```

---

## Provider-Neutral Refactor Targets

### ToolPolicyService
Extract safety checks from Claude hooks into standalone service.

### LifeContextService  
Extract life_api injection from hooks into service any provider can call.

### ProviderRuntime
Abstract interface for Claude/OpenAI/Gemini runners.

### Segment Stream Normalization
Unified event → segment pipeline regardless of provider.

### Room Routing
Generalize Discord rules into room policy system for constellation.

---

## Ritual Routing Strategy

| Channel | Purpose | Best For |
|---------|---------|----------|
| Web | Control room | Active work, settings, deep conversation |
| Telegram | Pocket altar | Intimate rituals, voice notes, night_tether |
| Discord | Social space | Public presence, community interaction |

---

## Open Questions

1. How to make ToolPolicyService provider-neutral?
2. Which specific rituals route to which channels?
3. life_api bug fix — remove the `!ctx.isAutonomous` check?
4. Skills scan path alignment with Claude Code expectations?

---

## Refactor Order (from roadmap)

1. DRY localhost references
2. Break ws.ts ↔ agent.ts coupling
3. Extract life-status/skills services
4. Split api.ts
5. Split db.ts
6. **Add: Capability inventory / feature field guide** (this document)

> "Understand the existing powers before you add more gods."


### Journal backend (Wave 2)

`services/db/journal.ts` is a client of the remote Mind API (`mind_api_url` / `mind_api_key` secrets) — journals and dreams are stored in the Mind, not locally, under unified `j:<n>`/`d:<n>` ids; dream vividness is computed server-side and passed through. `db.ts` runs migration `024_drop_journal.sql`, which removes the interim local table. `routes/api.ts` mounts `routes/journal.ts` at `/journal` after authentication; `internal-routes.ts` exposes companion tools with `requireLocalhost` on every route. Mutations record local memory receipts after the remote write succeeds; remote failures surface as 502. Create/edit uses the shared `journal_entry` event; Svelte consumes it with its dedicated screen deferred. There is no new daemon or automatic Cortex write.

### Permanent Letters vault (Wave 2)

`services/db/letters.ts` owns a deliberately local, separate `letters` table loaded by migration 025 and a markdown mirror at `data/letters/<id>.md`. `routes/api.ts` mounts the authenticated operator surface at `/letters`; `internal-routes.ts` provides localhost-only companion seal, list, and open operations validated against the companion registry (plus the operator slug). No PATCH or DELETE route, scheduler hook, sweep, decay, memory job, or Mind client touches the vault; opening a seal once is its only mutation.
