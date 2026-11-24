/**
 * Style pictures riding a render.
 *
 * A look can carry up to six style pictures. When it does, those pictures go
 * to the image engine next to the cast's likeness pictures, and the engine is
 * told plainly which attached images are people (likeness) and which are
 * style (artistic execution only), so a style picture is never drawn as a
 * person. Looks with no pictures add nothing here: recipe words only.
 */

/** Most style pictures a single render carries (a look holds up to six). */
export const MAX_STYLE_REFS = 6;

// The style-reference instruction: style pictures say HOW the image is made,
// the written scene says WHAT it shows, and likeness pictures say WHO is in it.
export const STYLE_REFERENCE_INSTRUCTION = `Make one new image of my written scene, drawn in the artistic style shared by the attached style reference images.

The style references decide HOW the image is made: medium, rendering, line and edge quality, texture, color palette, lighting, level of detail and finish. My written scene decides WHAT the image shows. Never copy the people, faces, bodies, subjects or settings of the style references into the image.

Look at the style references together and find what they have in common, rather than repeating any single one. Then render every part of my scene, people, clothing, objects and background alike, in that shared style, so nothing looks pasted in from a different kind of picture.

If the style and the scene pull in different directions, keep the scene's content and the style's execution. Before finishing, check the image as a whole: it should read as if it belongs in the same set as the style references.`;

function range(from: number, to: number): string {
  return from === to ? `image ${from}` : `images ${from} to ${to}`;
}

/**
 * The block that tells the engine which attached images are which. Images are
 * attached likeness first, then style, so the numbers line up. Empty string
 * when there are no style pictures: nothing changes for a words-only look.
 */
export function styleReferenceBlock(likenessCount: number, styleCount: number): string {
  if (styleCount <= 0) return '';
  const likeness = likenessCount > 0
    ? `Attached ${range(1, likenessCount)} ${likenessCount === 1 ? 'is a LIKENESS reference' : 'are LIKENESS references'}: the people in the scene. Use them only for who the people are (face, hair, skin, build, tattoos), never for style.\n`
    : '';
  const style = `Attached ${range(likenessCount + 1, likenessCount + styleCount)} ${styleCount === 1 ? 'is a STYLE reference' : 'are STYLE references'}: use them only for artistic execution. They are not people in this scene.\n`;
  return `--- REFERENCE IMAGES ---\n${likeness}${style}--- END REFERENCE IMAGES ---\n\n--- STYLE REFERENCE INSTRUCTION ---\n${STYLE_REFERENCE_INSTRUCTION}\n--- END STYLE REFERENCE INSTRUCTION ---`;
}

/** Same labels when the engine gets file paths in text rather than attachments. */
export function styleReferencePathBlock(likenessPaths: string[], stylePaths: string[]): string {
  if (!stylePaths.length) return '';
  const likeness = likenessPaths.length
    ? `LIKENESS references (the people; for who they are, never for style): ${likenessPaths.join(', ')}.\n`
    : '';
  return `${likeness}STYLE references (artistic execution only; not people in this scene): ${stylePaths.join(', ')}.\n\n${STYLE_REFERENCE_INSTRUCTION}\n\n`;
}
