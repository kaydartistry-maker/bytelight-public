/** Studio saves files, never navigates to an image URL. Keep a tiny preview cache
 * so iOS can open its file-share sheet synchronously in the tap gesture. */
export type StudioSaveResult = 'shared' | 'downloaded' | 'cancelled' | 'ready';
export interface StudioSaveDependencies {
  baseUrl: string;
  fetchFile: (url: string, init: RequestInit) => Promise<Response>;
  canShare?: (data: ShareData) => boolean;
  share?: (data: ShareData) => Promise<void>;
  hasActivation?: () => boolean;
  nativeShare?: (file: File) => Promise<void>;
  download: (file: File) => void;
}
const MAX_BYTES = 64 * 1024 * 1024;
const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/avif': 'avif', 'video/mp4': 'mp4', 'video/webm': 'webm',
};

function fileName(name: string, mime: string) {
  const stem = name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 100) || 'studio-image';
  return `${stem}.${MIME_EXTENSIONS[mime]}`;
}

export function createStudioFileSaver(deps: StudioSaveDependencies) {
  const cache = new Map<string, Blob>();
  const pending = new Map<string, Promise<Blob>>();
  const controllers = new Set<AbortController>();
  let epoch = 0;
  const urlFor = (src: string) => {
    const url = new URL(src, deps.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== new URL(deps.baseUrl).origin) {
      throw new Error('Only images saved in this Studio can be downloaded here.');
    }
    url.searchParams.delete('download');
    return url.toString();
  };
  const prepare = async (src: string): Promise<Blob> => {
    const url = urlFor(src), cached = cache.get(url);
    if (cached) return Promise.resolve(cached);
    if (pending.has(url)) return pending.get(url)!;
    if (pending.size >= 3) throw new Error('Please wait for the current image downloads to finish.');
    const controller = new AbortController(), started = epoch;
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const operation = (async () => {
      const response = await deps.fetchFile(url, { credentials: 'include', signal: controller.signal });
      if (!response.ok) throw new Error(`Could not load the image for saving (HTTP ${response.status}).`);
      if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('This file is too large to save here.');
      const blob = await response.blob(), mime = blob.type.split(';')[0].toLowerCase();
      if (started !== epoch || controller.signal.aborted) throw new DOMException('Save preparation cancelled', 'AbortError');
      if (!MIME_EXTENSIONS[mime] || !blob.size) throw new Error('The server did not return a supported image or video file.');
      if (blob.size > MAX_BYTES) throw new Error('This file is too large to save here.');
      if (started === epoch && !controller.signal.aborted) {
        cache.set(url, blob);
        // Three files maximum, and never more than one file-size budget total.
        while (cache.size > 3 || [...cache.values()].reduce((n, b) => n + b.size, 0) > MAX_BYTES) {
          cache.delete(cache.keys().next().value!);
        }
      }
      return blob;
    })().finally(() => { clearTimeout(timeout); controllers.delete(controller); if (pending.get(url) === operation) pending.delete(url); });
    pending.set(url, operation);
    return operation;
  };
  const save = async (src: string, suggestedName: string): Promise<StudioSaveResult> => {
    const url = urlFor(src);
    // No await on a warm cache: preserve Safari's transient user activation.
    let blob = cache.get(url);
    const cold = !blob;
    if (!blob) blob = await prepare(src);
    const mime = blob.type.split(';')[0].toLowerCase();
    const file = new File([blob], fileName(suggestedName, mime), { type: mime });
    try {
      if (deps.nativeShare) { await deps.nativeShare(file); return 'shared'; }
      const data: ShareData = { files: [file] };
      if (deps.share && deps.canShare?.(data)) {
        if (deps.hasActivation?.() === false) return 'ready';
        try { await deps.share(data); return 'shared'; }
        catch (error) {
          // A fetched file is retained for the next tap if Safari lost the tap.
          if ((error as Error).name === 'NotAllowedError') {
            if (cold) return 'ready';
            throw new Error('The device blocked file sharing. Please try again with Studio open directly in the app or browser.');
          }
          throw error;
        }
      }
      deps.download(file);
      return 'downloaded';
    } catch (error) {
      if ((error as Error).name === 'AbortError' || /(?:user )?cancel(?:led|ed)/i.test((error as Error).message || '')) return 'cancelled';
      throw error;
    }
  };
  const clear = () => { epoch++; for (const c of controllers) c.abort(); controllers.clear(); pending.clear(); cache.clear(); };
  return { prepare, save, clear };
}

/** Local blob only. Never use the authenticated server URL as an anchor target. */
export function downloadStudioFile(file: File, documentObject = document, urls: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> = URL, schedule: (fn: () => void, ms: number) => unknown = setTimeout) {
  const anchor = documentObject.createElement('a');
  if (!('download' in anchor)) throw new Error('This browser cannot download files here. File sharing is unavailable.');
  const href = urls.createObjectURL(file);
  try {
    anchor.href = href; anchor.download = file.name;
    documentObject.body.appendChild(anchor); anchor.click();
  } finally {
    anchor.remove();
    // Safari needs the blob URL alive until its asynchronous save has started.
    schedule(() => urls.revokeObjectURL(href), 60_000);
  }
}

export async function shareNativeStudioFile(file: File) {
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([
    import('@capacitor/filesystem'), import('@capacitor/share'),
  ]);
  if (!(await Share.canShare()).value) throw new Error('File sharing is unavailable on this device.');
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not prepare the image for saving.'));
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.readAsDataURL(file);
  });
  const path = `studio-share-${crypto.randomUUID()}-${file.name}`;
  try {
    const written = await Filesystem.writeFile({ path, data, directory: Directory.Cache });
    await Share.share({ files: [written.uri], dialogTitle: 'Save image' });
  }
  finally { setTimeout(() => { void Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => {}); }, 60_000); }
}
