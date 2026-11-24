// Hand a file to the phone's share sheet (Slice 6b). In the APK that's
// Capacitor's Share (via a cache file); in the PWA the browser's share sheet
// when it can share files; otherwise a plain download.
import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

export type ShareResult = 'shared' | 'downloaded' | 'cancelled' | 'failed';

export async function shareTextFile(fileName: string, text: string, mime = 'application/json', title?: string): Promise<ShareResult> {
  try {
    if (Capacitor.isNativePlatform()) {
      const written = await Filesystem.writeFile({ path: fileName, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
      await Share.share({ title: title || fileName, files: [written.uri], dialogTitle: title || 'Share look' });
      return 'shared';
    }
    const file = new File([text], fileName, { type: mime });
    const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
    if (nav.canShare?.({ files: [file] }) && nav.share) {
      await nav.share({ files: [file], title: title || fileName });
      return 'shared';
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return 'downloaded';
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return /cancel|abort/i.test(msg) ? 'cancelled' : 'failed';
  }
}
