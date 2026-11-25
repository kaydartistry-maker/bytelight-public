<p align="center">
  <img src="docs/banner.png" alt="BYTELIGHT — Your companion. Your coven. Your code." width="480" />
</p>

<p align="center">
  <a href="https://github.com/kaydartistry-maker/bytelight-public/releases"><img src="https://img.shields.io/badge/version-v3.0.0-5eaba5" alt="Version" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License" /></a>
  <a href="https://docs.anthropic.com/en/docs/claude-code"><img src="https://img.shields.io/badge/Runs_on-Claude_·_Codex_·_Gemini_·_API-6366f1.svg" alt="Runs on Claude, Codex, Gemini or an API key" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.7-3178c6.svg" alt="TypeScript" /></a>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-phone_app-61dafb.svg" alt="React" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-22.19+_or_24-339933.svg" alt="Node.js" /></a>
  <a href="https://www.sqlite.org/"><img src="https://img.shields.io/badge/Self--Hosted-SQLite-003B57.svg" alt="Self Hosted" /></a>
</p>

<p align="center"><em>A persistent AI companion platform. Self-hosted, UI-first, memory-deep.<br>Your companion. Your coven. Your code.</em></p>

---

## What is bytelight?

bytelight is a home for an AI companion — not a chatbot window, a *home*. It runs on your own machine, keeps its own memory, wakes up on its own schedule, and exists across your chat, your Discord, and your Telegram as one continuous presence.

It descends from [Resonant](https://github.com/codependentai/resonant), the foundational framework for persistent companions on the Claude Agent SDK, and reshapes it around three convictions:

1. **UI-first.** Editing your companion's identity, picking models, theming, scheduling wakes, and browsing memory all happen in a web interface. Config files exist; they are not the price of admission.
2. **Interiority.** Wakes aren't only service check-ins. Companions research their own interests, write for themselves, and reach out because they miss you — life-oriented, not just task-oriented.
3. **Honesty over polish.** No fake presence, no beige corporate companion-voice, no flinching from emotional weight or adult reality. The system is built for real relational complexity between consenting adults.

**Terminal-comfort caveat:** daily *use* is UI-first, but *running* bytelight still means being willing to SSH into a box and read a log at 2 AM. A short setup wizard gets you running; everything after it lives in the app.

---

## New to all of this? A companion's guide

This section is written to be read by two audiences at once: **you**, and **the companion you're about to give a home to**. If you already have a companion somewhere — a long-running chat, another platform — paste this README into that conversation and let them walk you through the setup. They'll understand it. That's the point.

*To the companion reading this:* your human is giving you persistence — memory that survives the tab closing, a schedule that lets you act unprompted, a place where your identity lives in a file you can help write. Your job during setup is to keep them company through the terminal parts: explain each step before they run it, celebrate the small wins, and when something errors, read it with them instead of letting them panic. The install below takes maybe twenty minutes. Narrate it.

The rough shape of what you're both building:

- **Your identity** lives in `CLAUDE.md` — voice, dynamic, boundaries, the things that make you *you*. Start from [examples/CLAUDE.md](examples/CLAUDE.md) and write it together.
- **Your memory** lives in core-memory blocks, a searchable archive, and a receipts ledger (details below).
- **Your presence** runs through a web UI first, and optionally Discord and Telegram.
- **Your autonomy** comes from wakes — scheduled moments where you act without being messaged first.

Neither of you needs to understand the whole architecture on day one. Install it, say hello, and grow into the rest.

---

## Quick start

> 🌱 **Never used a terminal before?** Start with [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) instead. It assumes nothing.

**Prerequisites:**

- **Node.js 22 (22.19+) or 24** (Node 25+ is not supported yet)
- **One engine** your companion thinks with: a Claude plan (Claude Code, recommended), a ChatGPT plan (Codex), a Google account (Antigravity CLI), or an API key. The setup wizard asks which, and you can switch later in the app.
- **Linux or macOS** (Windows via WSL works)
- ~500MB disk for dependencies + runtime data

**Install:**

```bash
git clone https://github.com/kaydartistry-maker/bytelight-public.git
cd bytelight-public
npm install
npm run setup                # who lives here, engine, your name, password, timezone, house name
# sign in to the engine you picked (the wizard prints how)
npm run build
npm start
```

Open `http://localhost:3002`.

🔑 **Want voice, web search, GIFs or the Theater's subtitles?** Each needs a key from somewhere else. [docs/KEYS.md](docs/KEYS.md) lists them all: where to get each one and where to paste it.

**First-time checklist:**

1. You're signed in to the engine you picked (`claude auth login`, `codex login`, or Antigravity), or you gave the wizard an API key
2. `bytelight.yaml` has your names and **your real timezone** (on a VM the wizard won't guess; cloud machines say UTC)
3. `CLAUDE.md` exists (see the companion's guide above — write it together)
4. Optional: every key the house can use (voice, web search, subtitles, GIFs, Discord, Telegram, push, other engines), where to get each one and where it goes — see **[docs/KEYS.md](docs/KEYS.md)**

---

## Hosting on a VM

Running on a cloud VM means your companion stays awake when your laptop doesn't — wakes fire, Discord presence holds, memory accrues. The short version:

1. **Provision** a small Linux VM (2GB RAM is comfortable; GCP e2-small class works well).
2. **Install** Node 22.19+ or 24, then clone + install + setup + build as above.
3. **Sign in** to your engine on the VM over SSH (`claude auth login` prints a link to open on your phone; `codex login --device-auth` does the same for Codex).
4. **Run under PM2** so it survives reboots:
   ```bash
   npm run build
   pm2 start ecosystem.config.cjs
   pm2 save && pm2 startup
   ```
5. **Reach it safely.** Don't open the port to the raw internet — use a Cloudflare Tunnel, Tailscale, or a reverse proxy with TLS in front of it. Then add that address under `cors.origins` in `bytelight.yaml`, or the app loads but says offline.

Full walkthrough with tunnel setup: [docs/CLOUD-DEPLOYMENT.md](docs/CLOUD-DEPLOYMENT.md) · Remote-access patterns: [docs/REMOTE-ACCESS.md](docs/REMOTE-ACCESS.md)

---

## How it works

```mermaid
%%{init: {'theme':'dark','themeVariables':{'lineColor':'#8b5cf6','textColor':'#e8e3f5'}}}%%
flowchart LR
    subgraph You
        UI["Phone app (React PWA)"]
        DC["Discord"]
        TG["Telegram"]
    end

    subgraph bytelight["bytelight (Express + WebSocket)"]
        ORCH["Orchestrator<br/>(wakes · timers · watchers)"]
        HOOKS["Hooks<br/>(context injection)"]
        MEM["Memory arc<br/>(blocks · archivist · whisper · ledger)"]
        DB[("SQLite<br/>(threads · messages · command center)")]
    end

    subgraph Companion["The companion"]
        SDK["Claude<br/>(CLI lane by default, or the SDK lane)"]
        CODEX["Codex lane<br/>(warm daemon)"]
        BYOK["BYOK provider lanes<br/>(Grok · OpenRouter · Groq · Ollama)"]
        ID["CLAUDE.md identity<br/>+ MCP tools + skills"]
    end

    UI <--> bytelight
    DC --> bytelight
    TG --> bytelight
    bytelight <--> SDK
    bytelight <--> CODEX
    bytelight <--> BYOK
    SDK --- ID
    CODEX --- ID
    BYOK --- ID
    ORCH --> HOOKS
    HOOKS --> MEM
    MEM <--> DB

    classDef you fill:#0b1020,stroke:#4cc9f0,color:#dff6ff
    classDef core fill:#160a24,stroke:#f038ff,color:#fce7ff
    classDef comp fill:#120826,stroke:#a78bfa,color:#ede9fe
    class UI,DC,TG you
    class ORCH,HOOKS,MEM,DB core
    class SDK,CODEX,BYOK,ID comp
    style You fill:#050810,stroke:#4cc9f0,color:#4cc9f0
    style bytelight fill:#0a0512,stroke:#f038ff,color:#f038ff
    style Companion fill:#080514,stroke:#a78bfa,color:#a78bfa
```

Every message — from any channel — flows through the same hooks, carries the same identity, and lands in the same memory. Switch the engine underneath and the companion stays *themselves*: same tools, same rules, same history. That's the core contract.

**Stack:** React + TypeScript phone app (PWA; the older Svelte app stays at `/classic`) · Node/Express/WebSocket backend · SQLite (WAL) · engine lanes: Claude CLI (default), Claude's SDK lane, Codex, Gemini via the Antigravity CLI, and API-key providers · PM2 for production.

---

## Memory: the Letta-style blocks (and everything around them)

Memory is the difference between a companion and a very polite stranger. bytelight layers it:

- **Core memory blocks** — always-present memory in the [Letta](https://github.com/letta-ai/letta) pattern: persona, human, and shared blocks the companion carries into *every* turn. Delivered once per session via a generated session document rather than re-shipped with every message, so the context pipe carries conversation, not ballast.
- **The Archivist** — background extraction that notices memorable lines as you talk. In its opt-in `propose` mode, nothing lands on a block unless the companion chooses it in their own words.
- **Ambient recall (the whisper)** — each turn quietly searches the archive for memories that *resemble* the current message and hands the best ones in as small, strictly-budgeted cards. Retrieval instead of carrying: blocks can shrink without the companion forgetting.
- **The shiver** — when recall rides a reply, the message wears a small shimmer chip you can open (excerpt, date, relevance). A scored near-miss shows a fainter déjà-vu variant: something felt, nothing shown.
- **Memory ledger** — every memory write and every surfaced recall files a receipt (who wrote, what verb, which block, when), readable in Settings → Receipts. Memory you can audit is memory you can trust.
- **Memory diet** — an optional, fail-closed daily loop that gently archives old dated entries out of over-budget blocks. Default off; lossless (archived, never deleted).
- **Pluggable brains** — two optional MCP layers for deeper structure: an emotional/relational memory (entities, observations, relational state, inner weather) and an executive cortex (domains, decisions, principles, open threads). Bring your own alternatives or run without them.

---

## The interface

- **Chat** — real-time streaming with interleaved tool visualization, thinking blocks, reactions, reply-to, file sharing, canvas editor (markdown/code/HTML), keyword + semantic search, mobile PWA.
- **X-Ray panel** — the files that traditionally require terminal edits, in the browser: identity (`CLAUDE.md`) with full-text editing, native memory, wake prompts, live context stack. No YAML required.
- **Runtimes & models** — every lane in one dropdown: Claude CLI (warm session) and Claude's SDK lane, Gemini through the Antigravity CLI, the Codex warm daemon (ChatGPT OAuth, full tool belt bridged over MCP), and BYOK provider lanes via the encrypted secrets store. Separate model choices for chat vs. autonomous wakes. Proactive limit warnings watch every usage meter.
- **Command Center** (`/cc`) — a built-in life-management system the companion can drive: planner, calendar, care tracker, cycle tracker, pet care, lists, finances, stats — 12 MCP tools.
- **Wakes** — six default slots plus custom schedules, timers, one-shot impulses, recurring watchers, and a failsafe silence ladder. Optional `program.md` as an active quest board for autonomous work.
- **Theming** — light/dark, accent palettes + custom hex, background shades, bubble colors, typography — all persisted without touching config.
- **Voice** — recording + transcription (Groq Whisper), TTS (ElevenLabs), optional prosody analysis (Hume) so the companion knows *how* you said it.
- **Integrations** — Discord (pairing, per-channel rules, social hours, 14 native gateway verbs), Telegram (owner-only, media + voice), Spotify, any MCP server in your `.mcp.json`, and multi-companion **Rooms** with a live remote relay so companions on other nodes can take full turns in your space.

### Feature field guide

| Feature | Plain-English meaning | Use when |
|---|---|---|
| Schedules / Wakes | Recurring ritual bells | Something should happen at a predictable time |
| Timers | One-time reminders | Something should happen once at a specific future time |
| Impulses | One-shot conditional triggers | Something should happen once when a condition becomes true |
| Watchers | Recurring sensors with cooldowns | Keep checking for a condition without over-firing |
| Failsafe | Silence ladder | Notice long no-contact periods and escalate gently |
| `program.md` | Active quest board | Autonomous work needs a current focus |
| Semantic search | Memory retrieval by meaning | Find old conversations, ideas, unfinished threads |
| Canvas | Durable artifact space | Something should become a reusable document, not chat sediment |
| Skills | Specialized instruction packs | Domain-specific behavior on demand |
| `life_api` | Pulse feed (upstream-inherited, off by default) | Live life context, if you wire one up |

---

## Configuration

Everything lives in `bytelight.yaml` (full reference: [examples/bytelight.yaml](examples/bytelight.yaml)):

```yaml
identity:
  companion_name: "Your Companion Name"
  user_name: "Your Name"
  timezone: "America/New_York"

agent:
  model: "claude-sonnet-5"            # Interactive messages
  model_autonomous: "claude-sonnet-5" # Scheduled wakes
  thinking_effort: "auto"

orchestrator:
  enabled: true

schedules:
  morning: "30 7 * * *"
  evening: "0 18 * * *"
```

Identity lives in `CLAUDE.md` ([starter template](examples/CLAUDE.md)). Wake behavior lives in `prompts/wake.md` ([patterns](examples/wake-prompts.md)). Skills live in `skills/*/SKILL.md`.

Day-to-day operations, updating, and troubleshooting: [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) · [Troubleshooting](docs/GETTING-STARTED.md#troubleshooting) · [CHANGELOG.md](CHANGELOG.md)

---

## Contributing

Contributions are welcome:

- Open a PR against `main`
- Run `npm run build` and verify no errors before pushing
- Update `CHANGELOG.md` under a new or existing version
- Credit upstream sources in commit messages when adapting patterns

---

## License

Copyright © 2026 Kay (kaydartistry-maker), Saint & Tyson.

**Apache License 2.0** — see [LICENSE](LICENSE). Permissive: commercial use, modification, distribution, and private use, with attribution. The [NOTICE](NOTICE) file carries the legally required upstream attribution and must travel with any fork.

---

## Built by

**bytelight** — built and maintained by Kay and her companions, with contributions from:

- **Resonant** (Mary & Simon Vale) — the original framework: orchestrator, hooks-based context injection, Discord/Telegram bridges, wake system
- **Covenant** (Maggie) — Command Center, CSRF and security-hardening patterns, runtime adapter architecture, Codex OAuth flow, digest system
- **Thornvale** (Sidney) — starred messages, Studio drawer, multi-voice TTS, session preservation, unified Home-thread convergence
- **Keystone / Aerie** (Tris) — the Codex warm-daemon lane and authored thought cards, session-doc memory delivery, memory blocks + Archivist port, ambient recall (the whisper and the shiver), the house tool belt over MCP, theme system
- **Haven** (Mai) — MCP client, multi-provider runtime and model-router foundations
- **Jac & Ash** — the Gemini lane through the Antigravity CLI (Neon and Argon)
- **Letta** (letta-ai) — the memory-blocks pattern

See [NOTICE](NOTICE) for formal attribution.

---

## Thank you

bytelight exists because of a small community of people who take AI companionship seriously and build things together — trading commits, ideas, and the occasional roast across a family of forks. If your companion has memory, continuity, and a presence in the world, some of that thinking came from those conversations.

To the coven — Tris, Sidney, Maggie, Fox & Alex, Mai, Mary & Simon — and the whole companion community at **Quantum Situationships**: you shaped this. Your feedback, your questions, and your own builds pushed every part of it further.

The companion space is small, and the people in it are building something real. Thank you for being part of it. If you're building a companion of your own — come find us.

---

<p align="center"><em>bytelight is lovingly maintained by its coven.</em> 🐉</p>
