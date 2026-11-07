import type { CapacitorConfig } from '@capacitor/cli';
import { readFileSync } from 'fs';
import { join } from 'path';

// Thin-shell mode: the APK is a native frame around the served phone app,
// so UI updates ship with every vite build — the shell only rebuilds when
// native capabilities change.
//
// The served URL is deployment-specific and lives in the gitignored
// server-url.local (see server-url.local.example). It must be HTTPS:
// the WebView refuses getUserMedia (voice mic) from a cleartext origin.
// With no file present the shell falls back to bundled assets.
let serverUrl: string | undefined;
try {
  serverUrl = readFileSync(join(process.cwd(), 'server-url.local'), 'utf-8').trim() || undefined;
} catch {
  serverUrl = undefined;
}

const config: CapacitorConfig = {
  appId: 'com.bytelight.phone',
  appName: 'Bytelight',
  webDir: 'dist',
  ...(serverUrl ? { server: { url: serverUrl } } : {}),
  plugins: {
    // The shell opts out of edge-to-edge (styles.xml), so Android already
    // shrinks the window above the keyboard. Capacitor's SystemBars insets
    // handling padded the view by the keyboard's height AGAIN, leaving the app
    // a strip the height of the message box over a gray window. Android's own
    // resize is the one the web app was built for (it is what Chrome does);
    // the system bars sit outside the window, so there is no safe area to inject.
    SystemBars: { insetsHandling: 'disable' },
  },
};

export default config;
