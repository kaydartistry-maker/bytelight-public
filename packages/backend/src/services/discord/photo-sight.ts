// Photos sent in Discord, opened into pictures for the turn.
//
// Stickers and custom emoji already reach the companions as pictures (the
// front door in inline-visuals.ts), but a photo attachment only ever became
// the word "[attachment]": nothing fetched it, so nobody could see it. This fetches each image
// attachment once, runs it through the same preparation an app upload gets,
// and hands back NormalizedImage[] for processMessage's `images`.

import type { NormalizedImage } from '../runtimes/types.js';
import { prepareVisionImageBuffer } from '../vision-image-preprocessor.js';
import { MAX_IMAGES_PER_TURN } from '../visual-blocks.js';
import { errMessage } from '../../util/errors.js';

/** Bigger than any photo worth seeing; refuse before downloading. */
export const MAX_DISCORD_PHOTO_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

/** The parts of a discord.js Attachment this needs. */
export interface DiscordPhotoAttachment {
  url: string;
  name?: string | null;
  contentType?: string | null;
  size?: number;
}

/** True when an attachment is a picture we can open. */
export function isPhotoAttachment(a: DiscordPhotoAttachment): boolean {
  if (a.contentType) return a.contentType.toLowerCase().startsWith('image/');
  return /\.(png|jpe?g|gif|webp)$/i.test(a.name ?? '');
}

export interface DiscordPhotoResult {
  images: NormalizedImage[];
  /** Plain notes for the turn: what was skipped and why. */
  notes: string[];
}

/**
 * Fetch and prepare the photos among `attachments`, in order, up to the
 * per-turn image cap. A photo that cannot be fetched or prepared is skipped
 * with a note; it never fails the turn.
 */
export async function discordPhotoImages(
  attachments: readonly DiscordPhotoAttachment[],
  fetchImpl: typeof fetch = fetch,
): Promise<DiscordPhotoResult> {
  const photos = attachments.filter(isPhotoAttachment);
  const images: NormalizedImage[] = [];
  const notes: string[] = [];

  for (const photo of photos.slice(0, MAX_IMAGES_PER_TURN)) {
    const name = photo.name || 'photo';
    if (typeof photo.size === 'number' && photo.size > MAX_DISCORD_PHOTO_BYTES) {
      notes.push(`[Vision warning: ${name} is too large to open, so it cannot be seen.]`);
      continue;
    }
    try {
      const res = await fetchImpl(photo.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > MAX_DISCORD_PHOTO_BYTES) throw new Error('too large');
      const prepared = await prepareVisionImageBuffer(bytes, name);
      if (prepared.image) images.push(prepared.image);
      if (prepared.warning) notes.push(prepared.warning);
      if (prepared.contextNote) notes.push(prepared.contextNote);
    } catch (error) {
      notes.push(`[Vision warning: ${name} could not be fetched from Discord (${errMessage(error)}), so it cannot be seen.]`);
    }
  }

  const over = photos.length - Math.min(photos.length, MAX_IMAGES_PER_TURN);
  if (over > 0) notes.push(`[Vision warning: ${over} more photo${over === 1 ? '' : 's'} exceeded the per-turn limit and cannot be seen.]`);
  return { images, notes };
}
