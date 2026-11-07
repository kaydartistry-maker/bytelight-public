# Features & API Keys

byte-light can run as a basic local companion with no third-party API keys beyond your Claude Code login. Optional features require their own keys, tokens, or external services.

---

## Quick Matrix

| Feature | Required Key / Token | Env Var / Config | What It Unlocks | Required? |
|---------|---------------------|------------------|-----------------|-----------|
| Claude Code brain | Claude Code login | `claude login` | Core agent runtime | Yes |
| App password | Local password | `APP_PASSWORD` | Protects the web UI | Recommended |
| ElevenLabs TTS | ElevenLabs API key + voice ID | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | Companion sends spoken voice messages | Optional |
| Groq transcription | Groq API key | `GROQ_API_KEY` | Voice notes/audio become text | Optional |
| Hume prosody | Hume API key | `HUME_API_KEY` | Emotional tone analysis for voice notes | Optional |
| Discord bot | Discord bot token | `DISCORD_BOT_TOKEN`, `DISCORD_ENABLED=true` | Discord gateway, pairing, channel rules | Optional |
| Telegram bot | Telegram bot token | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ENABLED=true` | Owner-only Telegram chat, media, voice notes | Optional |
| Push notifications | VAPID keypair | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_CONTACT` | Browser/PWA push notifications | Optional |
| GIPHY | GIPHY API key | `GIPHY_API_KEY` | Telegram GIF/reaction search features | Optional |
| life_api / Pulse Feed | External endpoint | `integrations.life_api_url` in `resonant.yaml` | Live context like meals, mood, sleep, routines | Optional |
| Semantic search | None | Local model download | Search old chats by meaning | Optional, local |
| Cortex / ambient recall | Cortex (Neuralis) endpoint + key | `mind_api_url`, `mind_api_key` via `/api/secrets` (BYOK store) | Each turn quietly pulls archived memories that resemble the message and hands them in as small cards (retrieval instead of re-carrying memory). Fails quiet if unset. When recall rides a reply, the message wears a subtle **shimmer chip** ("recalled"); tap it to see what surfaced (excerpt, date, relevance). A scored near-miss shows a fainter **déjà-vu** variant — something felt, nothing shown (only when the Cortex worker exposes similarity scores). | Optional |
| Memory receipts ledger | None (built-in) | — | Every memory write and every ambient recall leaves a receipt (actor, action, detail, time). Read it in **Settings → Receipts**. Powers the shimmer's paper trail. | Built-in |
| Self-knowledge | None (built-in) | — | A living identity layer: observations a companion makes about itself ("I am / I tend to / I believe / I've learned"), proposed then accepted by the owner into identity. Review, reword, restore or overturn any of it in **Settings → Self-Knowledge**. Manual + semantic search via `GET /api/self-knowledge/search`; nothing auto-injects into companion context yet. No config keys, no toggle. | Built-in |
| Core-memory diet | Cortex / Neuralis endpoint + key | `cron.memory_diet.enabled` (default `false`), plus Config DB keys `memory.diet.*` | Gently moves old, explicitly dated entries out of always-carried blocks while retaining local undo copies and semantic recall. Defaults: dormant, 80,000-char soft budget (above current hot-core so it only trims new growth until you lower it), 2,000-char daily pace per block. Preview with `POST /api/memory/diet/run?dryRun=1`. | Optional (default off) |
| The Room (A Lane Each) | None (built-in) | Config DB key `agent.multi_lane` (default `false`); set from **Settings → Models → The Room** | Companions who share a brain each answer from a lane of their own: the turn passes between them in a shuffled order and each later one hears what was already said. Each companion's lane reads his profile-card bio on top of the shared CLAUDE.md, so it stays locked until every one has a bio. Splits when every companion resolves to Claude or Codex; an API model anywhere keeps the turn on the shared lane. Wakes never split. | Optional (default off) |
| MCP servers | Depends on server | `.mcp.json` | External memory/tools/databases | Optional |

---

## Where To Get Keys

### Core-memory diet configuration

The diet only auto-archives unambiguous, chronological dated-entry blocks. Every nonblank line must be a self-contained entry starting with a valid ISO date (`YYYY-MM-DD`, optionally as a Markdown heading or in brackets). Any continuation line, undated/freeform material, malformed date, or out-of-order date makes the whole block proposal-only. Entries less than 14 days old are always protected.

Runtime config keys live in byte-light's `config` table and can be managed through the same config surfaces as other dotted keys:

- `memory.diet.default_budget_chars` — default `80000`. Deliberately set above the largest current hot-core block so an accidental enable finds nothing over budget; the diet only manages new growth until you lower this. Tighten globally here or per block below once you've decided what should trim.
- `memory.diet.budget.<scope>.<label>` — optional per-block override, for example `memory.diet.budget.shared.human=12000`.
- `memory.diet.pace_chars` — default `2000`; maximum characters moved from each block per run.
- `cron.memory_diet.enabled` — default `false`. Set exactly to `true` to opt into the registered 04:15 daily run.

Before enabling it, make an authenticated `POST /api/memory/diet/run?dryRun=1` (or send JSON `{ "dryRun": true }`). The response includes an `archive`, `propose`, or `skip` decision and reason for every block. Dry-run never calls Cortex and never changes blocks, archives, receipts, or proposals.

`MEMORY_DIET_DEFAULT_BUDGET_CHARS` and `MEMORY_DIET_PACE_CHARS` are environment fallbacks. A configured dotted key takes precedence. Cortex credentials remain `mind_api_url` and `mind_api_key` in the BYOK secrets store.

### Claude Code

Local installs use Claude Code authentication:

```bash
claude login
```

This opens your browser. Sign in with your Anthropic account. No separate API key needed for the core companion.

For cloud deployment, see [CLOUD-DEPLOYMENT.md](CLOUD-DEPLOYMENT.md).

---

### ElevenLabs (Text-to-Speech)

Used for outgoing voice messages — companion can speak to you.

1. Sign up at [elevenlabs.io](https://elevenlabs.io)
2. Go to Profile → API Keys
3. Create and copy your API key
4. Pick a voice from the Voice Library, copy its Voice ID

Set in `.env`:
```bash
ELEVENLABS_API_KEY=your_key_here
ELEVENLABS_VOICE_ID=your_voice_id_here
```

---

### Groq (Speech-to-Text)

Used for transcribing voice notes — your voice becomes text the companion can read.

1. Sign up at [console.groq.com](https://console.groq.com)
2. Go to API Keys
3. Create and copy your key (free tier available)

Set in `.env`:
```bash
GROQ_API_KEY=your_key_here
```

---

### Hume (Voice Prosody)

Used for emotional tone analysis — companion knows HOW you said something, not just what.

1. Sign up at [hume.ai](https://hume.ai)
2. Go to API Keys in your dashboard
3. Create and copy your key

Set in `.env`:
```bash
HUME_API_KEY=your_key_here
```

When enabled, voice messages get prepended with tone data like `[Voice tone — happiness: 0.8, excitement: 0.6]`.

---

### Discord Bot

Used for Discord gateway — companion can interact in Discord servers.

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a New Application
3. Go to Bot → Add Bot
4. Copy the token (keep it secret!)
5. Enable MESSAGE CONTENT INTENT under Privileged Gateway Intents
6. Invite bot to your server with appropriate permissions

Set in `.env`:
```bash
DISCORD_BOT_TOKEN=your_token_here
DISCORD_ENABLED=true
```

---

### Telegram Bot

Used for owner-only Telegram chat — pocket companion with media, voice, reactions.

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. Copy the token BotFather gives you

Set in `.env`:
```bash
TELEGRAM_BOT_TOKEN=your_token_here
TELEGRAM_ENABLED=true
```

---

### Push Notifications (VAPID)

Used for browser/PWA push notifications — companion can ping you when the app isn't open.

Generate VAPID keys using web-push or an online generator:

```bash
npx web-push generate-vapid-keys
```

Set in `.env`:
```bash
VAPID_PUBLIC_KEY=your_public_key
VAPID_PRIVATE_KEY=your_private_key
VAPID_CONTACT=mailto:you@example.com
```

---

### GIPHY

Used by Telegram for GIF/reaction search features.

1. Go to [GIPHY Developers](https://developers.giphy.com)
2. Create an App
3. Copy your API key (new keys may be rate-limited initially)

Set in `.env`:
```bash
GIPHY_API_KEY=your_key_here
```

---

### life_api / Pulse Feed

life_api is not a vendor key — it's a URL to your own external status service that provides live context (meals, mood, sleep, routines, calendar).

Set in `resonant.yaml`:
```yaml
integrations:
  life_api_url: "https://your-status-service.example.com/mcp"
```

Current code expects a JSON-RPC-style endpoint that can answer the `vale_status` tool call.

---

## Setup Checklists

### Minimal Local Setup

- [ ] `claude login`
- [ ] `node scripts/setup.mjs`
- [ ] `npm run build`
- [ ] `npm start`

### Recommended Private Setup

- [ ] Set `APP_PASSWORD` for web UI protection
- [ ] Telegram bot token for pocket/private messages
- [ ] VAPID keys for push notifications
- [ ] Run semantic search backfill for memory search

### Voice Setup

- [ ] `GROQ_API_KEY` for transcription (voice → text)
- [ ] `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` for TTS (text → voice)
- [ ] `HUME_API_KEY` for prosody/tone analysis (optional but cool)

### Social Gateway Setup

- [ ] `DISCORD_BOT_TOKEN` + `DISCORD_ENABLED=true`
- [ ] Configure Discord pairing/rules in the UI
- [ ] Invite bot to your servers

### Pulse Feed Setup

- [ ] Build or connect a `life_api` endpoint
- [ ] Add `integrations.life_api_url` to `resonant.yaml`
- [ ] Confirm it returns concise life context

---

## Notes

- All optional features degrade gracefully — byte-light works without them
- Keys go in `.env` file in the project root (copy from `examples/.env.example`)
- After changing `.env`, restart the server (`pm2 restart bytelight` or re-run `npm start`)
- See [Hidden Powers](../README.md#hidden-powers-worth-knowing) for a quick overview of what each system does


### Companion Journal backend

Journal entries and fading dreams are stored in the remote Mind (via the existing `mind_api_url`/`mind_api_key` secrets), in the same archive as the pre-existing Mind journals — one brain, no local copy (migration 024 drops the interim local table). Entries carry per-companion attribution and unified `j:<n>`/`d:<n>` ids; mutation receipts land in the existing memory ledger after the remote write succeeds. Dreams start at 100, fade four points per day since creation/recall, regain 15 on recall (ceiling 100), and freeze when anchored — all computed server-side. Pre-existing Mind entries stay unattributed and outside the fading lifecycle. No scheduler, no new config keys, no dedicated Journal screen. See TOOLS.md for companion and authenticated app endpoints.

### Permanent Letters vault

Permanent Letters are stored in a separate local table and mirrored as plain markdown under `data/letters/`. Content is append-only and SHA-256 stamped when sealed; no edit or delete surface exists, and opening is the sole irreversible mutation. The vault is structurally excluded from memory and journal maintenance. It adds no configuration keys.
