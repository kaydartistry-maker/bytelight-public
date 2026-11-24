#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter(Boolean);

const forbiddenPaths = [
  /^\.env$/, /^\.mcp\.json$/, /^CLAUDE\.md$/,
  /^bytelight\.ya?ml$/, /^(data|logs|memory-vault|prompts)(\/|$)/,
  /^\.(claude|agents)(\/|$)/,
  /(^|\/)skills\/(generating-pixie-art-in-chatgpt|rendering-opaline-reverie|routing-daily-telegram|importing-chatgpt-memory|controlling-lovense)(\/|$)/,
];
const privateIdentity = /\b(Knotts|Pixie|Zaden|Kevin|Freya|Alaina|Athena|Opaline)\b|House of Virelle|Cockliner/gi;
const personalName = /\bEmerald\b/g;
const hostIdentity = /\/root\/(?:virelle|bytelight|emerald)[^\s'"`]*|\/srv\/virelle[^\s'"`]*/gi;
const secrets = /sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{10,}|Bearer [A-Za-z0-9._~+/-]{20,}/g;

const failures = [];
for (const file of files) {
  if (forbiddenPaths.some((pattern) => pattern.test(file))) {
    failures.push(`${file}: forbidden private/runtime path`);
    continue;
  }
  const absolute = `${root}/${file}`;
  try {
    if (lstatSync(absolute).isSymbolicLink()) {
      const target = readlinkSync(absolute);
      if (target.startsWith('/')) failures.push(`${file}: absolute symlink target (${JSON.stringify(target)})`);
      continue;
    }
  } catch { continue; }
  let bytes;
  try { bytes = readFileSync(absolute); } catch { continue; }
  if (bytes.includes(0)) continue;
  if (file === 'scripts/publication-audit.mjs') continue;
  const text = bytes.toString('utf8');
  for (const [label, pattern] of [['private identity', privateIdentity], ['private identity', personalName], ['private host path', hostIdentity], ['credential pattern', secrets]]) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match) {
      const line = text.slice(0, match.index).split('\n').length;
      failures.push(`${file}:${line}: ${label} (${JSON.stringify(match[0])})`);
    }
  }
}

if (failures.length) {
  console.error(`PUBLICATION AUDIT FAILED (${failures.length})`);
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`PUBLICATION AUDIT PASSED (${files.length} files)`);
