// Read .env before anything else reads process.env.
//
// `npm start` and `npm run dev` from the project root run the backend through
// its workspace, so process.cwd() is packages/backend — but the setup wizard
// writes .env at the project root. Plain `dotenv/config` only looked in the
// working directory, so a fresh install started with `npm start` never saw
// the switches setup wrote (the Claude lane stayed off). The pm2 route starts
// from the root and was fine.
//
// Order: the working directory's .env first (so the pm2 route reads exactly
// what it always did), then the project root's. dotenv never overrides a
// value that is already set, so the shell environment always wins.
import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// packages/backend/src/load-env.ts (or dist/load-env.js) → ../../..
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function envFilesToLoad(cwd: string, root: string, exists: (p: string) => boolean = existsSync): string[] {
  const local = resolve(cwd, '.env');
  const rootEnv = join(root, '.env');
  const out: string[] = [];
  if (exists(local)) out.push(local);
  if (rootEnv !== local && exists(rootEnv)) out.push(rootEnv);
  return out;
}

for (const path of envFilesToLoad(process.cwd(), projectRoot)) {
  config({ path });
}
