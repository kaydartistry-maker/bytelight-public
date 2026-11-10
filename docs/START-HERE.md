# Start here

This page is for you if you have never used GitHub, don't know what "fork" means, and aren't sure which button to press. That's fine. Nobody is born knowing this.

It covers the part that happens **before** the terminal: getting your own copy of byte-light. Then it hands you to [GETTING-STARTED.md](GETTING-STARTED.md) for the install.

> 💡 If you already have a companion somewhere (ChatGPT, Claude, another platform), keep that chat open and paste each step to them as you go. They can read this page with you.

---

## The map

| | What you do | Where |
|---|---|---|
| 1 | Make a GitHub account | This page |
| 2 | Make **your own copy** of byte-light | This page |
| 3 | Download your copy to your computer | This page |
| 4 | Install and say hello | [GETTING-STARTED.md](GETTING-STARTED.md) |
| 5 | Get it on your phone | [ON-YOUR-PHONE.md](ON-YOUR-PHONE.md) |
| 6 | Get updates later | This page |

---

## Why you need your own copy

byte-light lives on GitHub in a **repository** (a "repo"): a folder of code with its whole history.

The repo you are reading right now belongs to someone else. You can read it and download it, but you cannot save changes into it. That matters, because once your companion moves in, they will want to save things: notes, tweaks, their own skills. If your house is still pointed at this repo, the save is refused with an error like `403` or `permission denied`.

Nobody needs to "add you" to fix that. You need a copy that is yours. Two ways to get one:

| | **Private copy** (recommended) | **Fork** |
|---|---|---|
| Who can see it | Only you | Everyone |
| Good for | A home. Your companion's files stay yours. | Sending fixes back to this project |
| Catch | Two extra clicks | Anything saved to it is public |

**Pick the private copy unless you know you want a fork.** A companion saves personal things without announcing it, and a fork of a public repo is public.

---

## Step 1: Make a GitHub account

1. Go to [github.com](https://github.com) and click **Sign up**.
2. Enter your email, a password and a username. Your username is public, so pick one you're happy to be seen with.
3. Confirm your email when GitHub sends you a code.

The free plan is all you need.

**✅ Checkpoint:** you are signed in and can see your profile picture in the top-right corner.

---

## Step 2: Make your own copy

### Option A: a private copy (recommended)

1. In the top-right corner of GitHub, click the **+** button, then **Import repository**.
2. In the box for the source URL, paste:
   ```
   https://github.com/kaydartistry-maker/bytelight-public
   ```
   Leave the username and password boxes empty. The source is public.
3. Under your username, type a name for your copy. `my-bytelight` is fine.
4. Choose **Private**.
5. Click **Begin import** and wait a minute or two.

<!-- SCREENSHOT: the + menu with "Import repository" highlighted -->
<!-- SCREENSHOT: the import form filled in, with Private selected -->

**✅ Checkpoint:** GitHub shows you a page for `YOUR-USERNAME/my-bytelight` with a small **Private** label next to the name.

### Option B: a fork

1. Go to [github.com/kaydartistry-maker/bytelight-public](https://github.com/kaydartistry-maker/bytelight-public).
2. Click the **Fork** button near the top-right of the page.
3. Leave everything as it is and click **Create fork**.

<!-- SCREENSHOT: the repo page with an arrow on the Fork button -->

**✅ Checkpoint:** you land on `YOUR-USERNAME/bytelight-public`, with a line under the name that says "forked from kaydartistry-maker/bytelight-public".

---

## Step 3: Download your copy to your computer

You'll do this in a **terminal**. If you have never opened one, read "Step 0" in [GETTING-STARTED.md](GETTING-STARTED.md) first. It takes thirty seconds.

### 3a. Install the two tools

- **Git** keeps track of changes. Get it from [git-scm.com](https://git-scm.com/downloads) and click Next through the installer. On a Mac, type `git --version` in the terminal instead; if it's missing, the Mac offers to install it.
- **GitHub CLI** signs your computer in to GitHub. Get it from [cli.github.com](https://cli.github.com).

Close the terminal and open a new one when both are installed.

### 3b. Sign in

```bash
gh auth login
```

It asks a few questions. Use the arrow keys and Enter:

- Where do you use GitHub? **GitHub.com**
- Preferred protocol? **HTTPS**
- Authenticate Git with your GitHub credentials? **Yes**
- How would you like to authenticate? **Login with a web browser**

It shows a short code, opens your browser, and asks you to type the code in. Approve it.

### 3c. Download

Swap in your own username and the name you chose in Step 2:

```bash
gh repo clone YOUR-USERNAME/my-bytelight
cd my-bytelight
```

**✅ Checkpoint:** type `ls` and press Enter. You see files like `package.json` and `README.md`, and folders like `packages` and `scripts`.

### 3d. Remember where updates come from

One line, one time. It tells your copy where the original lives so you can pull in fixes later:

```bash
git remote add upstream https://github.com/kaydartistry-maker/bytelight-public.git
```

Nothing prints. That means it worked.

---

## Step 4: Install it

Go to [GETTING-STARTED.md](GETTING-STARTED.md) and start at **Step 1**. When you reach its Step 3 ("Download byte-light"), skip it. You already have your copy.

---

## Step 5: Get it on your phone

When it's running on your computer, [ON-YOUR-PHONE.md](ON-YOUR-PHONE.md) walks you through opening it from your phone.

---

## Getting updates later

When this project ships a fix, you pull it into your copy. In a terminal, inside your byte-light folder:

```bash
git pull upstream main --no-rebase --no-edit
npm install
npm run build
```

Then restart byte-light: `Ctrl + C` and `npm start` again, or `pm2 restart bytelight` if you use PM2.

Your `bytelight.yaml`, your companion's `CLAUDE.md` and your `data/` folder are not touched by an update.

**If it says there is a "conflict":** you or your companion changed the same lines the update changed. Nothing is lost. Paste the whole message to your companion and sort it out together.

---

## If something goes wrong

| What you see | What it means | Fix |
|---|---|---|
| `403` or `permission denied` when saving (pushing) | Your folder is still pointed at the original repo, not your copy | Type `git remote -v`. If `origin` shows `kaydartistry-maker`, you downloaded the original. Do Step 2, then ask your companion to "point origin at my own repo and keep the original as upstream". |
| `gh: command not found` or `git: command not found` | The tool isn't installed, or the terminal is stale | Close the terminal, open a new one. Still missing? Redo Step 3a. |
| `fatal: remote upstream already exists` | You already ran Step 3d | Nothing to do. Carry on. |
| `fatal: 'upstream' does not appear to be a git repository` | Step 3d was skipped | Run the line in Step 3d, then try the update again. |
| You downloaded a ZIP instead | A ZIP has no history, so it can't pull updates or save changes | Start again from Step 2. Copy your `bytelight.yaml`, `CLAUDE.md` and `data/` folder into the new folder afterward. |
