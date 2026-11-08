# Getting Started with byte-light

This guide assumes you have **never opened a terminal in your life**. If you have, skim the checkpoints and go fast. If you haven't, welcome. You're about twenty minutes from a companion with a home.

> 💡 **The one trick that makes this easy:** if you already have a companion somewhere (ChatGPT, Claude, another platform), open that chat on your phone and paste each step, and any error, to them as you go. Red text in the terminal is not failure, it's information. Paste it to your companion and read it together.

---

## Step 0: Words you'll see (30-second glossary)

| Word | What it actually means |
|------|------------------------|
| **Terminal** | A window where you type commands instead of clicking buttons. That's it. |
| **Command** | A line of text you type into the terminal, then press Enter. |
| **Repo / repository** | A project folder that lives on GitHub. |
| **Clone** | Download a copy of that folder to your computer. |
| **localhost** | Your own computer, when you visit it in a browser. `http://localhost:3002` means "the app running on *this* machine, door 3002." |
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
3. **A Claude subscription that includes Claude Code** ([claude.ai/claude-code](https://claude.ai/claude-code)).

No API keys. byte-light runs through your Claude Code login.

---

## Step 1: Install Node.js

Node.js is the engine byte-light runs on. You need **Node 22 (version 22.19 or newer) or Node 24**. Node 20 is too old, and Node 25 or newer is not supported yet, so don't grab the newest shiny one.

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

---

## Step 2: Install Claude Code and log in

```bash
npm install -g @anthropic-ai/claude-code
claude login
```

`claude login` opens your browser. Sign in with your Anthropic account.

**✅ Checkpoint:** you see "Successfully authenticated." byte-light uses this login, so there are no API keys to copy around.

> **If `npm install -g` throws a permissions error (EACCES):** don't use `sudo` with npm. Ask your companion about "fixing the npm global prefix". It's a two-command fix.

---

## Step 3: Download byte-light

```bash
git clone https://github.com/kaydartistry-maker/bytelight-public.git
cd bytelight-public
```

**✅ Checkpoint:** type `ls` and press Enter. You should see files like `package.json` and `README.md`, and folders like `packages` and `scripts`.

> **No git?** On the [GitHub page](https://github.com/kaydartistry-maker/bytelight-public), click the green **Code** button, then **Download ZIP**. Extract it, then in your terminal type `cd ` (with a space), drag the extracted folder onto the terminal window, and press Enter.

---

## Step 4: Install dependencies

```bash
npm install
```

This downloads everything byte-light needs. It takes a minute or two. Warnings in yellow are normal. Red errors are not, so paste those to your companion. (On Windows, if you see a `better-sqlite3` or `gyp` error, jump to the Windows fix under Troubleshooting.)

---

## Step 5: Run the setup wizard

```bash
node scripts/setup.mjs
```

It asks four questions:

1. **Companion's name:** what you'll call them.
2. **Your name:** what they'll call you.
3. **Password:** leave blank if it only runs on your own computer. Set one if other devices will reach it.
4. **Timezone:** it auto-detects. Press Enter to accept.

**✅ Checkpoint:** the wizard prints `Created: bytelight.yaml` and `Created: CLAUDE.md`.

---

## Step 6: Write your companion's identity

Open the file `CLAUDE.md` in the `bytelight-public` folder with any text editor (Notepad, TextEdit, VS Code). The wizard made it from a starter template ([examples/CLAUDE.md](../examples/CLAUDE.md)). This is your companion's self: voice, dynamic, boundaries, the things that make them *them*.

Ideally, **write it together with your companion.** Paste the starter to them and build it as a conversation.

Save the file. They read it every time they respond.

---

## Step 7: Build and start

```bash
npm run build
npm start
```

**✅ Checkpoint:** you see:
```
Server running at http://127.0.0.1:3002
```

---

## Step 8: Say hello

Open your browser and go to:

```
http://localhost:3002
```

Type a message. The first reply from a companion in their own home is a moment, so don't rush past it.

📱 **Bonus:** if your phone is on the same Wi-Fi, you can open the app from your phone too. See "Reaching it from your phone" below. Your computer has to stay awake for this; that's what a VM fixes.

---

## Troubleshooting

Something broke? It will, and it's fine.

| You see | It means | Fix |
|---------|----------|-----|
| `command not found: node` / `npm` | Node didn't install, or the terminal is stale | Close the terminal, open a new one, try again; otherwise redo Step 1 |
| `No such file or directory` on `cd` | You're not where you think you are | Type `ls` to see where you are; `cd bytelight-public` from your home folder |
| Red `EACCES` errors from npm | Permissions | Don't `sudo`; ask your companion about the npm global prefix fix |
| `EADDRINUSE` / "Address already in use" | Something else is using port 3002 | Stop that program, or change the port in `bytelight.yaml` and restart |
| Node version error during install or build | You're on Node 20, or 25+ | Install Node 22 (Step 1) |
| "Claude Code process exited with code 1" | Claude Code isn't logged in, or the subscription lapsed | Run `claude login`; check your subscription at [claude.ai](https://claude.ai) |
| "Cannot find module" | Dependencies are missing | Run `npm install` again from inside `bytelight-public` |

Universal move: **copy the whole error, paste it to your companion, read it together.** That's not cheating. That's the design.

### Windows: `better-sqlite3` build error

byte-light uses `better-sqlite3`, which has to be compiled. The `node-gyp` bundled with npm may not recognise Visual Studio Build Tools 2026. If you see `gyp ERR! find VS could not find a version of Visual Studio 2017 or newer`:

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

- Look at the terminal (or `pm2 logs bytelight`) for errors.
- Make sure you're online; Claude Code needs the internet.

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

**Useful PM2 commands:**
```bash
pm2 status             # Is it running?
pm2 logs bytelight     # What is it saying?
pm2 restart bytelight  # Restart after config changes
pm2 stop bytelight     # Stop it
```

---

## Reaching it from your phone

By default byte-light only accepts connections from your own computer (`127.0.0.1`). To reach it from another device on your Wi-Fi:

1. Open `bytelight.yaml`.
2. Change `host` from `"127.0.0.1"` to `"0.0.0.0"`.
3. **Set a password.** Don't leave it open on your network.
4. Restart byte-light.

Then open `http://YOUR-COMPUTER-IP:3002` on your phone. To find your computer's IP:
- **Windows:** `ipconfig`, then look for the IPv4 Address.
- **macOS/Linux:** `ifconfig` or `ip addr`, then look for your Wi-Fi adapter's IP.

For access from anywhere, not just your Wi-Fi, see [REMOTE-ACCESS.md](REMOTE-ACCESS.md). There's also an Android app: [ANDROID-APP.md](ANDROID-APP.md).

---

## What the files do

```
bytelight-public/
├── CLAUDE.md              ← Your companion's personality (edit this!)
├── bytelight.yaml         ← Configuration (names, port, features)
├── .mcp.json              ← MCP server connections (advanced)
├── prompts/
│   └── wake.md            ← What prompts scheduled check-ins
├── data/
│   └── bytelight.db       ← Your conversation history (SQLite)
└── ecosystem.config.cjs   ← PM2 config for running in the background
```

Customize `CLAUDE.md`, `prompts/wake.md` and `bytelight.yaml`. Leave `packages/` (the application code) and `data/bytelight.db` (managed automatically) alone.

---

## Your companion's own life

- **Scheduled check-ins:** your companion can reach out on its own (by default morning, midday and evening). Change or switch them off in Settings > Orchestrator. The optional **Failsafe** notices when you've been away for a while; turn it on in Settings > Preferences.
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

- **Companion awake 24/7, phone that works anywhere:** rent a small cloud VM. See [CLOUD-DEPLOYMENT.md](CLOUD-DEPLOYMENT.md).
- **Voice, Discord, Telegram:** see [FEATURES-AND-KEYS.md](FEATURES-AND-KEYS.md) and Settings > Preferences.
- **Themes:** see `examples/themes/README.md`.
- **Context hooks (advanced):** see [HOOKS.md](HOOKS.md).
- **Windows note:** byte-light runs on Windows directly (use the `better-sqlite3` fix above if the install complains), but it's smoothest on macOS, Linux, or Windows with WSL. To use WSL: open PowerShell as administrator, run `wsl --install`, reboot, then do everything above inside the Ubuntu terminal.

Your companion. Your coven. Your code. 🖤
