import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {BytelightProvider} from './bytelight';
import './index.css';
import {registerPhoneWorker} from './bytelight/push';

// Excalidraw is lazy-loaded by The Press. Set its self-hosted font root before
// that chunk can evaluate so no editor asset ever falls back to a CDN.
(window as typeof window & {EXCALIDRAW_ASSET_PATH?: string}).EXCALIDRAW_ASSET_PATH = `${import.meta.env.BASE_URL}excalidraw-assets/`;

// Claim /phone/ with the phone's own worker (notifications only — no fetch
// handling), so the Svelte client's worker at / doesn't control these pages.
// Skipped inside the native shell, where Capacitor owns notifications.
if (!(window as typeof window & {Capacitor?: {isNativePlatform?: () => boolean}}).Capacitor?.isNativePlatform?.()) {
  void registerPhoneWorker();
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BytelightProvider>
      <App />
    </BytelightProvider>
  </StrictMode>,
);
