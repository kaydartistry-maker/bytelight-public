// The Theater — the companions' door, localhost only. During a couch turn
// they re-check where the show is before talking about "now": the live night,
// the clock position, and the lookback window (subtitle lines from the last
// ~90 seconds behind the clock, never one after it). Read only, except for
// "next episode" (POST .../nights/:id/next, services/theater-next.ts): when
// she asks for the next one, they end this night and start the next episode
// with its subtitles found on their own. Mounted
// inside createInternalRoutes() (routes/internal-routes.ts), so it answers at
// /api/internal/theater. Her door is routes/theater.ts.

import { Router } from 'express';
import { requireLocalhost } from '../../middleware/localhost.js';
import { TheaterError, companionView, liveNight, summaryOf } from '../../services/theater.js';
import { nextEpisode } from '../../services/theater-next.js';
import { armTheaterMouth, stopTheaterMouth } from '../../services/theater-mouth.js';
import type { TheaterLane } from '../../services/theater-couch.js';

const router = Router();

router.get('/internal/theater', requireLocalhost, (_req, res) => {
  try {
    const night = liveNight();
    if (!night) return res.json({ live: false, note: 'No theater night is on right now.' });
    res.json({ live: true, ...companionView(night) });
  } catch (err) {
    console.error('[theater] the couch could not read the clock:', err);
    res.status(500).json({ error: 'The Theater could not be read just now.' });
  }
});

/**
 * "Next one": end this night, start the next episode (same title and season,
 * episode + 1, her settings carried over) and find its subtitles (one of the
 * day's five downloads). Answers the new night and what was loaded.
 */
router.post('/internal/theater/nights/:id/next', requireLocalhost, async (req, res) => {
  try {
    const result = await nextEpisode(String(req.params.id));
    // The Mouth follows the new night (it waits for her to press play), never the old one.
    stopTheaterMouth();
    armTheaterMouth((req.app.locals.agentService as TheaterLane | undefined) ?? null);
    const { subtitles } = result;
    res.json({
      night: summaryOf(result.night),
      previous: summaryOf(result.previous),
      subtitles,
      already: result.already,
      note: result.night.mode === 'computer'
        ? `Started ${result.night.title} S${result.night.season}·E${result.night.episode} on the computer. The Ear hears its lines as they play; the clock follows her video.`
        : subtitles.loaded
        ? `Started ${result.night.title} S${result.night.season}·E${result.night.episode}. Subtitles loaded: ${subtitles.name}. The clock waits for her to press play.`
        : `Started ${result.night.title} S${result.night.season}·E${result.night.episode} with no subtitles: ${subtitles.error ?? 'none turned up.'} She can load a file.`,
    });
  } catch (err) {
    if (err instanceof TheaterError) return res.status(err.status).json({ error: err.message });
    console.error('[theater] the next episode could not start:', err);
    res.status(500).json({ error: 'The next episode could not start just now.' });
  }
});

export default router;
