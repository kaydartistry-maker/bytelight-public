import { useState } from 'react';
export function PairDevice({ secret }: { secret: { current: string | null } }) {
  const [state, setState] = useState(secret.current ? 'ready' : 'invalid');
  async function pair() {
    if (state !== 'ready' || !secret.current) return;
    setState('pairing');
    try {
      const response = await fetch('/api/auth/pair', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: secret.current }) });
      setState(response.ok ? 'paired' : 'invalid');
    } catch { setState('invalid'); }
    finally { secret.current = null; }
  }
  return <main className="min-h-screen bg-slate-950 text-white p-8"><h1>Pair this device</h1><p>Pairing grants owner access on this browser. Only pair a device you control.</p>{state === 'ready' && <button onClick={() => void pair()}>Pair This Device</button>}{state === 'pairing' && <p>Pairing…</p>}{state === 'invalid' && <p>Pairing unavailable. Request a fresh owner pairing link.</p>}{state === 'paired' && <p>Device paired. <a href="/">Open BL</a></p>}</main>;
}
