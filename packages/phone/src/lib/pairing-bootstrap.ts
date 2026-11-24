import { takePairingToken } from './pairing';
// This is the first main.tsx dependency: scrub before app/network modules evaluate.
export const pairingPage = window.location.pathname === '/pair';
let token = takePairingToken(window.location, window.history);
export function takeInitialPairingToken() { const result = token; token = null; return result; }
