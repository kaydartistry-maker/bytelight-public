// The Theater finding its own subtitles. No network: a stand-in OpenSubtitles
// answers every call and counts what it was asked. Titles and lines are made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getNight, startNight, setSubtitles, summaryOf } from './theater.js';
import { clearSubtitleSearchCache, findSubtitles, rankCandidates, searchSubtitles, searchUrl, SUBS_MESSAGES, type SubsFetch } from './theater-subs-fetch.js';
import { TheaterError } from './theater.js';

const KEY = 'test-key-not-real';

function freshRoot(): string {
  clearSubtitleSearchCache();
  return mkdtempSync(join(tmpdir(), 'theater-subs-test-'));
}

function srt(text: string): string {
  return ['1', '00:00:01,000 --> 00:00:03,000', text, '', '2', '00:00:04,000 --> 00:00:06,000', 'Second line.', ''].join('\n');
}

function result(fileId: number, downloads: number, opts: { season?: number; episode?: number; release?: string; language?: string; type?: string; files?: number; foreign?: boolean } = {}) {
  const files = Array.from({ length: opts.files ?? 1 }, (_, i) => ({ file_id: fileId + i * 1000, file_name: `file-${fileId}-${i}.srt` }));
  return {
    attributes: {
      language: opts.language ?? 'en',
      download_count: downloads,
      release: opts.release ?? `Release.${fileId}`,
      foreign_parts_only: opts.foreign ?? false,
      feature_details: {
        feature_type: opts.type ?? 'Episode',
        parent_title: 'The Quiet Harbor',
        title: 'Low Tide',
        season_number: opts.season ?? 1,
        episode_number: opts.episode ?? 3,
      },
      files,
    },
  };
}

interface Call { url: string; method: string; headers: Record<string, string>; body?: string }

/** A stand-in OpenSubtitles: search answers `searchData`, downloads answer per file id. */
function fakeApi(searchData: unknown, opts: { downloadStatus?: number; fileText?: (id: number) => string } = {}) {
  const calls: Call[] = [];
  const fetchImpl: SubsFetch = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body });
    const reply = (status: number, body: unknown, text?: string) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => text ?? JSON.stringify(body),
    });
    if (url.includes('/subtitles?')) return reply(200, searchData);
    if (url.endsWith('/download')) {
      const status = opts.downloadStatus ?? 200;
      if (status !== 200) return reply(status, { message: 'You have downloaded your allowed 5 subtitles for 24h', remaining: 0 });
      const id = JSON.parse(init?.body ?? '{}').file_id as number;
      return reply(200, { link: `https://dl.example.test/file/${id}`, file_name: `${id}.srt`, remaining: 4 });
    }
    const m = /\/file\/(\d+)$/.exec(url);
    if (m) {
      const id = Number(m[1]);
      return reply(200, null, opts.fileText ? opts.fileText(id) : srt(`Line from file ${id}.`));
    }
    return reply(404, null);
  };
  const downloads = () => calls.filter((c) => c.url.endsWith('/download')).length;
  const searches = () => calls.filter((c) => c.url.includes('/subtitles?')).length;
  return { fetchImpl, calls, downloads, searches };
}

const SEARCH = {
  data: [
    result(11, 500),
    result(22, 9000),
    result(33, 100000, { episode: 4 }), // the wrong episode, however popular
    result(44, 70000, { season: 2 }), // the wrong season
    result(55, 80000, { language: 'pt-BR' }),
    result(66, 60000, { files: 2 }), // a CD1/CD2 split
    result(77, 50000, { foreign: true }),
    result(88, 3000),
    result(22, 1), // the same file again
  ],
};

test('the search asks for English, the exact season and episode, params sorted', () => {
  const url = searchUrl({ title: 'The Quiet Harbor', season: 1, episode: 3 });
  assert.equal(url, 'https://api.opensubtitles.com/api/v1/subtitles?episode_number=3&languages=en&query=the%20quiet%20harbor&season_number=1&type=episode');
  const movie = searchUrl({ title: 'Long Night', season: null, episode: null });
  assert.equal(movie, 'https://api.opensubtitles.com/api/v1/subtitles?languages=en&query=long%20night&type=movie');
});

test('ranking keeps only this episode in English, one whole file, most downloaded first', () => {
  const ranked = rankCandidates(SEARCH, { season: 1, episode: 3 });
  assert.deepEqual(ranked.map((c) => c.fileId), [22, 88, 11]);
  assert.equal(ranked[0].release, 'Release.22');
  assert.equal(ranked[0].fileName, 'file-22-0.srt');
  assert.equal(ranked[0].label, 'The Quiet Harbor S01E03 · Release.22');
  assert.deepEqual(rankCandidates({ nope: true }, { season: 1, episode: 3 }), []);
  assert.deepEqual(rankCandidates(null, { season: 1, episode: 3 }), []);
});

test('ranking for a movie drops episodes', () => {
  const ranked = rankCandidates({ data: [result(1, 10, { type: 'Movie' }), result(2, 99, { type: 'Episode' })] }, { season: null, episode: null });
  assert.deepEqual(ranked.map((c) => c.fileId), [1]);
});

test('starting a night with S/E finds and loads the best subtitles the way an upload would', async () => {
  const root = freshRoot();
  const night = startNight({ title: 'The Quiet Harbor', season: 1, episode: 3 }, 'thread-1', root);
  const api = fakeApi(SEARCH);
  const loaded = await findSubtitles(night.id, {}, { fetchImpl: api.fetchImpl, apiKey: () => KEY, root });
  assert.equal(loaded.cues.length, 2);
  assert.equal(loaded.cues[0].text, 'Line from file 22.');
  assert.equal(loaded.subtitleName, 'Release.22');
  assert.equal(loaded.subtitleSource, 'opensubtitles');
  assert.deepEqual(loaded.subtitleTried, [22]);
  const summary = summaryOf(loaded);
  assert.equal(summary.subtitleSource, 'opensubtitles');
  assert.equal(summary.subtitleSearched, true);
  assert.equal(summary.subtitleOthers, 2);
  assert.equal('subtitleCandidates' in summary, false, 'the candidate list stays on the house');

  // Every call carries the key and the house's own User-Agent; the download is a JSON POST of the file id.
  for (const c of api.calls.filter((c) => c.url.startsWith('https://api.opensubtitles.com'))) {
    assert.equal(c.headers['Api-Key'], KEY);
    assert.equal(c.headers['User-Agent'], 'BytelightTheater v1.0');
    assert.equal(c.headers.Accept, 'application/json');
  }
  const dl = api.calls.find((c) => c.url.endsWith('/download'))!;
  assert.equal(dl.method, 'POST');
  assert.deepEqual(JSON.parse(dl.body!), { file_id: 22 });
});

test('a night that has subtitles is never downloaded for again', async () => {
  const root = freshRoot();
  const night = startNight({ title: 'The Quiet Harbor', season: 1, episode: 3 }, 'thread-1', root);
  const api = fakeApi(SEARCH);
  const deps = { fetchImpl: api.fetchImpl, apiKey: () => KEY, root };
  await findSubtitles(night.id, {}, deps);
  await findSubtitles(night.id, {}, deps);
  assert.equal(api.downloads(), 1);
  assert.equal(api.searches(), 1);

  // Her own upload counts too: the house doesn't go looking over it.
  const root2 = freshRoot();
  const mine = startNight({ title: 'The Quiet Harbor', season: 1, episode: 3 }, 'thread-2', root2);
  setSubtitles(mine.id, [{ start: 1, end: 2, text: 'Mine.' }], 'mine.srt', root2);
  const api2 = fakeApi(SEARCH);
  const kept = await findSubtitles(mine.id, {}, { fetchImpl: api2.fetchImpl, apiKey: () => KEY, root: root2 });
  assert.equal(kept.subtitleName, 'mine.srt');
  assert.equal(summaryOf(kept).subtitleSource, 'upload');
  assert.equal(api2.calls.length, 0);
});

test('a double tap spends one download', async () => {
  const root = freshRoot();
  const night = startNight({ title: 'The Quiet Harbor', season: 1, episode: 3 }, 'thread-1', root);
  const api = fakeApi(SEARCH);
  const deps = { fetchImpl: api.fetchImpl, apiKey: () => KEY, root };
  await Promise.all([findSubtitles(night.id, {}, deps), findSubtitles(night.id, {}, deps)]);
  assert.equal(api.downloads(), 1);
});

test('"Try another" takes the next untried file without searching again, then says when there are none left', async () => {
  const root = freshRoot();
  const night = startNight({ title: 'The Quiet Harbor', season: 1, episode: 3 }, 'thread-1', root);
  const api = fakeApi(SEARCH);
  const deps = { fetchImpl: api.fetchImpl, apiKey: () => KEY, root };
  await findSubtitles(night.id, {}, deps);
  const second = await findSubtitles(night.id, { another: true }, deps);
  assert.equal(second.subtitleName, 'Release.88');
  assert.equal(second.cues[0].text, 'Line from file 88.');
  const third = await findSubtitles(night.id, { another: true }, deps);
  assert.equal(third.subtitleName, 'Release.11');
  assert.deepEqual(third.subtitleTried, [22, 88, 11]);
  assert.equal(summaryOf(third).subtitleOthers, 0);
  assert.equal(api.searches(), 1, 'the first search is kept on the night');
  await assert.rejects(findSubtitles(night.id, { another: true }, deps), (err: unknown) => err instanceof TheaterError && err.status === 404 && err.message === SUBS_MESSAGES.noOthers);
  assert.equal(api.downloads(), 3);
  assert.equal(getNight(night.id, root)!.subtitleName, 'Release.11', 'the last good subtitles stay loaded');
});

test('out of downloads says so plainly and leaves the night usable', async () => {
  for (const status of [406, 429]) {
    const root = freshRoot();
    const night = startNight({ title: 'The Quiet Harbor', season: 1, episode: 3 }, 'thread-1', root);
    const api = fakeApi(SEARCH, { downloadStatus: status });
    await assert.rejects(
      findSubtitles(night.id, {}, { fetchImpl: api.fetchImpl, apiKey: () => KEY, root }),
      (err: unknown) => err instanceof TheaterError && err.status === 429 && err.message === 'Out of subtitle downloads for today — load a file instead.',
    );
    const after = getNight(night.id, root)!;
    assert.equal(after.status, 'live');
    assert.equal(after.cues.length, 0);
    assert.deepEqual(after.subtitleTried ?? [], [], 'a refused download is not counted as tried');
    assert.equal(summaryOf(after).subtitleSearched, true);
    // She can still load her own file.
    assert.equal(setSubtitles(night.id, [{ start: 1, end: 2, text: 'Mine.' }], 'mine.srt', root).cues.length, 1);
  }
});

test('no API key: a plain message, nothing called, the night is fine', async () => {
  const root = freshRoot();
  const night = startNight({ title: 'The Quiet Harbor', season: 1, episode: 3 }, 'thread-1', root);
  const api = fakeApi(SEARCH);
  await assert.rejects(
    findSubtitles(night.id, {}, { fetchImpl: api.fetchImpl, apiKey: () => undefined, root }),
    (err: unknown) => err instanceof TheaterError && err.status === 503 && err.message === SUBS_MESSAGES.noKey,
  );
  assert.equal(api.calls.length, 0);
  assert.equal(getNight(night.id, root)!.status, 'live');
});

test('nothing found, half an episode, and an unreadable file each say so', async () => {
  const root = freshRoot();
  const night = startNight({ title: 'Nothing Like It', season: 1, episode: 3 }, 'thread-1', root);
  const empty = fakeApi({ data: [] });
  await assert.rejects(findSubtitles(night.id, {}, { fetchImpl: empty.fetchImpl, apiKey: () => KEY, root }), (err: unknown) => err instanceof TheaterError && err.status === 404 && /No English subtitles turned up for Nothing Like It S1·E3/.test(err.message));
  assert.equal(empty.downloads(), 0);

  const root2 = freshRoot();
  const half = startNight({ title: 'The Quiet Harbor', season: 1 }, 'thread-2', root2);
  const api2 = fakeApi(SEARCH);
  await assert.rejects(findSubtitles(half.id, {}, { fetchImpl: api2.fetchImpl, apiKey: () => KEY, root: root2 }), (err: unknown) => err instanceof TheaterError && err.message === SUBS_MESSAGES.halfEpisode);
  assert.equal(api2.calls.length, 0);

  const root3 = freshRoot();
  const bad = startNight({ title: 'The Quiet Harbor', season: 1, episode: 3 }, 'thread-3', root3);
  const api3 = fakeApi(SEARCH, { fileText: () => 'not subtitles at all' });
  await assert.rejects(findSubtitles(bad.id, {}, { fetchImpl: api3.fetchImpl, apiKey: () => KEY, root: root3 }), (err: unknown) => err instanceof TheaterError && err.message === SUBS_MESSAGES.unreadable);
  assert.deepEqual(getNight(bad.id, root3)!.subtitleTried, [22], 'the spent download is remembered, so Try another moves on');
});

test('the search being down is a friendly message, not a crash', async () => {
  const root = freshRoot();
  const night = startNight({ title: 'The Quiet Harbor', season: 1, episode: 3 }, 'thread-1', root);
  const down: SubsFetch = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(findSubtitles(night.id, {}, { fetchImpl: down, apiKey: () => KEY, root }), (err: unknown) => err instanceof TheaterError && err.status === 502 && err.message === SUBS_MESSAGES.unreachable);
});

test('the start form search: free, best first, kept for Start, nothing downloaded', async () => {
  clearSubtitleSearchCache();
  const api = fakeApi(SEARCH);
  const deps = { fetchImpl: api.fetchImpl, apiKey: () => KEY };
  const found = await searchSubtitles({ title: 'The Quiet Harbor', season: 1, episode: 3 }, deps);
  assert.deepEqual(found.map((c) => c.fileId), [22, 88, 11]);
  await searchSubtitles({ title: 'the quiet harbor ', season: 1, episode: 3 }, deps);
  assert.equal(api.searches(), 1, 'the same search is kept a while');
  assert.equal(api.downloads(), 0);

  // Start with the match she saw: that file downloads, no second search.
  const root = mkdtempSync(join(tmpdir(), 'theater-subs-test-'));
  const night = startNight({ title: 'The Quiet Harbor', season: 1, episode: 3 }, 'thread-1', root);
  const loaded = await findSubtitles(night.id, { fileId: 88 }, { ...deps, root });
  assert.equal(loaded.subtitleName, 'Release.88');
  assert.equal(api.searches(), 1);
  assert.equal(api.downloads(), 1);
  // Try another after that goes to the best one not tried.
  const other = await findSubtitles(night.id, { another: true }, { ...deps, root });
  assert.equal(other.subtitleName, 'Release.22');

  await assert.rejects(searchSubtitles({ title: 'X', season: 1, episode: 3 }, { fetchImpl: api.fetchImpl, apiKey: () => undefined }), (err: unknown) => err instanceof TheaterError && err.message === SUBS_MESSAGES.noKey);
  await assert.rejects(searchSubtitles({ title: 'X', season: 1, episode: null }, deps), (err: unknown) => err instanceof TheaterError && err.message === SUBS_MESSAGES.halfEpisode);
});
