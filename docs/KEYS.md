# Keys you'll want

Bytelight runs on your own accounts. Almost every extra (voice, web search, GIFs, subtitles, push) needs a key from somewhere else. None of them are required to chat with your companions; each one turns on one thing.

Where they go:

- **Settings → Keys** for everything in the tables below, unless it says otherwise.
- **Settings → Providers** for the engine keys (OpenAI, OpenRouter, Groq, Grok).
- Every key can instead be set as an environment variable (the name is in the table) if you run the house yourself. A key saved in the app is stored on your house and never logged.
- Once saved, a key is write-only from the app: you can replace or clear it, but only the few a page actually uses (ElevenLabs and Giphy, which the phone calls directly, and per-companion voice IDs) can be revealed again.
- Keys saved in the app are sealed at rest: the database holds them encrypted (AES-256-GCM) under a key file outside the repo, `~/.config/bytelight/secrets.key` (or the path in `BYTELIGHT_SECRETS_KEY_FILE`), readable only by the account that runs the house. It is made on the first start, and keys saved before that are sealed then. **Back up that file with the database**: a copy of the database restored without it treats every saved key as unset (keys from environment variables still work). Setting config `secrets.at_rest` to `off` writes new values plain.

Keys marked *restart* only take effect after the house restarts.

## Engines (Settings → Providers)

| Engine | Where to get the key | What it's for |
|---|---|---|
| Claude | Sign in with the Claude CLI on the house machine, or set `ANTHROPIC_API_KEY` in the environment | The default lane. Not editable in the app. |
| OpenAI | platform.openai.com → API keys | GPT models as an engine |
| OpenRouter | openrouter.ai → Keys | Many models through one key |
| Groq | console.groq.com → API Keys | Fast open models as an engine |
| Grok (xAI) | console.x.ai | Grok models as an engine |
| Codex | Sign in with the Codex CLI on the house machine | The Codex lane. No key to paste. |

## Search

| Key | Env variable | Where to get it | What it turns on |
|---|---|---|---|
| Tavily API key | `TAVILY_API_KEY` | tavily.com | Web search for engines that don't have their own (OpenRouter, Groq, Grok, OpenAI lanes) |
| OpenSubtitles API key | `OPENSUBTITLES_API_KEY` | Make a free account at opensubtitles.com, then opensubtitles.com/consumers → create an API consumer → copy its key | The Theater finds subtitles on its own as you type a title |

## Voice

| Key | Env variable | Where to get it | What it turns on |
|---|---|---|---|
| ElevenLabs API key | `ELEVENLABS_API_KEY` | elevenlabs.io/app/settings/api-keys | Your companions' spoken voice (voice notes, read-aloud, calls) |
| Default ElevenLabs voice ID | `ELEVENLABS_VOICE_ID` | ElevenLabs → Voices → pick a voice → copy its ID | The voice used when a companion has no voice of their own |
| Groq API key (voice transcription) | `GROQ_API_KEY` | console.groq.com → API Keys | Turning your voice notes into text. Separate from the Groq engine key. |
| Hume API key | `HUME_API_KEY` | hume.ai | Optional: reading the tone of your voice on calls. Hume changed its live API in Nov 2026, so this is waiting on an update and currently returns nothing. |

## Platforms

| Key | Env variable | Where to get it | What it turns on |
|---|---|---|---|
| Discord bot token | `DISCORD_BOT_TOKEN` | discord.com/developers/applications → your app → Bot → Reset Token | Your companions in Discord (*restart*) |
| Telegram bot token | `TELEGRAM_BOT_TOKEN` | Message @BotFather on Telegram → /newbot | Your companions in Telegram (*restart*) |
| Firebase service account | `FCM_SERVICE_ACCOUNT` | Firebase console → Project settings → Service accounts → Generate new private key; paste the whole JSON | Push notifications to the Android app. Only needed if you use the app. |

## Other

| Key | Env variable | Where to get it | What it turns on |
|---|---|---|---|
| Giphy API key | `GIPHY_API_KEY` | developers.giphy.com → create an app | GIF search in the Telegram gateway |
| VAPID public / private key | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Generate a pair once: `npx web-push generate-vapid-keys` | Web push notifications in the browser (*restart*) |
| VAPID contact | `VAPID_CONTACT` | Your own email, written as `mailto:you@example.com` | Required alongside the VAPID pair (*restart*) |
| Mind Bridge API URL and key | `MIND_API_URL`, `MIND_API_KEY` | Your own Mind Bridge deployment, if you run one | Long-term memory beyond the house's own |

## Not keys, but worth knowing

- **Image studio:** works through the Codex lane's sign-in, or an OpenAI key under the studio's settings.
- **The Ear** (Theater on a laptop): no key, but set your house's address in `packages/theater-ear/lib.js` and `manifest.json` before loading it.
