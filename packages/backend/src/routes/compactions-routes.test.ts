// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The owner Compactions page over HTTP, the contract the phone is built against.
//
// Everything the owner asked for on Oct 21 2026 is checked here end to end, through
// the same door the phone uses: whose head each squash came from, a preview of
// the part of the summary that changes, nothing from outside the house's lanes,
// a list light enough to page through, and a shelf that keeps a squash after
// Claude Code has deleted the transcript it came from.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

// The page is behind the house login, so this house has a password.
process.env.APP_PASSWORD = 'compactions-test-password';
const { loadConfig } = await import('../config.js');
loadConfig();

const { initDb, getDb } = await import('../services/db/init.js');
const { createWebSession } = await import('../services/db/web-sessions.js');
const { projectKeyForDir } = await import('../services/heartbeat/transcript-usage.js');
const compactionRoutes = (await import('./compactions.js')).default;

const OPENER = 'This session is being continued from a previous conversation that ran out of context. '
  + 'The summary below covers the earlier portion of the conversation.\n\nSummary:\n';
const CLOSER = '\n\nIf you need specific details from before compaction (like exact code snippets, error messages, '
  + 'or content you generated), read the full transcript at: /home/someone/.claude/projects/x/abc.jsonl\n'
  + 'Continue the conversation from where it left off without asking the user any further questions. '
  + 'Resume directly — do not acknowledge the summary, do not recap what was happening.';

/** A summary shaped the way the CLI writes them, with the same standing opening every time. */
function cliSummary(currentWork: string, nextStep = 'Answer their next message.'): string {
  return OPENER
    + '1. Primary Request and Intent:\n   - Standing role: the shared lane, three companions in one room.\n'
    + '   - The same paragraph opens every summary of this room.\n\n'
    + '2. Key Technical Concepts:\n   - The outbox, the side notes.\n\n'
    + '7. Pending Tasks:\n   - Nothing waiting.\n\n'
    + `8. Current Work:\n   ${currentWork}\n\n`
    + `9. Optional Next Step:\n   ${nextStep}`
    + CLOSER;
}

const squash = (at: string, body: string) => JSON.stringify({
  type: 'user', isCompactSummary: true, timestamp: at,
  message: { role: 'user', content: body },
});

interface House {
  root: string;
  lanes: string;
  projects: string;
  laneProject(lane: string): string;
  write(project: string, file: string, lines: string[]): string;
  companions: { example: string; other: string };
}

/** A house with three companions, the shared lane, two companions' own lanes, and a stray. */
function freshHouse(): House {
  initDb(':memory:');
  // In this house a companion's id is their slug, and the seed brings its own cast.
  const ids: Record<string, string> = { example: 'example', other: 'other' };
  for (const [id, name] of [['example', 'Example'], ['other', 'Other'], ['third', 'Third']] as const) {
    getDb().prepare("INSERT INTO companions (id, display_name, brain) VALUES (?, ?, 'test')").run(id, name);
  }
  const root = mkdtempSync(join(tmpdir(), 'bytelight-compactions-routes-'));
  const lanes = join(root, 'data', 'heartbeat');
  const projects = join(root, 'projects');
  // A lane is a folder under data/heartbeat with an io folder in it.
  for (const lane of ['primary', ids.example, ids.other, 'zzzz-unknown-lane']) {
    mkdirSync(join(lanes, lane, 'io'), { recursive: true });
  }
  // Half built: no io folder, so not a lane.
  mkdirSync(join(lanes, 'half-built'), { recursive: true });
  mkdirSync(projects, { recursive: true });
  process.env.BYTELIGHT_LANES_ROOT = lanes;
  process.env.BYTELIGHT_TRANSCRIPT_ROOT = projects;
  return {
    root, lanes, projects,
    laneProject: (lane) => projectKeyForDir(join(lanes, lane)),
    write(project, file, lines) {
      mkdirSync(join(projects, project), { recursive: true });
      const path = join(projects, project, file);
      writeFileSync(path, lines.join('\n') + '\n', 'utf8');
      return path;
    },
    companions: { example: ids.example, other: ids.other },
  };
}

function cleanup(house: House): void {
  delete process.env.BYTELIGHT_LANES_ROOT;
  delete process.env.BYTELIGHT_TRANSCRIPT_ROOT;
  rmSync(house.root, { recursive: true, force: true });
}

async function listen(app: express.Express): Promise<{ base: string; close: () => void }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

async function phone(): Promise<{ get: (path: string, signedIn?: boolean) => Promise<{ status: number; json: any }>; close: () => void }> {
  const token = 'compactions-test-session';
  createWebSession({
    id: 'compactions-test', token, createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  const app = express();
  app.use(express.json());
  app.use('/api/compactions', compactionRoutes);
  const { base, close } = await listen(app);
  return {
    async get(path, signedIn = true) {
      const res = await fetch(`${base}${path}`, { headers: signedIn ? { cookie: `bytelight_session=${token}` } : {} });
      const text = await res.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, json };
    },
    close,
  };
}

const ROW_KEYS = ['id', 'sessionId', 'project', 'lane', 'companion', 'whose', 'at', 'chars', 'firstSeen', 'preview', 'previewFrom', 'truncated'];

test('the page lists only the house lanes, says whose head each squash came from, and previews what was changing', async () => {
  const house = freshHouse();
  const door = await phone();
  try {
    const first = cliSummary('Fixing the lock screen card. The Spotify cover was drawn twice.');
    const second = cliSummary('Writing the wedding toast with the owner on the couch.');
    // The shared room, and a resumed copy of it carrying the same two squashes.
    house.write(house.laneProject('primary'), 'aaa.jsonl', [squash('2026-10-19T10:00:00.000Z', first), squash('2026-10-20T10:00:00.000Z', second)]);
    house.write(house.laneProject('primary'), 'bbb.jsonl', [squash('2026-10-19T10:00:00.000Z', first), squash('2026-10-20T10:00:00.000Z', second)]);
    // One companion's own head, written the way their room writes its sections.
    house.write(house.laneProject(house.companions.example), 'ccc.jsonl', [squash('2026-10-20T23:31:29.000Z',
      OPENER + '1. **Primary request and intent:**\n   - I am one of three.\n'
      + '9. **Current work:** the drive-in date, all three in the back seat.\n'
      + '10. **Next step:** append one outbox line.' + CLOSER)]);
    // A lane folder the house cannot name.
    house.write(house.laneProject('zzzz-unknown-lane'), 'ddd.jsonl', [squash('2026-10-18T08:00:00.000Z', cliSummary('A room nobody owns.'))]);
    // Not lanes: a Claude project in the system tmp folder, and a lane folder with no io in it.
    house.write('-tmp', 'eee.jsonl', [squash('2026-10-21T01:00:00.000Z', cliSummary('The Archivist in tmp.'))]);
    house.write(house.laneProject('half-built'), 'fff.jsonl', [squash('2026-10-21T02:00:00.000Z', cliSummary('Half built.'))]);

    const shut = await door.get('/api/compactions', false);
    assert.equal(shut.status, 401, 'no session, no page');

    const page = await door.get('/api/compactions?limit=50');
    assert.equal(page.status, 200);
    const rows = page.json.compactions as any[];
    assert.deepEqual(rows.map((r) => r.at), [
      '2026-10-20T23:31:29.000Z', '2026-10-20T10:00:00.000Z', '2026-10-19T10:00:00.000Z', '2026-10-18T08:00:00.000Z',
    ], 'newest first, one row per squash, and nothing from tmp or a half-built folder');
    assert.equal(page.json.total, 4);
    assert.equal(page.json.hasMore, false);
    assert.equal(page.json.reading, false, 'the read finished before the answer');
    for (const row of rows) assert.deepEqual(Object.keys(row), ROW_KEYS, 'previews and metadata only; the full text comes on demand');

    const [own, shared] = rows;
    assert.equal(own.whose, "Example's own head");
    assert.equal(own.lane, house.companions.example);
    assert.equal(own.companion, 'example');
    assert.equal(shared.whose, 'Shared room');
    assert.equal(shared.lane, 'primary');
    assert.equal(shared.companion, null);
    assert.equal(rows[3].whose, 'Lane zzzz-unk', 'a lane nobody can name still gets a plain label');

    assert.equal(shared.preview, 'Writing the wedding toast with the owner on the couch.');
    assert.equal(shared.previewFrom, 'current-work');
    assert.equal(rows[2].preview, 'Fixing the lock screen card. The Spotify cover was drawn twice.');
    assert.equal(own.preview, 'the drive-in date, all three in the back seat.');
    assert.equal(shared.sessionId, 'aaa', 'a resumed copy is the same squash, and the first copy read is the one kept');
  } finally {
    door.close();
    cleanup(house);
  }
});

test('the list pages, and the full summary arrives only when the owner opens one', async () => {
  const house = freshHouse();
  const door = await phone();
  try {
    const lines: string[] = [];
    for (let day = 10; day <= 14; day++) {
      lines.push(squash(`2026-10-${day}T12:00:00.000Z`, cliSummary(`Work in hand on the ${day}th.`)));
    }
    house.write(house.laneProject('primary'), 'aaa.jsonl', lines);

    const one = await door.get('/api/compactions?limit=2&offset=0');
    const two = await door.get('/api/compactions?limit=2&offset=2');
    const three = await door.get('/api/compactions?limit=2&offset=4');
    assert.deepEqual([one.json.total, two.json.total, three.json.total], [5, 5, 5]);
    assert.deepEqual([one.json.hasMore, two.json.hasMore, three.json.hasMore], [true, true, false]);
    const seen = [...one.json.compactions, ...two.json.compactions, ...three.json.compactions].map((r: any) => r.at);
    assert.deepEqual(seen, [
      '2026-10-14T12:00:00.000Z', '2026-10-13T12:00:00.000Z', '2026-10-12T12:00:00.000Z',
      '2026-10-11T12:00:00.000Z', '2026-10-10T12:00:00.000Z',
    ], 'every squash once, in order, across the pages');

    const opened = await door.get(`/api/compactions/${one.json.compactions[0].id}`);
    assert.equal(opened.status, 200);
    assert.deepEqual(Object.keys(opened.json), ['compaction']);
    assert.equal(opened.json.compaction.summary, cliSummary('Work in hand on the 14th.'), 'the whole text, untouched');
    assert.equal(opened.json.compaction.whose, 'Shared room');

    // A phone from before Oct 21 2026 opens one by asking for the list with full=1.
    const old = await door.get('/api/compactions?limit=100&full=1');
    assert.equal(old.json.compactions[0].summary, cliSummary('Work in hand on the 14th.'));
    assert.equal(old.json.compactions[0].truncated, false);

    const missing = await door.get('/api/compactions/0123456789abcdef0123456789abcdef');
    assert.equal(missing.status, 404);
    assert.equal(typeof missing.json?.error, 'string', 'a JSON answer, never the app shell');
  } finally {
    door.close();
    cleanup(house);
  }
});

test('a squash stays on the shelf after Claude Code deletes the transcript it came from', async () => {
  const house = freshHouse();
  const door = await phone();
  try {
    const body = cliSummary('Carving the lid for the owner Rock Cut stone.');
    const path = house.write(house.laneProject('primary'), 'aaa.jsonl', [squash('2026-10-19T15:00:00.000Z', body)]);

    const before = await door.get('/api/compactions');
    assert.equal(before.json.compactions.length, 1);
    const id = before.json.compactions[0].id;

    rmSync(path);
    const after = await door.get('/api/compactions');
    assert.equal(after.status, 200);
    assert.deepEqual(after.json.compactions.map((r: any) => r.id), [id], 'still listed with its transcript gone');
    assert.equal(after.json.compactions[0].preview, 'Carving the lid for the owner Rock Cut stone.');
    const opened = await door.get(`/api/compactions/${id}`);
    assert.equal(opened.json.compaction.summary, body, 'and still readable in full');
  } finally {
    door.close();
    cleanup(house);
  }
});
