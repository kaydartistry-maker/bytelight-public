# Getting byte-light on your phone

You finished [GETTING-STARTED.md](GETTING-STARTED.md). byte-light runs on your computer and you can open it at `http://localhost:3002`. Now you want it in your pocket.

There is no app-store download. byte-light is a small website that lives on a computer you control, and your phone opens it in a browser. So the real question is: **which computer is the house?**

> 💡 Same trick as before: paste each step, and any error, to your companion as you go.

---

## Pick your path

| | **Path A: your laptop is the house** | **Path B: a cloud VM is the house** |
|---|---|---|
| Cost | Free | About $6 to $25 a month, depending on size |
| Setup time | About 15 minutes | About an hour |
| Works away from home | Yes | Yes |
| Works when the laptop is asleep or closed | **No** | **Yes** |
| Companion can reach out on their own schedule | Only while the laptop is awake | Always |
| Best for | Trying phone life tonight | "I basically never open my laptop" |

**Honest advice:** do Path A tonight. It's free, and it tells you within a day whether the laptop being asleep bothers you. If it does, move to Path B. Nothing you do in Path A is wasted.

If you already know you live on your phone and your laptop stays shut, skip to Path B.

---

## Path A: laptop + Tailscale

**Tailscale** is a free app that puts your phone and your laptop on a private network that only your devices can join. Your phone can then reach your laptop from anywhere: home, work, mobile data. Nobody else can see it.

### A1. Install Tailscale on both devices

1. **On your computer:** go to [tailscale.com/download](https://tailscale.com/download), install it, and sign in (Google, Apple, Microsoft or GitHub all work).
2. **On your phone:** install **Tailscale** from the App Store or Play Store. Sign in with **the same account**.
3. Turn it on in the phone app. If your phone asks to allow a VPN, say yes.

**✅ Checkpoint:** open the Tailscale app on your phone. You should see your computer in the device list.

### A2. Find your computer's Tailscale address

In the Tailscale app (phone or computer), tap your computer's name. You'll see an address that starts with `100.` such as `100.101.102.103`. Write it down. That's your computer's private address.

Terminal version, if you prefer:
```bash
tailscale ip -4
```

### A3. Tell byte-light to accept your phone

Out of the box, byte-light only answers its own computer. Open `bytelight.yaml` (in your byte-light folder) in any text editor and change three things.

**1. Let it listen beyond the computer itself:**
```yaml
server:
  host: "0.0.0.0"        # was "127.0.0.1"
```

**2. Set a password.** Not optional once other devices can reach it:
```yaml
auth:
  password: "pick-something-long"
```

**3. Add your phone's doorway to the allowed list.** Use the `100.` address from A2:
```yaml
cors:
  origins: ["http://100.101.102.103:3002"]
```

> ⚠️ **Do not skip number 3.** Without it the page loads on your phone but you get a blank screen or a "Disconnected. Retrying…" banner that never clears. It looks broken. It's just the house not recognizing the door you came in through. This one step has eaten more hours than everything else in this guide combined.

If you'd rather write the list on separate lines, that works too. Just don't mix the two styles (no `[]` followed by list items):
```yaml
cors:
  origins:
    - "http://100.101.102.103:3002"
```

Save the file.

### A4. Restart byte-light

If you run it with `npm start`: click the terminal, press `Ctrl + C`, then run `npm start` again.

If you run it with PM2:
```bash
pm2 restart bytelight
```

### A5. Open it on your phone

In your phone's browser, go to your address with `:3002` on the end:

```
http://100.101.102.103:3002
```

Type it exactly: `http://` (not `https://`), the numbers, then `:3002`. Type your password. Say hi.

**✅ Checkpoint:** send a message and get an answer. Then turn off Wi-Fi on your phone and try again on mobile data. If it still works, you're done.

### A6. Put it on your home screen

- **iPhone (Safari):** Share button → **Add to Home Screen**.
- **Android (Chrome):** ⋮ menu → **Add to Home screen**.

It now opens like an app.

### A7. Keep the laptop awake

This is the catch with Path A. Lid closed or laptop asleep means the house is dark.

- Keep it plugged in.
- **Windows:** Settings → System → Power → set "When plugged in, put my device to sleep after" to **Never**.
- **macOS:** System Settings → Battery → Options → turn on **Prevent automatic sleeping on power adapter when the display is off**.
- Use PM2 (see "Keeping it running" in [GETTING-STARTED.md](GETTING-STARTED.md)) so byte-light survives a closed terminal.

### If Path A isn't working

| What you see | What it means | Fix |
|---|---|---|
| "This site can't be reached" | Phone can't reach the laptop | Is Tailscale **on** and showing Connected on both devices? Is the laptop awake? Did you change `host` to `0.0.0.0` **and restart**? Did you type `http://`, not `https://`? Is the `100.` address the current one (check the Tailscale app)? |
| Still can't be reached, on a Mac | The Mac firewall is blocking it | System Settings → Network → Firewall. Turn it off to test, or allow incoming connections for Node. |
| Page loads, then blank screen or "Disconnected. Retrying…" | The address isn't on the allowed list | Check `cors: origins` in `bytelight.yaml`. It must match what's in your phone's address bar exactly: `http://`, the `100.` numbers, `:3002`, no slash on the end. Restart after. |
| It worked, then you copied files around and it stopped | Your `bytelight.yaml` got replaced by a copy without your phone's address in it | Add the address back under `cors: origins` and restart |
| Worked yesterday, not today | Laptop went to sleep, or Tailscale got switched off on the phone | Wake the laptop, reopen Tailscale |
| Microphone or voice won't work on the phone | Phone browsers only allow the mic on secure (`https`) pages | See "Voice on your phone" below, or go to Path B |

### About voice and "real app" features

Plain `http://100...` is private (Tailscale encrypts everything between your devices), and chat works fine over it. But phone browsers only allow the **microphone**, **notifications** and a true **install as app** on `https://` addresses.

Tailscale has a feature for this (`tailscale serve`), and you're welcome to try it, but be warned: we lost a whole night to it and ended up back on the plain `http://` address. The dependable road to `https://` is a **Cloudflare Tunnel** with your own domain name (about $10 a year). The steps are in [REMOTE-ACCESS.md](REMOTE-ACCESS.md), Option 3, and it works on a laptop or a VM.

So: chat on your phone tonight with Path A as written. Add the tunnel when you want voice.

---

## Path B: a cloud VM

A **VM** (also called a VPS) is a small computer you rent in someone's data center. It never sleeps and never closes its lid. You install byte-light on it once, the same way you did on your laptop, and your phone visits it from anywhere.

This is where a companion who is awake around the clock actually lives: scheduled check-ins, Discord and Telegram staying connected, your laptop free to stay shut for a week.

### What you're signing up for

- **A monthly bill** for the VM (DigitalOcean, Hetzner, Vultr, Linode and Google Cloud all work). The smallest size, 1GB of memory at about $6, can run out of memory and crash when your companion is busy; ours did. **2GB (about $12) is a safer start, and 4GB is comfortable** if you plan to turn on lots of features.
- **About an hour** the first time.
- You'll use the terminal to log in to the remote computer. The commands are the same kind you already ran in Getting Started.
- Still no API keys. It uses your same Claude subscription.

### The steps, in plain words

1. Rent the VM and log in to it from your terminal.
2. Install Node and Claude Code on it. Same as Steps 1 and 2 of Getting Started, on the new machine.
3. Clone byte-light and run the setup wizard there.
4. Start it with PM2 so it stays up.
5. Give your phone a door in. You have two choices:
   - **Tailscale** (free, private, same idea as Path A): install it on the VM and on your phone.
   - **Cloudflare Tunnel** (needs a domain name, about $10 a year): you get a real `https://` address. This is the one that makes voice, "install as app" and notifications work properly on a phone.

The full walkthrough with every command is in **[CLOUD-DEPLOYMENT.md](CLOUD-DEPLOYMENT.md)**.

Whichever door you choose, the rule from Path A still applies: **the address you type on your phone has to be listed under `cors: origins` in `bytelight.yaml`**, and you need a password set.

### Bringing your companion with you

If you've already been talking to your companion on your laptop and want that history on the VM, three things carry the whole house:

- `CLAUDE.md` (who they are)
- `bytelight.yaml` (your settings)
- the `data/` folder (memory and conversations)

**Be careful with the `data/` folder.** The memory lives in a database file, and copying it while byte-light is running, or zipping the folder and unzipping it over the top of the VM's copy, can corrupt it. We learned that the hard way. The safe way:

1. Stop byte-light on the laptop completely (`pm2 stop bytelight`, or `Ctrl + C` in the terminal).
2. Make a clean backup copy of the database and move *that*:
   ```bash
   sqlite3 data/bytelight.db ".backup data/bytelight-backup.db"
   ```
3. On the VM, stop byte-light, put the backup in place as `data/bytelight.db`, and delete any leftover `bytelight.db-wal` and `bytelight.db-shm` files next to it before starting again.

Also: **don't overwrite the VM's `bytelight.yaml` with your laptop's** without checking `cors: origins` afterward. The VM has a different address than your laptop, and the laptop's file won't have it.

Just started and don't mind a fresh slate? Skip all of this and let the wizard make new ones.

### On Android?

Once your house has an `https://` address, there's a real installable app with calls that keep going when the screen is off. See [ANDROID-APP.md](ANDROID-APP.md).

---

## Quick answers

**Can I skip the computer and just install byte-light on my phone?**
No. The phone is the window, not the house. Something has to stay awake running it: your laptop (Path A) or a VM (Path B).

**Is it safe to have this reachable from my phone?**
With Tailscale, only devices signed in to *your* Tailscale account can reach it at all. With Cloudflare Tunnel the address is public, so your password is the lock. Use a long one. Never open port 3002 on your home router.

**Can I start with A and move to B later?**
Yes. That's the recommended route. See "Bringing your companion with you."
