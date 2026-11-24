import { lstatSync, realpathSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { StudioStyleError, resolveImageModel } from './studio-styles.js';
import type { GenerateInput } from './image-gen.js';
import sharp from 'sharp';

// User's fixed prompts. Keep the wording verbatim; controls are separate.
export const FACE_TRANSPLANT_PROMPT = `Edit Image 1 to depict the facial identity of the person in Image 2, illustrated entirely in Image 1’s original art style.
The character in Image 1 should become recognizably the person in Image 2 while retaining the original artist’s complete visual interpretation.
FACIAL IDENTITY
Use Image 2 to understand the person’s distinctive facial anatomy, including their facial silhouette, eye contours and spacing, eyebrow structure, nose shape, lip contours, cheekbones, jawline, and the proportional relationships between these features.
Actively reinterpret the facial anatomy of the character in Image 1 to reflect this identity.
Make the changes substantial enough to establish a recognizable likeness, while expressing every change through the original artwork’s stylized proportions and rendering conventions.
ARTISTIC TRANSLATION
Treat Image 2 as anatomical reference information, never as visual material to reproduce.
Retain Image 1’s original artistic exaggerations, simplified anatomy, eye scale, feature design, brushwork, shading, softness, textures, and level of detail.
For example, when adapting the eyes, preserve their original illustrated size, dramatic exaggeration, and artistic construction while reshaping their underlying contours and relationships to resemble the person in Image 2.
Apply this principle consistently to the nose, mouth, cheeks, jawline, and overall facial structure.
The result should look like a new facial identity drawn by the original artist using the original character design.
ABSOLUTE PRESENTATION PRESERVATION
Image 1 exclusively determines:
* Head angle, pose, perspective, and gaze
* Facial expression
* Skin tone and complexion
* All original makeup, including eyeshadow, eyeliner, lashes, blush, and lip color
* Hairstyle, hair color, and hair placement
* Lighting, color grading, texture, and artistic finish
* Body, clothing, accessories, environment, and composition
Maintain the exact original cosmetic design, including its colors, shapes, placement, intensity, and artistic rendering.
EDITING SCOPE
Reinterpret the underlying facial identity across the entire face while keeping the surrounding artwork intact.
Preserve the original illustration’s visual construction and distinctive stylization.
Integrate the new facial identity seamlessly into the original painted face, as though the artist had always intended to portray the person in Image 2.
SUCCESS CRITERIA
The resulting face must be visibly recognizable as the person in Image 2.
The artwork must remain unmistakably Image 1, including its original makeup, facial exaggeration, expression, colors, and rendering style.
Change WHO the artist depicted. Preserve HOW the artist depicted them.
Produce one cohesive edited image.`;

export const SMASH_PROMPT = `Use Image 1 and Image 2 as equal visual references to create one new original image that feels like the natural “visual offspring” of both images.
Do not place the images side by side. Do not create a collage. Do not copy one image and add random details from the other. Instead, seamlessly blend the strongest traits from both references into one cohesive new design.
The final image should feel like it belongs to the same artistic universe as both references, combining their shared mood, style, color palette, lighting, composition, subject design, textures, and atmosphere in a balanced way. Preserve the most recognizable visual qualities of each image, but reinterpret them into one unified result.
Aim for a smooth 50/50 fusion unless one image clearly provides the main subject and the other provides the style or atmosphere. The result should look intentional, polished, and naturally designed, as if a single artist created a brand-new piece inspired equally by both images.
Prioritize cohesion over literal copying. Make the blend elegant, seamless, and visually harmonious. The final image should not look hodgepodge, mismatched, pasted together, overcomplicated, or like separate elements were forced into one picture.
Negative prompt: collage, split image, side-by-side comparison, pasted elements, mismatched art styles, clashing colors, random details, chaotic composition, copy of one image, low-quality blend, distorted anatomy, inconsistent lighting, uneven rendering, awkward fusion, hodgepodge.`;

export interface StudioTransformation {
  kind: 'face-transplant' | 'smash';
  imageCount: number;
  faceAssignments?: string;
}

function optionalText(value: unknown, name: string, limit: number): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > limit) throw new StudioStyleError(`${name} must be text, up to ${limit} characters.`);
  return value.trim();
}

/** This request builder is the sole HTTP admission point for trusted role data. */
export async function prepareTransformationRequest(body: unknown, uploadsDir: string): Promise<GenerateInput> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StudioStyleError('Invalid transformation request.');
  const b = body as Record<string, unknown>;
  if (b.kind !== 'face-transplant' && b.kind !== 'smash') throw new StudioStyleError('Choose Face Transplant or Smash & Mash.');
  const count = Array.isArray(b.images) ? b.images.length : 0;
  if (!Array.isArray(b.images) || (b.kind === 'smash' ? count !== 2 : count !== 2 && count !== 3)) throw new StudioStyleError(b.kind === 'smash' ? 'Smash & Mash needs exactly two images.' : 'Face Transplant needs a base image and one or two face images.');
  const images = b.images.map(token => {
    if (typeof token !== 'string' || token.length > 160 || token !== basename(token) || !/^\d{13}-[a-f0-9]{6}-[A-Za-z0-9_-]+\.(png|jpe?g|webp|gif)$/.test(token) || !['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extname(token))) throw new StudioStyleError('Choose valid uploaded transformation images.');
    const file = join(uploadsDir, token);
    try {
      if (!lstatSync(file).isFile() || realpathSync(file) !== join(realpathSync(uploadsDir), token)) throw Error();
    } catch { throw new StudioStyleError('A transformation image is missing. Upload it again.'); }
    return token;
  });
  const metadata = await Promise.all(images.map(async token => {
    try {
      const meta = await sharp(join(uploadsDir, token), { limitInputPixels: 40_000_000 }).metadata();
      if (!meta.width || !meta.height || !['png', 'jpeg', 'webp', 'gif'].includes(meta.format ?? '')) throw Error();
      return meta;
    } catch { throw new StudioStyleError('A transformation image could not be read. Use PNG, JPEG, WebP or GIF under 40 megapixels.'); }
  }));
  const additionalEdits = optionalText(b.additionalEdits, 'Additional edits', 4000);
  const faceAssignments = optionalText(b.faceAssignments, 'Face assignments', 1000);
  if (b.kind === 'smash' && (additionalEdits || faceAssignments)) throw new StudioStyleError('Additional edits and face assignments belong to Face Transplant only.');
  if (b.kind === 'face-transplant' && count === 3 && !faceAssignments) throw new StudioStyleError('Assign Image 2 and Image 3 to the people in Image 1.');
  if (b.imageModelId !== undefined && typeof b.imageModelId !== 'string') throw new StudioStyleError('Choose an image model.');
  const model = resolveImageModel(b.imageModelId as string | undefined ?? 'subscription-auto');
  const transformation: StudioTransformation = { kind: b.kind, imageCount: count, ...(faceAssignments ? { faceAssignments } : {}) };
  const fixed = b.kind === 'face-transplant' ? FACE_TRANSPLANT_PROMPT : SMASH_PROMPT;
  const edits = additionalEdits ? `\n\nADDITIONAL REQUESTED EDITS\nApply these explicit edits as exceptions to the preservation rules above; keep everything else preserved:\n${additionalEdits}` : '';
  let size: string | undefined;
  if (b.kind === 'face-transplant') {
    try {
      const meta = metadata[0];
      if (!meta.width || !meta.height) throw Error();
      const rotated = meta.orientation !== undefined && meta.orientation >= 5;
      const ratio = rotated ? meta.height / meta.width : meta.width / meta.height;
      // Image providers expose discrete output shapes, not arbitrary base pixels.
      // Match the base's closest supported frame rather than the global default.
      const choices = [['square', 1], ['portrait', 2 / 3], ['landscape', 3 / 2], ['16:9', 16 / 9], ['9:16', 9 / 16], ['21:9', 21 / 9], ['4:5', 4 / 5], ['5:4', 5 / 4]] as const;
      size = [...choices].sort((a, z) => Math.abs(Math.log(a[1] / ratio)) - Math.abs(Math.log(z[1] / ratio)))[0][0];
    } catch { throw new StudioStyleError('The base image could not be read. Upload a supported image under 40 megapixels.'); }
  }
  return { usageOrigin: 'studio', styleId: '', subjects: [], oneOffRefs: images, imageModelId: model.id, prompt: fixed + edits, transformation, ...(size ? { size } : {}) };
}

export function transformationReferenceGuidance(value: StudioTransformation): string {
  if (value.kind === 'smash') return 'The attached images are ordered Image 1 then Image 2, equal visual parents for Smash & Mash. Neither is a character drawer or a style-only reference. Use both for the fixed fusion instructions. Generate only the single final combined image; do not create intermediate images or collages.';
  return `The attached images are ordered: Image 1 is the base artwork to edit; Image 2 is the first facial identity reference.${value.imageCount === 3 ? ' Image 3 is a second, different facial identity reference. Apply the fixed Image 2 facial-identity and style-preservation instructions independently to each assigned person, using the appropriate identity image.' : ''}${value.faceAssignments ? `\nFACE ASSIGNMENTS\n${value.faceAssignments}\nPreserve the identity of every unassigned person.` : ''}\nImage 1 determines the artwork and presentation, subject to explicitly requested additional edits. Face references supply identity, never the whole composition or their photographic rendering. Generate only one final edited image, with no intermediate images or reference sheets.`;
}
