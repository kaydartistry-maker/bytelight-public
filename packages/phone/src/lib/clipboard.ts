// One clipboard road for the whole phone.
//
// navigator.clipboard only exists in a secure context, and this app is served
// over plain HTTP on the LAN often enough that the fallback is the normal path
// rather than the exotic one. The APK's WebView can also refuse the write
// outright — so this returns a boolean and the caller SAYS SO, rather than
// flashing a tick over a clipboard that never took anything.
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const el = document.createElement('textarea');
    el.value = text;
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.focus();
    el.select();
    try {
      return document.execCommand('copy');
    } finally {
      document.body.removeChild(el);
    }
  } catch {
    return false;
  }
}
