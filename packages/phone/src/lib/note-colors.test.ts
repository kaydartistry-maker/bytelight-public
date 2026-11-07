import assert from 'node:assert/strict';
import test from 'node:test';
import {
  blendOver,
  contrastRatio,
  hexToOklch,
  inkFor,
  noteColorsForAccent,
  oklchToHex,
  NOTE_ROLES,
  noteRoleToken,
  roleFromToken,
  resolveNoteColor,
  isNoteRole,
} from './note-colors.js';

// Every accent in the theme file, both modes (Amber was retired Aug 15 2026). If a palette rule ever regresses
// it should fail here rather than on her wall at six in the morning.
const ACCENTS: [string, string, string][] = [
  ['mocha', '#6B4E3D', '#A1887F'],
  ['monochrome', '#18181B', '#FAFAFA'],
  ['burgundy', '#722F37', '#8B3A42'],
  ['crimson', '#C8102E', '#C8102E'],
  ['rose', '#E11D48', '#F43F5E'],
  ['orange', '#EA580C', '#F97316'],
  ['forest', '#15803D', '#15803D'],
  ['emerald', '#059669', '#10B981'],
  ['teal', '#14B8A6', '#2DD4BF'],
  ['sky', '#38BDF8', '#7DD3FC'],
  ['ocean', '#0891B2', '#06B6D4'],
  ['sapphire', '#113285', '#4785F2'],
  ['cobalt', '#4A7AAB', '#8BA5C4'],
  ['lavender', '#A47DAB', '#C8A2C8'],
  ['plum', '#A21CAF', '#86198F'],
  ['magenta', '#DB2777', '#EC4899'],
  ['blush', '#FDA4AF', '#FDA4AF'],
];

test('oklch survives a round trip', () => {
  for (const hex of ['#F97316', '#1E3A5F', '#7C3AED', '#A1887F', '#FFFFFF', '#000000']) {
    const lch = hexToOklch(hex);
    assert.ok(lch, `${hex} should parse`);
    assert.equal(oklchToHex(lch!.l, lch!.c, lch!.h).toUpperCase(), hex.toUpperCase());
  }
});

test('every note in every theme can be written on', () => {
  const failures: string[] = [];
  for (const [name, light, dark] of ACCENTS) {
    for (const [mode, accent] of [['light', light], ['dark', dark]] as const) {
      for (const color of noteColorsForAccent(accent, mode)) {
        const ratio = contrastRatio(color, inkFor(color));
        if (ratio < 4) failures.push(`${name}/${mode} ${color} ${ratio.toFixed(1)}:1`);
      }
    }
  }
  assert.deepEqual(failures, [], `notes whose writing would not read: ${failures.join(', ')}`);
});

// The bug that started this: one font colour for every note. A pale note and a
// deep note must not be handed the same ink.
test('a pale note and a deep note take different ink', () => {
  assert.notEqual(inkFor('#FBE3D0'), inkFor('#1E3A5F'));
  assert.equal(inkFor('#FBE3D0'), '#17171B');
  assert.equal(inkFor('#1E3A5F'), '#F7F7F5');
});

// Orange and Mocha sit nine degrees apart in hue and used to produce the same
// palette, because the old recipe kept hue and discarded how vivid the theme is.
test('a vivid theme and a muted theme do not produce the same notes', () => {
  const orange = noteColorsForAccent('#F97316', 'dark');
  const mocha = noteColorsForAccent('#A1887F', 'dark');
  const orangeChroma = hexToOklch(orange[0])!.c;
  const mochaChroma = hexToOklch(mocha[0])!.c;
  assert.ok(orangeChroma > mochaChroma * 2, `orange ${orangeChroma} should be far more colourful than mocha ${mochaChroma}`);
  assert.notDeepEqual(orange, mocha);
});

// Perceptual lightness is the whole reason for OKLCH: at one target, a warm hue
// and a cool hue have to come out equally bright. In HSL they do not, which is
// what turned orange to mud at a darkness navy survived.
test('one lightness target reads evenly across hues', () => {
  const ratios = [30, 90, 145, 250, 320].map(h => contrastRatio(oklchToHex(0.72, 0.1, h), '#17171B'));
  assert.ok(Math.max(...ratios) - Math.min(...ratios) < 1.2, `spread too wide: ${ratios.map(r => r.toFixed(1)).join(', ')}`);
});

// The notes are drawn see-through, so the ink has to be decided against what
// actually lands rather than the colour on paper.
test('a light colour laid over a dark panel is treated as what it becomes', () => {
  const landed = blendOver('#FBE3D0', '#101014', 0.75);
  assert.ok(relativeIsDarkerThanSource(landed, '#FBE3D0'));
  assert.equal(inkFor(landed), '#17171B');
  const overDark = blendOver('#3A2A20', '#101014', 0.75);
  assert.equal(inkFor(overDark), '#F7F7F5');
});

function relativeIsDarkerThanSource(landed: string, source: string): boolean {
  return contrastRatio(landed, '#000000') < contrastRatio(source, '#000000');
}

// ── Roles instead of hexes ───────────────────────────────────────────────────
// A note used to store its literal colour, so changing theme
// slid the room out from under it and the note kept an orange nothing else had.

test('a role token resolves to that role\'s swatch in the current palette', () => {
  const warm = noteColorsForAccent('#e85d04', 'dark');
  const cool = noteColorsForAccent('#1e3a5f', 'dark');
  const token = noteRoleToken('quiet');
  const a = resolveNoteColor(token, warm);
  const b = resolveNoteColor(token, cool);
  assert.strictEqual(a, warm[NOTE_ROLES.indexOf('quiet')]);
  assert.strictEqual(b, cool[NOTE_ROLES.indexOf('quiet')]);
  assert.notStrictEqual(a, b, 'the same note must look different under a different theme');
});

test('every role survives a round trip through its token', () => {
  const palette = noteColorsForAccent('#7c3aed', 'light');
  NOTE_ROLES.forEach((role, i) => {
    assert.strictEqual(roleFromToken(noteRoleToken(role)), role);
    assert.strictEqual(resolveNoteColor(noteRoleToken(role), palette), palette[i]);
  });
});

test('a note written before roles existed still follows the theme', () => {
  const palette = noteColorsForAccent('#e85d04', 'dark');
  // Her real note from Aug 20, stored as a literal hex.
  const painted = resolveNoteColor('#c66936', palette);
  assert.ok(painted, 'a legacy hex must still paint');
  assert.ok(palette.includes(painted as string), 'and it must land on a swatch of the current palette');
});

test('junk is refused rather than painted', () => {
  const palette = noteColorsForAccent('#e85d04', 'dark');
  assert.strictEqual(resolveNoteColor('', palette), null);
  assert.strictEqual(resolveNoteColor(null, palette), null);
  assert.strictEqual(resolveNoteColor('bg-yellow-200', palette), null);
  assert.strictEqual(resolveNoteColor('role:nonsense', palette), null);
  assert.strictEqual(resolveNoteColor(noteRoleToken('quiet'), []), null);
});

test('isNoteRole only accepts the five real roles', () => {
  NOTE_ROLES.forEach(r => assert.ok(isNoteRole(noteRoleToken(r))));
  ['role:', 'role:banana', '#ffffff', 'quiet', '', null, undefined].forEach(v => {
    assert.strictEqual(isNoteRole(v as string), false, `${String(v)} must not read as a role`);
  });
});
