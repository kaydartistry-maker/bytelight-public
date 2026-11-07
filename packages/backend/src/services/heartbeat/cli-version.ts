// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Which Claude Code this box runs, read once per backend process, so a lane's
// settings can turn on a newer setting only when the CLI knows it. A setting an
// older CLI does not understand is a risk to the whole settings file, and that
// file carries every lane hook, the guest gate included. Updates are the owner's and
// reach a lane on its next restart, which is also when the settings are
// rewritten, so reading once per process is enough.

import { spawnSync } from 'child_process';

let cached: [number, number, number] | null | undefined;

/** Parse '2.1.280 (Claude Code)' into [2, 1, 280]; null when unreadable. */
export function parseCliVersion(text: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when `have` is at least `want`. An unreadable version is never enough. */
export function atLeast(have: [number, number, number] | null, want: [number, number, number]): boolean {
  if (!have) return false;
  for (let i = 0; i < 3; i++) {
    if (have[i] !== want[i]) return have[i] > want[i];
  }
  return true;
}

export function claudeCliVersion(): [number, number, number] | null {
  if (cached !== undefined) return cached;
  try {
    const out = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 10_000 });
    cached = parseCliVersion(`${out.stdout ?? ''}`);
  } catch {
    cached = null;
  }
  return cached;
}
