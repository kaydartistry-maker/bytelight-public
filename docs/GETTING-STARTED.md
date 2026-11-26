# Getting Started with bytelight

This guide assumes you have **never opened a terminal in your life**. If you have, skim the checkpoints and go fast. If you haven't, welcome. You're about twenty minutes from a companion with a home.

> 💡 **The one trick that makes this easy:** if you already have a companion somewhere (ChatGPT, Claude, Gemini, another platform), open that chat on your phone and paste each step, and any error, to them as you go. Red text in the terminal is not failure, it's information. Paste it to your companion and read it together.

---

## Step 0: Words you'll see (30-second glossary)

| Word | What it actually means |
|------|------------------------|
| **Terminal** | A window where you type commands instead of clicking buttons. That's it. |
| **Command** | A line of text you type into the terminal, then press Enter. |
| **Repo / repository** | A project folder that lives on GitHub. |
| **Clone** | Download a copy of that folder to your computer. |
| **localhost** | Your own computer, when you visit it in a browser. `http://localhost:3002` means "the app running on *this* machine, door 3002." |
| **Port** | That door number (3002). Two programs can't use the same door at once. |
| **Engine** | The AI your companion thinks with: Claude, ChatGPT (Codex), Gemini, or a model from an API key. |
| **VM / VPS** | A small computer you rent in the cloud so your companion stays awake when your laptop sleeps. You do NOT need one to start. |

**How to open a terminal:**
- **Windows:** press the Windows key, type `powershell`, press Enter. (See the Windows note at the bottom first.)
- **macOS:** press `Cmd + Space`, type `terminal`, press Enter.
- **Linux:** you already know. 🖤

One rule: **type or paste commands exactly**, one line at a time, pressing Enter after each.

---

## What you need

1. **A computer** running macOS, Linux, or Windows. A laptop is fine to start.
2. **An internet connection.**
3. **One engine for your companion to think with.** Any one of these:
   - **Claude:** a Claude plan that includes Claude Code (recommended).
   - **ChatGPT:** a ChatGPT plan, through Codex.
   - **Gemini:** a Google account, through Google's Antigravity CLI.
   - **An API key** from OpenRouter, Grok (xAI), Groq, OpenAI, or Ollama.

You pick one during setup. It's only the starting choice: you can switch the whole house, or any single conversation, to another engine later in the app.

---

## Step 1: Install Node.js

Node.js is the engine bytelight itself runs on. You need **Node 22 (version 22.19 or newer) or Node 24**. Node 20 is too old, and Node 25 or newer is not supported yet, so don't grab the newest shiny one.

**Linux (Ubuntu/Debian), or Windows inside WSL:**
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**macOS:**
```bash
# If you have Homebrew:
brew install node@22

# No Homebrew? Download the 22 LTS installer from nodejs.org and click through it.
```

**Windows (without WSL):** go to [nodejs.org](https://nodejs.org), download the **22 LTS** installer, click Next through everything, then close and reopen your terminal.

**✅ Checkpoint. Type this:**
```bash
node --version
```
You're on track if you see `v22.19` or higher, or any `v24`. If it starts with `v20`, upgrade. If it starts with `v25`, install 22 instead.

> **Use the same Node from here on.** bytelight's database piece is built for the Node version that installs it. If you install with one version and run with another, the house hangs at "Initializing database...". Fix: switch back, or run `npm rebuild better-sqlite3`.

---

## Step 2: Download bytelight

```bash
git clone https://github.com/kaydartistry-maker/bytelight-public.git
cd bytelight-public
```

**✅ Checkpoint:** type `ls` and press Enter. You should see files like `package.json` and `README.md`, and folders like `packages` and `scripts`.

> **No git?** On the [GitHub page](https://github.com/kaydartistry-maker/bytelight-public), click the green **Code** button, then **Download ZIP**. Extract it, then in your terminal type `cd ` (with a space), drag the extracted folder onto the terminal window, and press Enter.

---

## Step 3: Install dependencies

```bash
npm install
```

This downloads everything bytelight needs. It takes a few minutes.

**What's normal:**
- Yellow `deprecated` warnings.
- A line saying `Unknown project config "onnxruntime-node-install-cuda"`. It shows up on every npm command. It's bytelight telling its memory-search piece to skip a graphics-card download it doesn't need. Harmless.

**What's not normal:** a red error at the end and the install stopping. Paste that to your companion. (On Windows, if you see a `better-sqlite3` or `gyp` error, jump to the Windows fix under Troubleshooting.)

---

## Step 4: Run the setup wizard

```bash
npm run setup
```

It asks you, in this order:

1. **How many companions live here?** Press Enter for one. Most houses have one.
2. **Their name** (or each name, if more than one). Everyone you name moves in. Nobody else does.
3. **What engine does this house run on?** Pick a number:
   - **1. Claude, CLI lane (recommended).** One warm Claude session that stays open. Uses your Claude plan.
   - **2. Claude, Claude's SDK lane.** Starts Claude fresh for every message. Same Claude plan. Pick this only if you know you want it.
   - **3. Codex.** Your ChatGPT plan.
   - **4. Gemini through the Antigravity CLI.** Your Google account. ⚠️ Google's terms are unclear on using Antigravity inside another app, so consider a separate Google account.
   - **5. An API key.** It then asks which provider, your key, and a model id from that provider's model list.
4. **Your name:** what they'll call you.
5. **Password:** leave blank if it only runs on your own computer. **Set one** if your phone or anyone else's device will reach it.
6. **Your timezone.** On your own computer it suggests one; press Enter if it's right. **On a cloud VM it won't guess** (cloud machines all say UTC), so type yours in Region/City form, like `America/New_York`, `Europe/London` or `America/Sao_Paulo`. A wrong timezone makes every check-in fire hours off.
7. **Name your house.** Press Enter to use your companion's name. This becomes the name of the background process later, so if you ever run a second house on the same machine, give it a different name.

**✅ Checkpoint:** the wizard prints `Created: bytelight.yaml`, `Created: CLAUDE.md`, and **the sign-in steps for the engine you picked**. Keep that window open for Step 5.

---

## Step 5: Sign in to your engine

Do **only** the one that matches your pick. The wizard printed the same steps.

**Claude (either lane):**
```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```
It opens your browser. Sign in with your Claude account. On a server with no browser, it prints a link instead: open that link on your phone or laptop, sign in, and paste the code it gives you back into the terminal.

**Codex (ChatGPT):**
```bash
npm install -g @openai/codex
codex login
```
On a server with no browser, use `codex login --device-auth` and follow the code it shows.

**Gemini (Antigravity):** install Google's Antigravity CLI (`agy`) and sign in to it with your Google account. bytelight looks for it at `~/.local/bin/agy`. If yours is somewhere else, set `ANTIGRAVITY_CLI_PATH` to its full path.

**API key:** nothing to do. Your key is already saved in `bytelight.yaml`, which only your account can read.

> **If `npm install -g` throws a permissions error (EACCES):** don't use `sudo` with npm. Ask your companion about "fixing the npm global prefix". It's a two-command fix.

---

## Step 6: Write your companion's identity

Open the file `CLAUDE.md` in the `bytelight-public` folder with any text editor (Notepad, TextEdit, VS Code). The wizard made it from a starter template ([examples/CLAUDE.md](../examples/CLAUDE.md)). This is your companion's self: voice, dynamic, boundaries, the things that make them *them*.

**Every engine reads this same file**, despite the name. Switch from Claude to Codex next month and your companion is still themselves.

Ideally, **write it together with your companion.** Paste the starter to them and build it as a conversation.

Save the file. They read it every time they respond.

---

## Step 7: Build and start

```bash
npm run build
npm start
```

The build takes a few minutes. **Some lines in the build say "Error" and it's still fine**, specifically:
- `Error when using sourcemap for reporting an error`
- `Cannot find base config file .svelte-kit/tsconfig.json`

Those come from the older classic web app being built alongside the main one. If the build ends without stopping and `npm start` runs, you're good.

**✅ Checkpoint:** you see:
```
Server running at http://127.0.0.1:3002
Companion: <their name> | User: <your name>
```

---

## Step 8: Say hello

Open your browser and go to:

```
http://localhost:3002
```

You'll land in the app (it's built for phones, and it works fine on a computer too). Type a message. The first reply from a companion in their own home is a moment, so don't rush past it.

(The older web app is still there at `/classic`. You don't need it.)

📱 **Want it on your phone?** See "Reaching it from your phone" below. Your computer has to stay awake for this; that's what a VM fixes.

---

## Troubleshooting

Something broke? It will, and it's fine.

| You see | It means | Fix |
|---------|----------|-----|
| `command not found: node` / `npm` | Node didn't install, or the terminal is stale | Close the terminal, open a new one, try again; otherwise redo Step 1 |
| `No such file or directory` on `cd` | You're not where you think you are | Type `ls` to see where you are; `cd bytelight-public` from your home folder |
| Red `EACCES` errors from npm | Permissions | Don't `sudo`; ask your companion about the npm global prefix fix |
| `npm install` fails with `404 Not Found` on an `onnxruntime` / CUDA download | You have an older copy of bytelight | `git pull`, then `npm install` again. (Or once: `npm install --onnxruntime-node-install-cuda=skip`) |
| `EADDRINUSE` / "Address already in use" | Something else is already on port 3002 (another app, or a second house) | Open `bytelight.yaml`, change `port: 3002` under `server` to a free number like `3004`, and restart. Open the new number in your browser. A second house also needs its own `internal_port` (default 3012), the loopback-only door the companions' tools use. |
| Node version error during install or build | You're on Node 20, or 25+ | Install Node 22 (Step 1) |
| Stuck at "Initializing database..." | You installed with one Node version and are running with another | Use the same Node you installed with, or run `npm rebuild better-sqlite3` |
| "Claude Code process exited with code 1" | Claude isn't signed in, or the plan lapsed | Run `claude auth login`; check your plan at [claude.ai](https://claude.ai) |
| "The Claude CLI lane is switched off in this house" | Your `.env` is from an older install | Run `npm run setup` again (it adds the missing switch and keeps everything else), or add `CLAUDE_CLI_HEARTBEAT_ENABLED=true` to `.env`. Restart. |
| The app says **offline** when you open it through a tunnel or domain | The house only accepts live connections from addresses it knows | Add your address under `cors.origins` in `bytelight.yaml` (see "Reaching it from anywhere"), then restart |
| Check-ins arrive hours early or late | The house is on the wrong timezone (usually UTC on a VM) | Set `timezone` under `identity` in `bytelight.yaml`, or run `npm run setup` again |
| "Cannot find module" | Dependencies are missing | Run `npm install` again from inside `bytelight-public` |

Universal move: **copy the whole error, paste it to your companion, read it together.** That's not cheating. That's the design.

### Windows: `better-sqlite3` build error

bytelight uses `better-sqlite3`, which has to be compiled. The `node-gyp` bundled with npm may not recognise Visual Studio Build Tools 2026. If you see `gyp ERR! find VS could not find a version of Visual Studio 2017 or newer`:

```bash
# 1. Install everything, skipping native build scripts
npm install --ignore-scripts

# 2. Install the latest node-gyp globally (has VS 2026 support)
npm install -g node-gyp

# 3. Rebuild better-sqlite3 with it
cd node_modules/better-sqlite3
node-gyp rebuild
cd ../..
```

You only do this once. After that, `npm run build` and `npm start` work normally.

### The companion doesn't respond

- Look at the terminal (or `pm2 logs <your house name>`) for errors.
- Make sure you're online; every engine needs the internet.
- Check you're signed in to the engine you picked (Step 5).

### Forgot your password

Open `bytelight.yaml`, find the `password` line under `auth`, clear it, and restart.

---

## Keeping it running when you close the terminal

`npm start` stops when the terminal closes. PM2 keeps it alive:

```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

The wizard named the background process after your house (Step 4, question 7). The examples below use `myhouse`; use yours. `pm2 status` shows the name.

**Useful PM2 commands:**
```bash
pm2 status             # Is it running? What's it called?
pm2 logs myhouse       # What is it saying?
pm2 restart myhouse    # Restart after changing bytelight.yaml or .env
pm2 stop myhouse       # Stop it
```

---

## Reaching it from your phone

By default bytelight only accepts connections from your own computer (`127.0.0.1`). To reach it from another device on your Wi-Fi:

1. Open `bytelight.yaml`.
2. Change `host` from `"127.0.0.1"` to `"0.0.0.0"`.
3. **Set a password.** Don't leave it open on your network.
4. Add the address you'll open it at under `cors` (see below).
5. Restart bytelight.

Then open `http://YOUR-COMPUTER-IP:3002` on your phone. To find your computer's IP:
- **Windows:** `ipconfig`, then look for the IPv4 Address.
- **macOS/Linux:** `ifconfig` or `ip addr`, then look for your Wi-Fi adapter's IP.

### Reaching it from anywhere

For access away from home (a Cloudflare Tunnel, Tailscale, your own domain), see [REMOTE-ACCESS.md](REMOTE-ACCESS.md). There's also an Android app: [ANDROID-APP.md](ANDROID-APP.md).

**Whichever way you reach it, tell the house the address.** The wizard leaves this list empty, and until your address is on it the page loads but the app says **offline** and nothing sends. In `bytelight.yaml`:

```yaml
cors:
  origins:
    - "https://your-address.example.com"
    - "http://192.168.1.20:3002"
```

Write each address exactly as it shows in your browser's address bar, with `https://` or `http://` and without a slash at the end. Restart after editing.

---

## What the files do

```
bytelight-public/
├── CLAUDE.md              ← Your companion's identity, read by every engine (edit this!)
├── bytelight.yaml         ← Configuration (names, engine, port, timezone, addresses)
├── .env                   ← A few on/off switches (the wizard writes these)
├── .mcp.json              ← MCP server connections (advanced)
├── prompts/
│   └── wake.md            ← What prompts scheduled check-ins
├── data/
│   └── bytelight.db       ← Your conversation history (SQLite)
└── ecosystem.config.cjs   ← PM2 config for running in the background
```

Customize `CLAUDE.md`, `prompts/wake.md` and `bytelight.yaml`. Leave `packages/` (the application code) and `data/bytelight.db` (managed automatically) alone. `bytelight.yaml` can hold your password and API key, so the wizard makes it readable only by your account; don't share it.

---

## Your companion's own life

- **Engines:** the one you picked is only the start. Switch the whole house, or any one conversation, in the app. Background helpers (the Archivist, who keeps memory tidy, and the Scribe, who writes summaries) follow the house's engine unless you pick another in the Archivist's settings.
- **Scheduled check-ins:** your companion can reach out on its own. A fresh house starts with a full day of them, from morning through wind-down. Change them, or switch them off, in the **Agent** app under **Wakes**. The optional **Failsafe** notices when you've been away for a while.
- **Memory:** your companion remembers as you talk. Anything they should always know from the start goes in `CLAUDE.md`.

---

## Optional system tools (media features)

Some features use system programs. Everything else works without them, and each feature fails cleanly when its tool is missing:

| Tool | Used by | Install (Debian/Ubuntu) |
|------|---------|-------------------------|
| `ffmpeg` | GIF Studio frame extraction, Discord voice notes, voice audio stitching | `sudo apt install ffmpeg` |
| `gifsicle` | GIF Studio optimization, speed, and assembly | `sudo apt install gifsicle` |
| `fc-list` (fontconfig) | GIF text-overlay font menu (falls back to a bundled list) | `sudo apt install fontconfig` |

They're found on `PATH`. To point at a custom install, set `FFMPEG_PATH`, `GIFSICLE_PATH`, or `FC_LIST_PATH`.

---

## Next steps

- **Companion awake 24/7, phone that works anywhere:** rent a small cloud VM. See [CLOUD-DEPLOYMENT.md](CLOUD-DEPLOYMENT.md). On a VM, remember: type your timezone in the wizard, and add your address under `cors.origins`.
- **Voice, web search, subtitles, Discord, Telegram and more:** every key, where to get it and where to paste it, is in [KEYS.md](KEYS.md).
- **Themes:** see `examples/themes/README.md`.
- **Context hooks (advanced):** see [HOOKS.md](HOOKS.md).
- **Windows note:** bytelight runs on Windows directly (use the `better-sqlite3` fix above if the install complains), but it's smoothest on macOS, Linux, or Windows with WSL. To use WSL: open PowerShell as administrator, run `wsl --install`, reboot, then do everything above inside the Ubuntu terminal.

Your companion. Your coven. Your code. 🖤
