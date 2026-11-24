// The Theater — "next one": the next episode, hands-free.
//
// She says "next episode" on the couch; the companions call
// POST /api/internal/theater/nights/:id/next (routes/internal/theater.ts),
// which lands here. The night she was watching ends, a new night starts for
// the same title, same season, episode + 1, with her settings carried over
// (how chatty, no spoilers, "Let them react"), and the new night finds its
// own subtitles the way the start form does: search, take the best match,
// one download from the day's five (theater-subs-fetch.ts).
//
// Built only from the existing pieces: endNight, startTheaterNight (its own
// couch thread), updateNightSettings and findSubtitles. Nothing is guessed:
// a movie night, or a night without both a season and an episode, is
// refused plainly, and the season never rolls over on its own. If no
// subtitles turn up (or the day's downloads are spent), the new night still
// starts and says why; she can load a file.
//
// A computer night (the Ear, theater-ear.ts) skips the subtitle search
// entirely: the next night is simply another computer night, and the Ear
// hears its lines as they play.
//
// The new night's clock waits for her to press play, like any new night:
// the clock is hers, and starting it on a guess could run it ahead of the TV.
//
// Asked twice for the same night (a retried call, a double "next"), it
// answers with the night it already started: one new night, one download.

import crypto from 'crypto';
import { createMessage } from './db/messages.js';
import { nightName, startTheaterNight } from './theater-couch.js';
import { findSubtitles, type SubsDeps } from './theater-subs-fetch.js';
import {
  TheaterError,
  endNight,
  getNight,
  liveNight,
  mouthOnFor,
  noteNextNight,
  readStartInput,
  theaterDir,
  updateNightSettings,
  type TheaterNight,
} from './theater.js';

export interface NextEpisodeResult {
  night: TheaterNight;
  /** The night that just ended. */
  previous: TheaterNight;
  subtitles: {
    loaded: boolean;
    /** The release that was loaded, when one was. */
    name: string | null;
    /** Why none were loaded (nothing found, out of downloads, no key…), or null. */
    error: string | null;
  };
  /** True when this night had already moved on and the call only read back the next one. */
  already: boolean;
}

export interface NextEpisodeDeps {
  root?: string;
  /** Passed to the subtitle fetch (tests hand in a stand-in fetch). */
  subs?: SubsDeps;
}

function resultFor(previous: TheaterNight, night: TheaterNight, error: string | null, already: boolean): NextEpisodeResult {
  const loaded = night.cues.length > 0;
  return {
    night,
    previous,
    subtitles: { loaded, name: loaded ? night.subtitleName : null, error: loaded ? null : error },
    already,
  };
}

/** What the house says on the new night's couch about its subtitles. */
function subtitlesLine(night: TheaterNight, error: string | null): string {
  if (night.mode === 'computer') return 'On the computer: the Ear hears the lines as they play.';
  if (night.cues.length > 0) return `Subtitles found and loaded: ${night.subtitleName ?? 'from OpenSubtitles'}.`;
  return `No subtitles loaded: ${error ?? 'none turned up.'}`;
}

async function next(id: string, deps: NextEpisodeDeps): Promise<NextEpisodeResult> {
  const root = deps.root ?? theaterDir();
  const old = getNight(id, root);
  if (!old) throw new TheaterError(404, 'There is no theater night with that id.');

  // Already moved on from this night: read the next one back, start nothing.
  if (old.nextNightId) {
    const already = getNight(old.nextNightId, root);
    if (already) return resultFor(old, already, null, true);
  }

  if (old.season === null && old.episode === null) {
    throw new TheaterError(400, `${old.title} is a movie night, so there is no next episode.`);
  }
  if (old.season === null || old.episode === null) {
    throw new TheaterError(400, `${nightName(old)} has no season and episode both, so there is no next one to count to. Start the next night by hand.`);
  }
  const live = liveNight(root);
  if (live && live.id !== old.id) {
    throw new TheaterError(409, `Another night is on (${nightName(live)}); the next episode follows the night that's playing.`);
  }

  const input = {
    title: old.title,
    season: old.season,
    episode: old.episode + 1,
    mode: old.mode,
    chatty: old.chatty,
    noSpoilers: old.noSpoilers,
  };
  // Checked before anything ends, so a refusal leaves her night playing.
  readStartInput(input);

  // Credits on the old one, then the new night with its own couch thread.
  const previous = endNight(old.id, root);
  let night = startTheaterNight(input, root);
  noteNextNight(previous.id, night.id, root);
  if (!mouthOnFor(old)) night = updateNightSettings(night.id, { mouthOn: false }, root);

  let error: string | null = null;
  // A computer night needs no subtitles: the Ear hears the next episode's lines as they play.
  if (night.mode !== 'computer') {
    try {
      night = await findSubtitles(night.id, {}, { ...deps.subs, root });
    } catch (err) {
      if (!(err instanceof TheaterError)) console.error('[theater] the next episode could not find its subtitles:', err);
      error = err instanceof TheaterError ? err.message : 'The subtitles could not be loaded just now. Load a file instead.';
      night = getNight(night.id, root) ?? night;
    }
  }

  try {
    createMessage({
      id: crypto.randomUUID(), threadId: night.threadId, role: 'system',
      content: `Next episode, after ${nightName(previous)}. ${subtitlesLine(night, error)}`,
      platform: 'api', metadata: { room: 'theater', theaterNight: night.id }, createdAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[theater] could not note the next episode on the couch:', err);
  }

  return resultFor(getNight(previous.id, root) ?? previous, night, error, false);
}

const inFlight = new Map<string, Promise<NextEpisodeResult>>();

/**
 * End this night and start the next episode of the same show (episode + 1,
 * same season, her settings carried over), loading its subtitles on its own.
 * One at a time per night: a second ask while one is out gets the same answer.
 */
export function nextEpisode(nightId: string, deps: NextEpisodeDeps = {}): Promise<NextEpisodeResult> {
  const running = inFlight.get(nightId);
  if (running) return running;
  const job = next(nightId, deps).finally(() => inFlight.delete(nightId));
  inFlight.set(nightId, job);
  return job;
}
