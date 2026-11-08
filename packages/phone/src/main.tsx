import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {ErrorBoundary} from './components/ErrorBoundary';
import {BytelightProvider} from './bytelight';
import './index.css';
import {registerPhoneWorker} from './bytelight/push';

// Excalidraw is lazy-loaded by The Press. Set its self-hosted font root before
// that chunk can evaluate so no editor asset ever falls back to a CDN.
(window as typeof window & {EXCALIDRAW_ASSET_PATH?: string}).EXCALIDRAW_ASSET_PATH = `${import.meta.env.BASE_URL}excalidraw-assets/`;

// Claim / with the phone's own worker (notifications only — no fetch
// handling). Registering at / also replaces the retired Svelte client's old
// worker there, so it stops controlling these pages.
// Skipped inside the native shell, where Capacitor owns notifications.
if (!(window as typeof window & {Capacitor?: {isNativePlatform?: () => boolean}}).Capacitor?.isNativePlatform?.()) {
  void registerPhoneWorker();
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BytelightProvider>
      <ErrorBoundary fullScreen>
        <App />
      </ErrorBoundary>
    </BytelightProvider>
  </StrictMode>,
);
