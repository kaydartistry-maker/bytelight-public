import type { GeneratedImage } from './types';

export function galleryItemToImage(item: any): GeneratedImage {
  const referenceDrawers = Array.isArray(item.referenceDrawers)
    ? item.referenceDrawers
    : Array.isArray(item.references)
      ? item.references
      : [];
  return {
    id: String(item.filename ?? item.id ?? ''),
    src: String(item.url ?? item.src ?? ''),
    prompt: typeof item.prompt === 'string' ? item.prompt : '',
    sourcePrompt: typeof item.sourcePrompt === 'string' ? item.sourcePrompt : undefined,
    styleId: typeof item.styleId === 'string' ? item.styleId : undefined,
    model: typeof item.model === 'string' && item.model ? item.model : 'gpt-image-2',
    backend: typeof item.backend === 'string' && item.backend ? item.backend : 'codex',
    width: Number(item.width) || 1024,
    height: Number(item.height) || 1024,
    timestamp: typeof item.createdAt === 'number'
      ? item.createdAt
      : new Date(item.createdAt ?? Date.now()).getTime(),
    folderId: typeof item.folderId === 'string' ? item.folderId : undefined,
    aspectRatio: typeof item.aspectRatio === 'string' ? item.aspectRatio : undefined,
    references: referenceDrawers,
    referenceDrawers,
    mediaType: item.mediaType === 'video' ? 'video' : 'image',
    threadId: typeof item.threadId === 'string' && item.threadId ? item.threadId : undefined,
    messageId: typeof item.messageId === 'string' && item.messageId ? item.messageId : undefined,
    threadName: typeof item.threadName === 'string' && item.threadName ? item.threadName : undefined,
  };
}

/**
 * The gallery route returns the whole gallery and takes no query, so folder and
 * subject views are cut from that one list here, the same two filters the
 * desktop Studio gallery applies.
 */
export function filterGallery(
  items: GeneratedImage[],
  folderId: string,
  subject: string,
): GeneratedImage[] {
  return items.filter((image) =>
    (!folderId || image.folderId === folderId)
    && (!subject || (image.references ?? []).includes(subject)));
}

export async function copyStudioText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}
