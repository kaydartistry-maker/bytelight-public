// The Theater — her door (authenticated, mounted at /api/theater in
// routes/api.ts after authMiddleware). She starts a night, loads the
// subtitles (or the house finds them: services/theater-subs-fetch.ts), runs
// the clock beside her TV, says things on the couch and ends the night.
// Saying something queues one companion turn
// (services/theater-couch.ts); while the show plays, the Mouth
// (services/theater-mouth.ts) may queue a beat of its own, and every door
// that changes the night re-arms or stops it. The companions read the clock through
// /api/internal/theater (routes/internal/theater.ts). These doors answer at
// once; the phone re-reads while a turn is out. A night "on the computer"
// hears its lines through the Ear (routes/theater-ear.ts) instead of
// subtitles; pairing the Ear is the /ear doors below.

import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import {
  THEATER_LIMITS,
  THEATER_REACTIONS,
  TheaterError,
  captionOf,
  clockView,
  endNight,
  getNight,
  listNights,
  moveClock,
  readClockAction,
  readStartInput,
  setSubtitles,
  summaryOf,
  updateNightSettings,
  type TheaterNight,
} from '../services/theater.js';
import { armTheaterMouth, mouthArmed, mouthHouseOn, stopTheaterMouth } from '../services/theater-mouth.js';
import { couchCount, couchSeats, couchTalk, sayOnCouch, startTheaterNight, type TheaterLane } from '../services/theater-couch.js';
import { SubtitleError, readSubtitleFile } from '../services/theater-subtitles.js';
import { findSubtitles, searchSubtitles } from '../services/theater-subs-fetch.js';
import { nextEpisode } from '../services/theater-next.js';
import { createPairingCode, earNightView, earPairingView, revokeEar } from '../services/theater-ear.js';

const router = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: THEATER_LIMITS.subtitleBytes, files: 1 } });

function uploadSubtitles(req: Request, res: Response, next: NextFunction) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'That subtitle file is too big (2 MB at most).' });
    }
    return res.status(400).json({ error: err instanceof Error ? err.message : 'The upload did not come through.' });
  });
}

function answer(res: Response, err: unknown, what: string): void {
  if (err instanceof TheaterError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof SubtitleError) {
    res.status(400).json({ error: err.message });
    return;
  }
  console.error(`[theater] could not ${what}:`, err);
  res.status(500).json({ error: `The Theater could not ${what} just now.` });
}

function laneOf(req: Request): TheaterLane | null {
  return (req.app.locals.agentService as TheaterLane | undefined) ?? null;
}

function pastRow(night: TheaterNight) {
  const ended = night.endedAt ? Date.parse(night.endedAt) : Date.now();
  return {
    ...summaryOf(night),
    durationSeconds: Math.max(0, Math.round((ended - Date.parse(night.startedAt)) / 1000)),
    said: couchCount(night),
  };
}

/** One night, whole, the way the phone draws it. */
function nightView(night: TheaterNight) {
  const now = Date.now();
  const houseOn = mouthHouseOn();
  return {
    night: summaryOf(night),
    /** The Mouth: the house switch, and whether it is listening right now ("they're watching"). */
    mouth: { houseOn, armed: mouthArmed(night, houseOn) },
    clock: clockView(night, now),
    caption: night.status === 'live' ? captionOf(night, now) : [],
    talk: couchTalk(night),
    seats: couchSeats(),
    reactions: THEATER_REACTIONS,
    /** A computer night: whether the Ear is paired and listening, and the last line it heard. */
    ear: night.mode === 'computer' ? earNightView(night, now) : null,
  };
}

function idParam(req: Request): string {
  return String(req.params.id);
}

router.get('/', (_req, res) => {
  try {
    const nights = listNights();
    const live = nights.find((n) => n.status === 'live') ?? null;
    res.json({
      live: live ? nightView(live) : null,
      past: nights.filter((n) => n.status === 'ended').map(pastRow),
      reactions: THEATER_REACTIONS,
    });
  } catch (err) {
    answer(res, err, 'open');
  }
});

/**
 * The start form's subtitle search, as she types (free: nothing is
 * downloaded). ?title=&season=&episode= → the best English match and how
 * many others turned up. Nothing found is a 200 with best: null.
 */
router.get('/subtitles/search', async (req, res) => {
  try {
    const q = req.query as Record<string, unknown>;
    const what = readStartInput({ title: q.title, season: q.season, episode: q.episode });
    const found = await searchSubtitles(what);
    const best = found[0] ?? null;
    res.json({
      best: best ? { fileId: best.fileId, label: best.label ?? best.release, release: best.release } : null,
      count: found.length,
    });
  } catch (err) {
    answer(res, err, 'search for subtitles');
  }
});

/**
 * Start a night. { subtitleFileId } is the match the form showed: the house
 * downloads it and loads it (the one download that counts). The night starts
 * whatever the subtitles do; `subtitleError` says why none were loaded.
 */
router.post('/nights', async (req, res) => {
  try {
    let night = startTheaterNight(req.body ?? {});
    let subtitleError: string | null = null;
    const fileId = Number(req.body?.subtitleFileId);
    // A computer night never downloads: the Ear hears the lines.
    if (night.mode === 'tv' && Number.isInteger(fileId) && fileId > 0) {
      try {
        night = await findSubtitles(night.id, { fileId });
      } catch (err) {
        if (!(err instanceof TheaterError)) console.error('[theater] could not load the found subtitles:', err);
        subtitleError = err instanceof TheaterError ? err.message : 'The subtitles could not be loaded just now. Load a file instead.';
        night = getNight(night.id) ?? night;
      }
    }
    armTheaterMouth(laneOf(req));
    res.status(201).json({ ...nightView(night), subtitleError });
  } catch (err) {
    answer(res, err, 'start the night');
  }
});

// ── the Ear (browser extension) — her side: pair it, see it, let it go ──────
// The extension's own door is routes/theater-ear.ts, at /api/theater-ear.

/** Is the Ear paired, listening, or is a code waiting? */
router.get('/ear', (_req, res) => {
  try {
    res.json(earPairingView());
  } catch (err) {
    answer(res, err, 'read the Ear');
  }
});

/** "Connect the Ear": a one-time code (8 characters, 10 minutes) to paste into the extension. */
router.post('/ear/pair', (_req, res) => {
  try {
    const code = createPairingCode();
    res.status(201).json({ ...code, ear: earPairingView() });
  } catch (err) {
    answer(res, err, 'make a pairing code');
  }
});

/** "Disconnect the Ear": its token stops working at once. */
router.post('/ear/disconnect', (_req, res) => {
  try {
    revokeEar();
    res.json(earPairingView());
  } catch (err) {
    answer(res, err, 'disconnect the Ear');
  }
});

router.get('/nights/:id', (req, res) => {
  try {
    const night = getNight(idParam(req));
    if (!night) return res.status(404).json({ error: 'There is no theater night with that id.' });
    res.json(nightView(night));
  } catch (err) {
    answer(res, err, 'open that night');
  }
});

/** Her own subtitles, for the faint line behind the clock (her screen, her show). */
router.get('/nights/:id/cues', (req, res) => {
  try {
    const night = getNight(idParam(req));
    if (!night) return res.status(404).json({ error: 'There is no theater night with that id.' });
    res.json({ cues: night.cues });
  } catch (err) {
    answer(res, err, 'read the subtitles');
  }
});

router.post('/nights/:id/subtitles', uploadSubtitles, (req, res) => {
  try {
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) return res.status(400).json({ error: 'Choose an .srt or .vtt file.' });
    if (!/\.(srt|vtt)$/i.test(file.originalname || '')) {
      return res.status(400).json({ error: 'The Theater reads .srt or .vtt subtitle files.' });
    }
    const cues = readSubtitleFile(file.buffer);
    const night = setSubtitles(idParam(req), cues, file.originalname);
    armTheaterMouth(laneOf(req));
    res.json(nightView(night));
  } catch (err) {
    answer(res, err, 'load the subtitles');
  }
});

/**
 * The house finds the subtitles itself (OpenSubtitles) and loads them the way
 * an upload would: "Try another" ({ another: true }) on the live night, or
 * "Find subtitles" when a night has none. A night that already has subtitles
 * is never downloaded for again without "another".
 */
router.post('/nights/:id/subtitles/find', async (req, res) => {
  try {
    const night = await findSubtitles(idParam(req), { another: req.body?.another === true });
    armTheaterMouth(laneOf(req));
    res.json(nightView(night));
  } catch (err) {
    answer(res, err, 'find the subtitles');
  }
});

router.post('/nights/:id/clock', (req, res) => {
  try {
    const night = moveClock(idParam(req), readClockAction(req.body));
    armTheaterMouth(laneOf(req));
    res.json(nightView(night));
  } catch (err) {
    answer(res, err, 'move the clock');
  }
});

/** The live screen's settings: how chatty ({ chatty: 0..100 }) and "Let them react" ({ mouthOn }). */
router.patch('/nights/:id', (req, res) => {
  try {
    const night = updateNightSettings(idParam(req), req.body ?? {});
    armTheaterMouth(laneOf(req));
    res.json(nightView(night));
  } catch (err) {
    answer(res, err, 'change that');
  }
});

router.post('/nights/:id/say', (req, res) => {
  try {
    const lane = laneOf(req);
    const night = sayOnCouch(lane, idParam(req), { text: req.body?.text });
    res.status(201).json({ ...nightView(night), woke: Boolean(lane) });
  } catch (err) {
    answer(res, err, 'say that');
  }
});

router.post('/nights/:id/end', (req, res) => {
  try {
    const night = endNight(idParam(req));
    stopTheaterMouth();
    res.json(nightView(night));
  } catch (err) {
    answer(res, err, 'end the night');
  }
});

/**
 * Her "Next episode" button: the same move as asking them on the couch. Ends
 * this night, starts episode + 1 with her settings, finds its subtitles (one
 * of the day's downloads), and the Mouth follows the new night.
 */
router.post('/nights/:id/next', async (req, res) => {
  try {
    const result = await nextEpisode(idParam(req));
    stopTheaterMouth();
    armTheaterMouth(laneOf(req));
    res.json({ ...nightView(result.night), subtitles: result.subtitles });
  } catch (err) {
    answer(res, err, 'start the next episode');
  }
});

export default router;
