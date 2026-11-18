/**
 * Casting a spell that is already in the book: Run with…, Make it, Again,
 * Swap cast, Try a look, Surprise me, and the companions' spellbook_cast.
 * All of them come through prepareCast so the rules live in one place:
 *
 *  - Same number of people as the scene was written for → reuse the scene.
 *  - A different number, and the spell came from a dropped picture that is
 *    still here → read the picture again for that many people.
 *  - A different number and no picture (a vault prompt), or a vault prompt
 *    still waiting for its neutralize pass → Codex rewrites the words.
 *  - The look is a layer on top, so changing it never needs a re-read.
 */

import {
  listDrawers, isKnownDrawer, startGenerateJob, recordGalleryMeta, galleryDimensions, referencePaths, spellRenders,
  type SpellLineage,
} from './image-gen.js';
import {
  MAX_CAST, SpellbookError, engineSpellPrompt, fullPrompt, fullPromptNoNames, readSpell, tailorSceneToCast,
  sceneCastSize, sourcePath, type CastMember, type CastSeat, type ResolvedLook,
} from './spellbook.js';
import { markCast, resolveLook, type Spell } from './spellbook-store.js';

export const SIZES = new Set(['square', 'portrait', 'landscape', '16:9', '9:16', '4:5', '5:4', '2:3', '3:2']);

export function parseCast(raw: unknown): CastMember[] {
  let slugs: unknown = raw;
  if (typeof raw === 'string') {
    try { slugs = JSON.parse(raw); } catch { slugs = raw.split(','); }
  }
  if (!Array.isArray(slugs)) throw new SpellbookError('Pick who is in it.');
  const clean = [...new Set(slugs.filter((s): s is string => typeof s === 'string').map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (!clean.length) throw new SpellbookError('Pick at least one person to cast.');
  if (clean.length > MAX_CAST) throw new SpellbookError(`Up to ${MAX_CAST} people per spell.`);
  const drawers = listDrawers();
  return clean.map((slug) => {
    if (!isKnownDrawer(slug)) throw new SpellbookError(`There is no drawer called "${slug}".`);
    const d = drawers.find((x) => x.slug === slug);
    return { slug, label: d?.label ?? slug };
  });
}

export interface PreparedCast {
  lineage: SpellLineage;
  look: ResolvedLook;
  cast: CastMember[];
  /** Names written in, look on the end: what the operator copies. */
  prompt: string;
  /** Nobody's name, look on the end: the Discord-ready copy. */
  promptNoNames: string;
  /** What the image engine gets. */
  enginePrompt: string;
  /** True when the words were rewritten for a different cast. */
  rewritten: boolean;
  /** The look's style pictures, sent beside the cast's likeness pictures. */
  styleRefs: string[];
}

/** Each cast member with one reference picture, so the fitter can see who is
 *  who. A drawer with no pictures goes by name alone. */
export async function castSeats(cast: CastMember[]): Promise<CastSeat[]> {
  return Promise.all(cast.map(async (m) => {
    const refs = await referencePaths(m.slug).catch(() => [] as string[]);
    return { label: m.label, refPath: refs[0] };
  }));
}

/** A scene already fitted to exactly this cast, in this order, from an
 *  earlier render of the same spell: reuse it rather than ask again. */
async function fittedBefore(spellId: string, cast: CastMember[]): Promise<SpellLineage | null> {
  const list = (await spellRenders()).get(spellId) ?? [];
  const want = cast.map((m) => m.slug).join(',');
  return list.find((r) => r.spell.fitted && r.spell.cast.join(',') === want)?.spell ?? null;
}

/**
 * Every cast is fitted to who is in it. The scene's [Character N] order is
 * whatever the original author or reader happened to write, so filling slots
 * in order put a man in the ivory lace dress. Codex now sees one reference
 * picture per person and decides who plays which part and what they wear.
 *  - Same cast as an earlier fitted render of this spell → reuse that scene.
 *  - The spell came from a dropped picture that is still here → read the
 *    picture again with the cast in view.
 *  - Otherwise (vault prompts, or the picture is gone) → fit the words.
 */
export async function prepareCast(spell: Spell, cast: CastMember[], lookId?: unknown, opts: { justRead?: boolean } = {}): Promise<PreparedCast> {
  const look = resolveLook(lookId ?? spell.look);
  let scene = spell.scene;
  let title = spell.title;
  let rewritten = false;
  // justRead: the picture was read a moment ago with this cast in view.
  const cached = opts.justRead ? null : await fittedBefore(spell.id, cast);
  if (opts.justRead) {
    // scene is already fitted
  } else if (cached && sceneCastSize(cached.scene) === cast.length) {
    scene = cached.scene;
  } else {
    const seats = await castSeats(cast);
    const fromPicture = !spell.vault && spell.source ? sourcePath(spell.source) : null;
    const fresh = fromPicture
      ? await readSpell(fromPicture, cast.length, look, seats)
      : await tailorSceneToCast(spell.neutralized ? scene : (spell.originalText ?? scene), seats);
    scene = fresh.scene;
    if (!spell.title || spell.title === 'Untitled spell') title = fresh.title;
    rewritten = true;
  }
  const lineage: SpellLineage = {
    id: spell.id,
    title,
    scene,
    cast: cast.map((m) => m.slug),
    look: look.id,
    tags: spell.tags,
    source: spell.source ?? undefined,
    credit: spell.credit ?? undefined,
    link: spell.link ?? undefined,
    fitted: true,
  };
  return {
    lineage, look, cast, rewritten,
    styleRefs: look.keepPicture ? [] : (look.styleImages ?? []),
    prompt: fullPrompt(scene, cast, look),
    promptNoNames: fullPromptNoNames(scene, look),
    enginePrompt: engineSpellPrompt(scene, cast, look),
  };
}

/** Queue the render in Studio's one-at-a-time line and file the gallery card
 *  with its lineage. The spell counts as made once the picture exists. */
export function startStudioCast(p: PreparedCast, size: string | undefined): string {
  return startGenerateJob(
    { prompt: p.enginePrompt, subjects: p.cast.map((m) => m.slug), size, styleRefs: p.styleRefs.length ? p.styleRefs : undefined },
    async (result) => {
      const { width, height } = galleryDimensions(size);
      const now = new Date().toISOString();
      try { markCast(p.lineage.id, now); } catch (err) { console.warn('[spellbook] could not mark cast:', err); }
      await recordGalleryMeta(result.filename, {
        createdAt: now,
        prompt: p.prompt,
        model: result.model,
        backend: result.backend,
        width,
        height,
        aspectRatio: size || 'square',
        references: p.cast.map((m) => m.slug),
        spell: p.lineage,
      });
    },
  );
}

export function sourceUrl(source: string | null | undefined): string | null {
  return source ? `/api/studio/spellbook/sources/${encodeURIComponent(source)}` : null;
}
