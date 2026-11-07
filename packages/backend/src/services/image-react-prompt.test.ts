/**
 * The "image landed" nudge must carry the picture's path on disk.
 *
 * The CLI lane never receives the queued render as an image block (only the SDK
 * path drains pending-visuals into image blocks), so the nudge saying "you can
 * see it now" was an empty hand. It worked for weeks only because the session
 * had learned to fetch the newest file itself; a compaction erased that habit
 * on 2026-10-31 and the react turn looked at nothing. The path makes the
 * lookup part of the contract instead of a habit.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildImageReactPrompt } from './image-react-prompt.js';

describe('buildImageReactPrompt', () => {
  it('names the file so a lane without image blocks can open it', () => {
    const p = buildImageReactPrompt('/srv/data/files/abc.png');
    assert.match(p, /\/srv\/data\/files\/abc\.png/);
    assert.match(p, /Do NOT generate another image/);
  });

  it('tells the lane to look before reacting when the picture was not shown', () => {
    const p = buildImageReactPrompt('/srv/data/files/abc.png');
    assert.match(p, /Read/);
  });

  it('still makes a usable nudge when the path is unknown', () => {
    const p = buildImageReactPrompt(null);
    assert.match(p, /Do NOT generate another image/);
    assert.doesNotMatch(p, /null|undefined/);
  });
});
