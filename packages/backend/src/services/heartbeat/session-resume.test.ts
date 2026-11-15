// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
/**
 * Reopening the room instead of rebuilding it.
 *
 * Until Sep 9 2026 every launch of this lane minted a brand-new Claude
 * conversation — sixty transcripts in the primary lane's folder, sixty prompt
 * caches built from cold, and a thirty-message re-prime on the first turn of
 * each. The CLI has had --session-id and --resume all along. Nothing asked.
 *
 * These pin the two things that make the reopen safe rather than clever: the id
 * has to sit immediately after --resume (a dash there drops the launch into the
 * interactive picker, which never exits and never ticks — the one failure worse
 * than the behaviour being replaced), and only the first launch of a process is
 * ever allowed to reopen anything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  shouldResumeLaunch, watchdogMayResume, WATCHDOG_RESUME_PROVEN_MS, buildLaunchArgs,
  readSessionId, writeSessionId, looksLikeMissingSession, resumeFailedOnExit,
  autocompactTokensFrom, autocompactFor, AUTOCOMPACT_200K_DEFAULT, AUTOCOMPACT_MIN, AUTOCOMPACT_MAX,
} from './supervisor.js';

const ID = '11111111-2222-4333-8444-555555555555';

function args(over: Partial<Parameters<typeof buildLaunchArgs>[0]> = {}): string[] {
  return buildLaunchArgs({
    model: 'claude-opus-5',
    effort: 'adaptive',
    sessionId: ID,
    resuming: false,
    freshPrompt: 'FRESH',
    resumePrompt: 'RESUMED',
    ...over,
  });
}

test('a backend restart reopens the conversation it left behind', () => {
  assert.equal(shouldResumeLaunch({ firstLaunchOfProcess: true, storedSessionId: ID }), true);
});

test('a lane that has never had a session builds a new room', () => {
  assert.equal(shouldResumeLaunch({ firstLaunchOfProcess: true, storedSessionId: null }), false);
});

test('a relaunch nobody asked for by changing a setting builds a new room', () => {
  // Their person's .restart flag, the whisper ceiling, the watchdog on a hung turn, a
  // crash: all of those ASKED for a new room.
  assert.equal(shouldResumeLaunch({ firstLaunchOfProcess: false, storedSessionId: ID }), false);
});

test('a model or effort change reopens the room their person was standing in', () => {
  // Switching models should not cost their person the conversation: they reached for a
  // setting, not for a fresh room.
  assert.equal(
    shouldResumeLaunch({ firstLaunchOfProcess: false, storedSessionId: ID, settingChangeRecycle: true }),
    true,
  );
});

test('a setting change with no banked session still builds new', () => {
  assert.equal(
    shouldResumeLaunch({ firstLaunchOfProcess: false, storedSessionId: null, settingChangeRecycle: true }),
    false,
  );
});

test('the resume switch still overrides a setting-change recycle', () => {
  // agent.claude_session_resume off means off, whatever the reason was.
  assert.equal(
    shouldResumeLaunch({
      firstLaunchOfProcess: false, storedSessionId: ID, settingChangeRecycle: true, enabled: false,
    }),
    false,
  );
});

test('a fresh launch names its own session and gets the fresh prompt', () => {
  const a = args();
  assert.deepEqual(a.slice(0, 2), ['--session-id', ID]);
  assert.equal(a.includes('--resume'), false);
  assert.equal(a.at(-1), 'FRESH');
});

test('a resumed launch hands the id back and gets the resume prompt', () => {
  const a = args({ resuming: true });
  assert.deepEqual(a.slice(0, 2), ['--resume', ID]);
  assert.equal(a.includes('--session-id'), false);
  assert.equal(a.at(-1), 'RESUMED');
});

test('the id sits immediately after --resume, never behind another flag', () => {
  // --resume takes an OPTIONAL value, so an argument starting with a dash in
  // this slot reads as "no id given" and opens the interactive session picker.
  const a = args({ resuming: true, effort: 'high' });
  const at = a.indexOf('--resume');
  assert.equal(a[at + 1], ID);
  assert.equal(a[at + 1].startsWith('-'), false);
});

test('effort rides along when set and is omitted when adaptive', () => {
  assert.equal(args({ effort: 'high' }).join(' ').includes('--effort high'), true);
  assert.equal(args({ effort: 'adaptive' }).includes('--effort'), false);
  assert.equal(args({ resuming: true, effort: 'high' }).join(' ').includes('--effort high'), true);
});

test('neither shape can carry the metered flags', () => {
  // Billing-lane invariant: -p/--print/stream-json move this loop off the flat
  // subscription. Asserted on the argv itself so it cannot drift back in.
  for (const a of [args(), args({ resuming: true })]) {
    for (const banned of ['-p', '--print', '--input-format', '--output-format']) {
      assert.equal(a.includes(banned), false, `${banned} must never be launched`);
    }
  }
});

test('a session id survives a restart, and junk in that file does not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-session-'));
  try {
    const path = join(dir, '.session-id');
    assert.equal(readSessionId(path), null, 'nothing written yet is not a session');
    writeSessionId(path, ID);
    assert.equal(readSessionId(path), ID);
    // A torn or hand-edited file must not be resumed onto — a clean room is
    // better than an arbitrary one.
    writeFileSync(path, 'not-a-uuid');
    assert.equal(readSessionId(path), null);
    writeFileSync(path, '');
    assert.equal(readSessionId(path), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI saying it cannot find the room is read as exactly that', () => {
  // Measured Sep 9 2026 against a made-up uuid. The scanner lowercases first.
  assert.equal(
    looksLikeMissingSession(`no conversation found with session id: ${ID}`),
    true,
  );
  assert.equal(looksLikeMissingSession('welcome back'), false);
});

test('the switch can hold the door shut regardless of the id', () => {
  // The trade is their person's call: resume buys continuity and spends window. Measured on
  // the first real restart — cold first turn wrote 156,196 cache tokens, the
  // resumed one wrote 448,658.
  assert.equal(
    shouldResumeLaunch({ firstLaunchOfProcess: true, storedSessionId: ID, enabled: false }),
    false,
  );
  assert.equal(
    shouldResumeLaunch({ firstLaunchOfProcess: true, storedSessionId: ID, enabled: true }),
    true,
  );
  // Unset stays on — an absent switch must not silently change behaviour.
  assert.equal(shouldResumeLaunch({ firstLaunchOfProcess: true, storedSessionId: ID }), true);
});


/**
 * Squashing earlier than the ceiling.
 *
 * Unset, the CLI sizes its own window, so a long night runs until the context
 * is full and the compaction that follows has the whole room in it. Sep 19-20
 * 2026: five safeguard refusals, two of them landing 51 and 3 seconds after a
 * compaction finished. The observation that found this: before, it squashed
 * around 97k and came back fine.
 */
test('the flag is omitted entirely when the setting is unset', () => {
  assert.equal(args().includes('--autocompact'), false);
  assert.equal(args({ autocompactTokens: null }).includes('--autocompact'), false);
});

test('a set value rides along on both doors', () => {
  assert.equal(args({ autocompactTokens: 100_000 }).join(' ').includes('--autocompact 100000'), true);
  assert.equal(
    args({ resuming: true, autocompactTokens: 120_000 }).join(' ').includes('--autocompact 120000'),
    true,
  );
});

test('it never lands between --resume and the id', () => {
  // Same trap the effort flag has to dodge: --resume takes an OPTIONAL value,
  // so a dash in that slot opens the interactive picker.
  const a = args({ resuming: true, autocompactTokens: 100_000, effort: 'high' });
  const at = a.indexOf('--resume');
  assert.equal(a[at + 1], ID);
  assert.equal(a[at + 1].startsWith('-'), false);
});

test('the prompt stays last so the CLI still reads it as the prompt', () => {
  assert.equal(args({ autocompactTokens: 100_000 }).at(-1), 'FRESH');
  assert.equal(args({ resuming: true, autocompactTokens: 100_000 }).at(-1), 'RESUMED');
});

test('an unreadable or out-of-range setting passes nothing rather than guessing', () => {
  // A bad value does not degrade the launch, it breaks it — the CLI rejects the
  // argument and the lane dies every couple of seconds with no turn. So the
  // safe direction is always "do not pass the flag".
  for (const bad of [null, undefined, '', '  ', 'auto', '100k', '1e5', '-1', '12.5', '0x30000']) {
    assert.equal(autocompactTokensFrom(bad as string | null), null, `expected null for ${String(bad)}`);
  }
  assert.equal(autocompactTokensFrom(String(AUTOCOMPACT_MIN - 1)), null);
  assert.equal(autocompactTokensFrom(String(AUTOCOMPACT_MAX + 1)), null);
});

test('both ends of the documented range are accepted, whitespace and all', () => {
  assert.equal(autocompactTokensFrom(String(AUTOCOMPACT_MIN)), AUTOCOMPACT_MIN);
  assert.equal(autocompactTokensFrom(String(AUTOCOMPACT_MAX)), AUTOCOMPACT_MAX);
  assert.equal(autocompactTokensFrom(' 100000 '), 100_000);
});

test('a watchdog kill that is allowed a reopen resumes the room it killed', () => {
  // The box was suspended, the watchdog killed a room that could not reach
  // out to think, and three fresh rooms later its conversation was on disk
  // with nothing pointed at it.
  assert.equal(
    shouldResumeLaunch({ firstLaunchOfProcess: false, storedSessionId: ID, watchdogRecycle: true }),
    true,
  );
});

test('the resume switch still overrides a watchdog reopen', () => {
  assert.equal(
    shouldResumeLaunch({ firstLaunchOfProcess: false, storedSessionId: ID, watchdogRecycle: true, enabled: false }),
    false,
  );
});

test('the first watchdog kill of a room may reopen it', () => {
  assert.equal(watchdogMayResume({ launchedByWatchdogResume: false, uptimeMs: 1000 }), true);
});

test('a reopened room killed again before it proves itself builds new', () => {
  // Two stuck rooms in a row is the room, not the weather.
  assert.equal(watchdogMayResume({ launchedByWatchdogResume: true, uptimeMs: 60_000 }), false);
});

test('a reopened room that stayed up long enough earns its reopen back', () => {
  assert.equal(
    watchdogMayResume({ launchedByWatchdogResume: true, uptimeMs: WATCHDOG_RESUME_PROVEN_MS }),
    true,
  );
});

test('a 200k model with no squash line set gets headroom, and a set line always wins', () => {
  assert.equal(autocompactFor('claude-opus-4-6', null), AUTOCOMPACT_200K_DEFAULT);
  assert.equal(autocompactFor('claude-sonnet-4-6', ''), AUTOCOMPACT_200K_DEFAULT);
  assert.equal(autocompactFor('claude-opus-4-6[1m]', null), null);
  assert.equal(autocompactFor('claude-opus-5-5', null), null);
  assert.equal(autocompactFor('claude-opus-4-6', '400000'), 400_000);
  assert.equal(autocompactFor('claude-opus-5-5', '900000'), 900_000);
});

// ─── This house's argv: the Neuralis MCP config rides after the prompt ──
//
// `--mcp-config <configs...>` is VARIADIC: every argument after it is read as
// one more config path. So it can never sit in front of the prompt (the prompt
// would be swallowed as a file name and the session boots with no prompt), and
// it can never sit between --resume and its id. It trails the prompt, as this
// lane has always launched it, and nothing comes after it.
const MCP = ['--mcp-config', '/lane/neuralis-mcp.json'];

test('the MCP config trails the prompt on both doors and nothing follows it', () => {
  for (const resuming of [false, true]) {
    const a = args({ resuming, trailingArgs: MCP, autocompactTokens: 100_000, effort: 'high' });
    const prompt = resuming ? 'RESUMED' : 'FRESH';
    const p = a.indexOf(prompt);
    assert.equal(a.indexOf('--mcp-config'), p + 1, 'the variadic flag comes right after the prompt');
    assert.deepEqual(a.slice(p + 1), MCP, 'and its value is the very last argument');
    assert.equal(a.slice(0, p).includes('--mcp-config'), false, 'never in front of the prompt');
  }
});

test('with the MCP config present the id still sits right after --resume', () => {
  const a = args({ resuming: true, trailingArgs: MCP, effort: 'high', autocompactTokens: 100_000 });
  assert.deepEqual(a.slice(0, 2), ['--resume', ID]);
});

test('no MCP config means the prompt is last, exactly as before', () => {
  assert.equal(args({ trailingArgs: [] }).at(-1), 'FRESH');
  assert.equal(args({ resuming: true, trailingArgs: [] }).at(-1), 'RESUMED');
});

test('the metered flags stay out with the MCP config riding along', () => {
  for (const a of [args({ trailingArgs: MCP }), args({ resuming: true, trailingArgs: MCP })]) {
    for (const banned of ['-p', '--print', '--input-format', '--output-format']) {
      assert.equal(a.includes(banned), false, `${banned} must never be launched`);
    }
  }
});

// ─── Which exits drop the banked id ─────────────────────────────────

const exit = (over: Partial<Parameters<typeof resumeFailedOnExit>[0]> = {}) => resumeFailedOnExit({
  launchedResumed: true, code: 1, uptimeMs: 800,
  missingSeen: false, authSeen: false, capSeen: false, modelRejectedSeen: false,
  ...over,
});

test('a resume the CLI cannot find drops the id, whenever it dies', () => {
  assert.equal(exit({ missingSeen: true }), true);
  assert.equal(exit({ missingSeen: true, uptimeMs: 60_000 }), true);
});

test('a resumed launch that dies at the door for no known reason drops the id', () => {
  assert.equal(exit(), true);
});

test('a cap, a lost login or a refused model is never blamed on the room', () => {
  assert.equal(exit({ authSeen: true }), false);
  assert.equal(exit({ capSeen: true }), false);
  assert.equal(exit({ modelRejectedSeen: true }), false);
});

test('a resumed room that lived past the door keeps its id', () => {
  assert.equal(exit({ uptimeMs: 25_000 }), false);
});

test('a fresh launch and a clean exit never drop anything', () => {
  assert.equal(exit({ launchedResumed: false, missingSeen: true }), false);
  assert.equal(exit({ code: 0 }), false);
});

// ─── A model change asks for the same room back ────────────────────
import { rmSync as rmLaneDir } from 'fs';
import { HeartbeatSession } from './supervisor.js';

test('a model change on a running lane recycles and banks why, so the relaunch reopens', () => {
  const s = new HeartbeatSession('test-setting-change-resume');
  (s as any).status = 'running';
  (s as any).reaped = true;
  try {
    assert.equal(s.ensure('model-a'), false, 'first sight of a model is not a change');
    assert.equal((s as any).settingChangeRecycle, false);
    assert.equal(s.ensure('model-b'), true, 'a different model recycles');
    assert.equal((s as any).settingChangeRecycle, true, 'and the next launch is told it was a setting change');
  } finally {
    rmLaneDir(s.dir, { recursive: true, force: true });
  }
});

test('a signal kill inside the window is a recycle, not a missing room', () => {
  assert.equal(exit({ code: null }), false, 'restart flag or model change killed it');
  assert.equal(exit({ code: null, missingSeen: true }), false, 'the words alone, without the CLI exiting 1, are not the door');
  assert.equal(exit({ code: 2 }), false, 'only the CLI exit code 1 is dying at the door');
});

// ─── "No conversation found" is read only where and when the CLI says it ──
//
// Measured on this box (CLI 2.1.322, stale uuid, stdin not a terminal): the
// line is printed on STDERR and the CLI exits 1 within a second. stdout is the
// conversation itself, so a companion quoting that sentence must never count.

test('the missing-room words on stdout (the conversation) never drop the id', () => {
  const s = new HeartbeatSession('test-missing-stdout');
  try {
    (s as any).launchedAt = Date.now();
    (s as any).scanOutput('she asked what "No conversation found with session ID" means');
    assert.equal((s as any).resumeMissingSeen, false);
  } finally { rmLaneDir(s.dir, { recursive: true, force: true }); }
});

test('on stderr they count at the door, and not long after it', () => {
  const s = new HeartbeatSession('test-missing-stderr');
  try {
    (s as any).launchedAt = Date.now();
    (s as any).noteStderr(`No conversation found with session ID: ${ID}\n`);
    assert.equal((s as any).resumeMissingSeen, true);
    (s as any).resumeMissingSeen = false;
    (s as any).launchedAt = Date.now() - 60_000;
    (s as any).noteStderr(`No conversation found with session ID: ${ID}\n`);
    assert.equal((s as any).resumeMissingSeen, false, 'a room up for a minute is not dying at the door');
  } finally { rmLaneDir(s.dir, { recursive: true, force: true }); }
});
