import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

/**
 * The contact card was rendered behind `showContactInfo && (...)` and nothing in the
 * phone ever set it true — the header tap that opened it was repointed elsewhere on
 * Jun 9 2026, and the card was unreachable for eleven weeks before anyone went to open
 * it. An overlay with no opener compiles clean, renders nothing, and looks exactly like
 * a feature that works.
 */
test('every boolean overlay that gates a render has a way to be opened', () => {
  const all = sourceFiles(srcDir)
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');

  const declared = [...all.matchAll(/const \[(show[A-Z]\w*), (set[A-Z]\w*)\] = useState/g)];
  assert.ok(declared.length > 0, 'found no overlay state to check — the pattern moved');

  const unreachable: string[] = [];
  for (const [, stateName, setterName] of declared) {
    if (!new RegExp(`\\{\\s*${stateName}\\s*&&`).test(all)) continue;
    // Reachable = some call passes it anything other than a bare `false`. That covers
    // setX(true), setX(!x), setX(next) and setX(v => !v) without evaluating the argument.
    const calls = [...all.matchAll(new RegExp(`${setterName}\\(([^)]*)`, 'g'))];
    if (!calls.some(([, arg]) => arg.trim() !== 'false')) unreachable.push(stateName);
  }

  assert.deepEqual(unreachable, [], `overlays with no opener: ${unreachable.join(', ')}`);
});
