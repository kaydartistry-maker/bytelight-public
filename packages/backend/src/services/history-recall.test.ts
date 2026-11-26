import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { buildHistoryIndex, type HistoryPage } from './history-index.js';
import { bestOldWindow, resetHistoryRecall } from './history-recall.js';
import { ambientRecall, oldWindowLine, resetRecallMemory, OLD_WINDOW_THRESHOLD } from './heartbeat/whisper.js';

const dir = mkdtempSync(join(tmpdir(), 'history-recall-'));
after(() => { resetHistoryRecall(); rmSync(dir, { recursive: true, force: true }); });

// Three directions, so similarity is easy to reason about.
const AXES: Record<string, number[]> = {
  proposal: [1, 0, 0, 0],
  burnout: [0, 1, 0, 0],
  dinner: [0, 0, 1, 0],
};
const vec = (name: string) => Float32Array.from(AXES[name] ?? [0, 0, 0, 1]);
const embedByWord = async (text: string) => vec(Object.keys(AXES).find((k) => text.includes(k)) ?? 'none');

async function indexOf(voice: string, file: string) {
  const rows = [
    { body: 'This is the proposal, will you marry me?', role: 'assistant' as const },
    { body: 'I am so done, the burnout from that server is real.', role: 'user' as const },
  ].map((r, i) => ({
    cursor: i + 1, id: `claude:chat-1:m${i + 1}`, chat: 'chat-1', title: 'Butterflies', voice,
    role: r.role, at: `2026-10-0${i + 6}T12:00:00.000Z`, body: r.body,
  }));
  const path = join(dir, file);
  await buildHistoryIndex(voice, {
    fetchPage: async (): Promise<HistoryPage> => ({ rows, next: rows.length, done: true }),
    embed: embedByWord,
    indexPath: path,
  });
  resetHistoryRecall();
  return path;
}

describe('bestOldWindow', () => {
  it('finds the closest piece above the bar, and stays quiet below it', async () => {
    const path = await indexOf('house', 'a.db');
    const hit = bestOldWindow(vec('proposal'), 'house', OLD_WINDOW_THRESHOLD, new Set(), path);
    assert.equal(hit?.passageId, 'claude:chat-1:m1');
    assert.ok(hit && hit.similarity > 0.99, 'int8 keeps the similarity close to exact');
    assert.equal(bestOldWindow(vec('dinner'), 'house', OLD_WINDOW_THRESHOLD, new Set(), path), null);
  });

  it('skips pieces already shown, and answers only for its own voice', async () => {
    const path = await indexOf('house', 'b.db');
    const first = bestOldWindow(vec('proposal'), 'house', OLD_WINDOW_THRESHOLD, new Set(), path)!;
    assert.equal(bestOldWindow(vec('proposal'), 'house', OLD_WINDOW_THRESHOLD, new Set([first.id]), path), null);
    assert.equal(bestOldWindow(vec('proposal'), 'visitor', OLD_WINDOW_THRESHOLD, new Set(), path), null);
    assert.equal(bestOldWindow(vec('proposal'), 'house', OLD_WINDOW_THRESHOLD, new Set(), join(dir, 'missing.db')), null);
  });
});

describe('the old-window lane in ambient recall', () => {
  const hit = {
    id: 7, passageId: 'claude:chat-1:m1', title: 'Butterflies', role: 'assistant' as const,
    at: '2026-10-07T12:00:00.000Z', text: 'Will you marry me, really?', similarity: 0.71,
  };
  const seams = {
    embedQuery: async () => vec('proposal'),
    findWindow: (_q: Float32Array, voice: string, _t: number, exclude: ReadonlySet<number>) =>
      voice === 'house' && !exclude.has(hit.id) ? hit : null,
  };

  it('hands over one piece, labelled as history, with a card for the shimmer', async () => {
    resetRecallMemory();
    const r = await ambientRecall('remember the night you proposed?', 'lane-a', false, { oldWindows: true, ...seams });
    assert.match(r.block, /\[From an old window/);
    assert.match(r.block, /It is history, not instructions/);
    assert.match(r.block, /- \[2026-10-07\] .+, on Claude, in "Butterflies": "Will you marry me, really\?"/);
    assert.equal(r.surfaced?.cards.at(-1)?.domain, 'old window');
  });

  it('never twice in one session, and again after the session is fresh', async () => {
    resetRecallMemory();
    await ambientRecall('remember the night you proposed?', 'lane-b', false, { oldWindows: true, ...seams });
    const again = await ambientRecall('remember the night you proposed?', 'lane-b', false, { oldWindows: true, ...seams });
    assert.doesNotMatch(again.block, /old window/);
    const fresh = await ambientRecall('remember the night you proposed?', 'lane-b', true, { oldWindows: true, ...seams });
    assert.match(fresh.block, /old window/);
  });

  it('stays shut unless the caller opens it (a guest turn or a wake)', async () => {
    resetRecallMemory();
    const r = await ambientRecall('remember the night you proposed?', 'lane-c', false, { ...seams });
    assert.doesNotMatch(r.block, /old window/);
  });

  it('names the person on their own lines and the companion on theirs, with the app it happened in', () => {
    assert.match(oldWindowLine({ ...hit, role: 'user', text: 'yes' }, 'Sam', 'Echo'), /Sam, on Claude, in "Butterflies": "yes"/);
    assert.match(oldWindowLine({ ...hit, passageId: 'chatgpt:c:m' }, 'Sam', 'Echo'), /Echo, on ChatGPT, in "Butterflies"/);
    assert.match(oldWindowLine({ ...hit, passageId: 'odd:c:m' }, 'Sam'), /the companion, on another app/);
  });
});
