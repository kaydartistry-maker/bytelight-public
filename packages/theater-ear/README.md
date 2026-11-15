# The Ear

The Ear is a little helper for Chrome on your computer. When you watch something on Netflix or Hulu, it quietly reads the subtitles as they appear and passes them to the Theater, along with where the video is. That way the couch knows exactly what was just said, and the clock follows your video all by itself. No more pressing play on the phone.

It only ever sends the subtitle words, their times, and where the video is. Never your account, your cookies, or anything else on the page.

## Putting it in Chrome (once)

1. Open Chrome and go to `chrome://extensions` (type it in the address bar).
2. Turn on **Developer mode** (the switch in the top right corner).
3. Click **Load unpacked**.
4. Pick this folder, `theater-ear`.
5. The Ear shows up in your extensions. Click the puzzle piece in Chrome's toolbar and pin it, so the 👂 is easy to reach.

If the folder ever gets updated, come back to `chrome://extensions` and click the little circle arrow on the Ear's card to reload it.

## Pointing it at your house (before loading)

The Ear only talks to one address. Open `lib.js` and set `HOUSE` near the top to your house's public address (for example `https://chat.example.com`), and put the same address followed by `/*` in `host_permissions` in `manifest.json`. Then load the folder as an unpacked extension.

## Connecting it to the house (once)

1. On your phone, open the Theater and pick **On the computer**.
2. Tap **Connect the Ear**. A code like `ABCD-EFGH` appears. It works once and lasts 10 minutes.
3. On the computer, click the 👂 in Chrome's toolbar, type the code, and click **Connect**.
4. It says **Connected**. That's it; it stays connected until you disconnect it.

To unplug it, tap **Disconnect the Ear** in the Theater (or **Disconnect** in the Ear's popup).

## Watching

1. On your phone, start a theater night **On the computer**.
2. On the computer, open the show on Netflix or Hulu.
3. **Turn the subtitles ON** in Netflix or Hulu. The Ear can only hear what's written on screen; with subtitles off it hears nothing.
4. Press play. The Theater shows "The Ear is listening" and the last line it heard. The couch keeps up from there.

Pause, skip back, skip ahead: the clock follows. "Next episode" works the same as always.

## Hulu: one quick check first

Netflix is known to work the way the Ear expects. Hulu hasn't been checked yet, so the first time you watch on Hulu:

1. Start the show with subtitles on, and let a few lines play.
2. Click the 👂 and press **What do you hear?**
3. It says **Sent**. That sends a small snapshot of what the Ear could see near the bottom of the player (just the names of page pieces and a few words of the subtitles) so it can be tuned to Hulu.

You can do the same on Netflix if the Ear ever goes quiet there.

## If something seems off

- **"Not connected"**: make a new code in the Theater and connect again.
- **"No computer night is on"**: start one in the Theater, and choose **On the computer**.
- **Nothing heard**: check the subtitles are on, then reload the show's page.
- **"The house can't be reached"**: the internet or the house is having a moment. The Ear holds on to a couple of minutes of lines and catches up.

---

For whoever looks after the code: plain JavaScript, Manifest V3, no build step. `lib.js` holds the pure pieces (the selector table is at its top), `content.js` reads the page, `background.js` talks to the house's `/api/theater-ear` door, `popup.*` is the popup. Tests: `node --test packages/theater-ear/tests/*.test.mjs`.
