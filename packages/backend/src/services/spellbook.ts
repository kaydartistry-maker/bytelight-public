/**
 * Spellbook — drop a picture, cast yourselves into it.
 *
 * A picture goes in. Codex looks at it and writes the SCENE: pose, framing,
 * light, wardrobe, setting, mood. It deliberately leaves out who the person in
 * the picture is (face, hair, skin, tattoos, body), and writes the people as
 * numbered placeholders — [Character 1], [Character 2] — so the scene can be
 * recast with anyone without asking Codex again.
 *
 * Rule that never bends: the dropped picture goes ONLY to the reader. It is
 * never handed to the image engine as a reference. The only faces the engine
 * sees are the cast's own drawers.
 */

import { spawn } from 'child_process';
import { existsSync, promises as fs } from 'fs';
import { homedir, tmpdir } from 'os';
import { basename, dirname, extname, join } from 'path';
import crypto from 'crypto';
import { getConfig } from './db.js';
import { REFS_DIR } from './image-gen.js';

export const SPELLBOOK_SOURCES_DIR = join(dirname(REFS_DIR), 'spellbook-sources');

/** The two looks every house starts with. They are seeded into the looks
 *  table (services/spellbook-store.ts) and editable there like any other look;
 *  these are only the first-run values, and what tests resolve without a DB. */
export const LOOKS = {
  'grungy-film': {
    label: 'Grungy film',
    recipe: 'Grainy 35mm film photograph: visible grain, slightly crushed blacks, soft halation around highlights, muted warm color, a little grungy and imperfect, candid rather than polished. Not glossy digital, not airbrushed.',
  },
  keep: {
    label: "Keep the picture's look",
    recipe: '',
  },
} as const;
export type LookId = string;
export function isLookId(v: unknown): v is keyof typeof LOOKS {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(LOOKS, v);
}

/** A look as the reader and the engine use it. keepPicture means "describe
 *  the dropped picture's own style": nothing is layered on at render time.
 *  styleImages: the look's style pictures on disk, sent to the engine as
 *  style references at render time (empty or absent means words only). */
export interface ResolvedLook { id: string; name: string; recipe: string; keepPicture: boolean; styleImages?: string[] }

export function builtinLook(id: string): ResolvedLook | null {
  if (!isLookId(id)) return null;
  const l = LOOKS[id];
  return { id, name: l.label, recipe: l.recipe, keepPicture: id === 'keep' };
}

function asLook(look: string | ResolvedLook | null | undefined): ResolvedLook | null {
  if (!look) return null;
  return typeof look === 'string' ? builtinLook(look) : look;
}

export interface CastMember { slug: string; label: string }

/** A cast member as the scene-fitter sees them: a name and, when the drawer
 *  has one, a reference picture so it can tell who should play which part. */
export interface CastSeat { label: string; refPath?: string }

/** What the reader hands back, with the cast still as placeholders. */
export interface SpellScene {
  title: string;
  /** The scene, people written as [Character 1]…[Character N]. */
  scene: string;
  tags: string[];
}

export const MAX_CAST = 4;
const TOKEN = (n: number) => `[Character ${n}]`;

export function buildReaderPrompt(castCount: number, look: string | ResolvedLook, seats: CastSeat[] = []): string {
  const n = Math.max(1, Math.min(MAX_CAST, castCount));
  const tokens = Array.from({ length: n }, (_, i) => TOKEN(i + 1)).join(', ');
  // The look is its own layer, added when the spell is rendered, so a spell
  // can be tried in another look without reading the picture again.
  const lookRule = asLook(look)?.keepPicture
    ? "Describe the attached picture's own photographic style as part of the scene: film or digital, grain, color treatment, contrast, lens feel, lighting quality."
    : "Do not describe the attached picture's photographic style (film stock, grain, color grade, filters). Describe only what is in the scene and how it is lit and framed; the style is added separately.";

  return `You turn an inspiration picture into a reusable image-generation prompt.

Look at the attached picture. Write a prompt that recreates its SCENE with different people in it.

Keep: pose, body language, expression, framing, camera angle, lens feel, composition, setting, props, animals, wardrobe, lighting, mood.

Leave out completely — never describe these for any person: face or facial features, eye color, hair color, hair length or hairstyle, skin tone, ethnicity, age (beyond "adult"), body type or proportions, tattoos, piercings, birthmarks, makeup style. The people will be replaced by specific characters whose looks come from their own reference images.

People: there will be exactly ${n} ${n === 1 ? 'person' : 'people'} in the final image. Refer to them ONLY as ${tokens} — those exact tokens, brackets included, every time. Never use names, "the woman", "the man", "she" or "he" without the token nearby. If the picture shows fewer people than that, add the extra character(s) into the scene naturally. If it shows more, keep only the most important ones as characters and drop the rest or leave them as blurred background strangers.

${seatRule(seats, 2)}${lookRule}

All people are adults. No text, captions, logos or watermarks in the image.

Reply with ONLY one JSON object, no markdown fence, no commentary:
{"title": "a short evocative title, 2-6 words", "scene": "the full prompt, 80-180 words, one paragraph", "tags": ["3 to 6 short lowercase tags, e.g. nightlife, flash, gothic, couple"]}`;
}

/** Who is being cast, so parts and wardrobe go to the right person. firstImage
 *  is the attachment number their references start at. */
function seatRule(seats: CastSeat[], firstImage: number): string {
  if (!seats.length) return '';
  let img = firstImage;
  const lines = seats.map((seat, i) => {
    const ref = seat.refPath ? ` (attached image ${img++} is their reference picture)` : '';
    return `- ${TOKEN(i + 1)} is ${seat.label}${ref}`;
  });
  return `Who is being cast:
${lines.join('\n')}
Give each person the part that fits them as they look in their reference: who does what, who wears what. Dress each person the way they would actually dress. A man gets menswear: never a dress, skirt, lace, sheer or mesh top, corset, lingerie, heels or a makeup prop like lipstick; swap in his equivalent (an open shirt, a fitted tee, a leather jacket, tailored trousers) in the same palette and mood, and give any prop to whoever it suits. If the scene only has one kind of part and the cast is mixed, adapt the pose and wardrobe so it reads as natural for who is there. Their references are only for deciding parts and wardrobe — still never describe their face, hair, skin, body or tattoos.

`;
}

export function buildTailorPrompt(scene: string, seats: CastSeat[]): string {
  const n = Math.max(1, Math.min(MAX_CAST, seats.length));
  const tokens = Array.from({ length: n }, (_, i) => TOKEN(i + 1)).join(', ');
  return `Fit this image-generation prompt to the people who will be in it. The prompt below has its people as placeholders like [Character 1], or as generic people ("the woman", "[Name]", "a man"). Rewrite it for exactly ${n} ${n === 1 ? 'person' : 'people'}, written ONLY as ${tokens}, brackets included.

${seatRule(seats, 1)}Keep everything else: setting, props, pose ideas, framing, camera, light, film and colour treatment, mood. Keep engine flags like --ar. If the prompt asks to use or preserve a reference image, keep that instruction. Never write anyone's name, face, hair, skin tone, body type or tattoos.

Prompt:
${scene}

Reply with ONLY one JSON object, no markdown fence:
{"title": "a short evocative title, 2-6 words", "scene": "the fitted prompt", "tags": ["3 to 6 short lowercase tags"]}`;
}

/** Write the scene for THIS cast: who plays which part, who wears what. One
 *  Codex call that sees one reference picture per person. */
export async function tailorSceneToCast(scene: string, seats: CastSeat[]): Promise<SpellScene> {
  const images = seats.map((s) => s.refPath).filter((p): p is string => !!p);
  const raw = await runCodex(buildTailorPrompt(scene, seats), images, 150_000);
  return parseSpellScene(raw, seats.length);
}

/** Pull the reader's JSON out of whatever Codex printed around it. */
export function parseSpellScene(raw: string, castCount: number): SpellScene {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new SpellbookError('The reader did not return a prompt. Try reading it again.');
  let parsed: unknown;
  try { parsed = JSON.parse(raw.slice(start, end + 1)); }
  catch { throw new SpellbookError('The reader returned something unreadable. Try reading it again.'); }
  const o = parsed as Record<string, unknown>;
  const scene = typeof o.scene === 'string' ? o.scene.trim() : '';
  if (!scene) throw new SpellbookError('The reader came back without a scene. Try reading it again.');
  const title = (typeof o.title === 'string' && o.title.trim()) ? o.title.trim().slice(0, 80) : 'Untitled spell';
  const tags = Array.isArray(o.tags)
    ? o.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 8)
    : [];
  return { title, scene: ensureTokens(scene, castCount), tags };
}

/** If the reader forgot a token, the cast would silently lose someone. Name
 *  the missing ones at the end so every chosen person is in the picture. */
export function ensureTokens(scene: string, castCount: number): string {
  const missing: string[] = [];
  for (let i = 1; i <= castCount; i++) if (!scene.includes(TOKEN(i))) missing.push(TOKEN(i));
  return missing.length ? `${scene} ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} also in the scene.` : scene;
}

/** How many people the scene was written for: the highest [Character N] in it. */
export function sceneCastSize(scene: string): number {
  let max = 0;
  for (const m of scene.matchAll(/\[Character (\d+)\]/g)) max = Math.max(max, Number(m[1]));
  return max;
}

/** True when a recast needs the picture read again: the scene was written for
 *  a different number of people than the cast now holds. Swapping one person
 *  for another reuses the scene; adding or dropping someone does not. */
export function needsReRead(scene: string, castCount: number): boolean {
  return sceneCastSize(scene) !== castCount;
}

/** Last resort when the original picture is gone: name every cast member the
 *  scene has no place for, so nobody silently drops out of the render. */
export function fitSceneToCast(scene: string, castCount: number): string {
  return ensureTokens(scene, castCount);
}

/** The prompt with the cast's names written in. */
export function castNames(scene: string, cast: CastMember[]): string {
  let out = scene;
  cast.forEach((m, i) => { out = out.split(TOKEN(i + 1)).join(m.label); });
  return out;
}

/** The look's recipe as a closing paragraph, or nothing for "keep". */
export function lookLine(look: string | ResolvedLook | null | undefined): string {
  const l = asLook(look);
  return l && !l.keepPicture && l.recipe.trim() ? `\n\nLook: ${l.recipe.trim()}` : '';
}

/** The whole prompt to copy: the scene with names, then the look. */
export function fullPrompt(scene: string, cast: CastMember[], look?: string | ResolvedLook | null): string {
  return `${castNames(scene, cast)}${lookLine(look)}`;
}

/** The same prompt with nobody's name in it, for sharing. */
export function fullPromptNoNames(scene: string, look?: string | ResolvedLook | null): string {
  return `${scene}${lookLine(look)}`;
}

/** What goes to the image engine: names, the look, plus the identity rule. */
export function engineSpellPrompt(scene: string, cast: CastMember[], look?: string | ResolvedLook | null): string {
  const named = fullPrompt(scene, cast, look);
  const who = cast.map((m) => m.label).join(', ');
  return `${named}\n\nIdentity: ${who} must look exactly like their reference images — same face, hair, skin, build, tattoos. Recognizable likeness matters more than the scene.`;
}

export class SpellbookError extends Error {}

// ─── Source pictures ────────────────────────────────────────────────

const SOURCE_EXTS: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/heic': '.heic' };

export function sourceExtFor(mime: string): string | null {
  return SOURCE_EXTS[mime] ?? null;
}

export async function saveSource(buf: Buffer, mime: string): Promise<string> {
  const ext = sourceExtFor(mime);
  if (!ext) throw new SpellbookError('That file type is not a picture the reader can open.');
  await fs.mkdir(SPELLBOOK_SOURCES_DIR, { recursive: true });
  const name = `spell-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
  await fs.writeFile(join(SPELLBOOK_SOURCES_DIR, name), buf);
  return name;
}

/** Resolve a stored source by name — never a path the caller made up. */
export function sourcePath(filename: string): string | null {
  const name = basename(filename);
  if (name !== filename || !/^spell-\d+-[0-9a-f]{8}\.[a-z]+$/.test(name)) return null;
  if (!Object.values(SOURCE_EXTS).includes(extname(name))) return null;
  const p = join(SPELLBOOK_SOURCES_DIR, name);
  return existsSync(p) ? p : null;
}

// ─── The reader ─────────────────────────────────────────────────────

function codexBin(): string | null {
  const configured = getConfig('image_gen.codex_bin') || process.env.CODEX_BIN || join(homedir(), '.local', 'bin', 'codex');
  return existsSync(configured) ? configured : null;
}

/** Which model reads the picture. Settings key so a model retirement is an
 *  edit, not a deploy. Defaults to the same model Studio renders with. */
export function readerModel(): string {
  return getConfig('image_gen.spellbook_model') || getConfig('image_gen.codex_model') || 'gpt-6.1-sol';
}

/** Run Codex once: a prompt on stdin, optional pictures attached, and the
 *  last message back as text. Every Spellbook reader goes through here. */
export async function runCodex(prompt: string, images: string[] = [], timeoutMs = 180_000): Promise<string> {
  const bin = codexBin();
  if (!bin) throw new SpellbookError('Codex is not installed on the server, so the reader cannot run.');
  const outFile = join(tmpdir(), `byte-light-spell-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.txt`);
  const args = ['exec', '-m', readerModel(), '--ephemeral', '--skip-git-repo-check', '-o', outFile];
  for (const img of images) args.push('-i', img);
  args.push('-');
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, {
      env: { ...process.env, HOME: process.env.HOME || homedir() },
      cwd: tmpdir(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new SpellbookError('The reader took too long. Try again.')); }, timeoutMs);
    child.stdout?.on('data', () => { /* drain so codex never blocks on a full pipe */ });
    child.stderr?.on('data', (d) => { stderr += d.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', async (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0) { reject(new SpellbookError(`The reader failed (codex exited ${code}). ${stderr.trim().split('\n').pop() ?? ''}`.trim())); return; }
        resolve(await fs.readFile(outFile, 'utf-8'));
      } catch (err) { reject(err); }
      finally { fs.unlink(outFile).catch(() => {}); }
    });
    child.stdin?.end(prompt);
  });
}

export async function readSpell(imagePath: string, castCount: number, look: string | ResolvedLook, seats: CastSeat[] = []): Promise<SpellScene> {
  const refs = seats.map((s) => s.refPath).filter((p): p is string => !!p);
  const raw = await runCodex(buildReaderPrompt(castCount, look, seats), [imagePath, ...refs]);
  return parseSpellScene(raw, castCount);
}

// ─── Reading a style board ──────────────────────────────────────────

export const BOARD_READER_PROMPT = `These pictures are a style board. Ignore who is in them and what is happening. Write the photographic RECIPE they share, as an instruction for an image generator: film or digital, grain and texture, color palette and grade, contrast and blacks, light quality and direction, lens and depth of field, flash or no flash, era or mood. 40 to 90 words, one paragraph, no people, no names, no subject matter.

Reply with ONLY one JSON object, no markdown fence:
{"name": "a short name for this look, 1-4 words", "recipe": "the recipe"}`;

export async function readBoard(imagePaths: string[]): Promise<{ name: string; recipe: string }> {
  if (!imagePaths.length) throw new SpellbookError('Drop at least one picture on the board first.');
  const raw = await runCodex(BOARD_READER_PROMPT, imagePaths.slice(0, 6));
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new SpellbookError('The board reader came back empty. Try again.');
  try {
    const o = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const recipe = typeof o.recipe === 'string' ? o.recipe.trim() : '';
    if (!recipe) throw new Error('no recipe');
    return { name: typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 40) : 'New look', recipe: recipe.slice(0, 1200) };
  } catch {
    throw new SpellbookError('The board reader returned something unreadable. Try again.');
  }
}
