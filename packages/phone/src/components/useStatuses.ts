// Everyone's status from /api/status, for the home widget and the lock card
// alike. Read once a minute, and again the moment her sheet saves one.
import { useEffect, useState } from 'react';
import { apiFetch } from '../bytelight';
import { snapshotOf, type OwnerPresence, type StatusSnapshot } from '../lib/statuses';

const CHANGED = 'bytelight:status-changed';

export function useStatuses(): StatusSnapshot {
  const [snapshot, setSnapshot] = useState<StatusSnapshot>({ owner: null, companions: [] });
  useEffect(() => {
    let gone = false;
    const load = () => apiFetch('/api/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => { if (!gone && body) setSnapshot(snapshotOf(body)); })
      .catch(() => {});
    load();
    const timer = setInterval(load, 60_000);
    window.addEventListener(CHANGED, load);
    return () => { gone = true; clearInterval(timer); window.removeEventListener(CHANGED, load); };
  }, []);
  return snapshot;
}

/** Save her status (presence null clears it). True when it was kept. */
export async function saveOwnerStatus(body: { presence: OwnerPresence | null; line?: string; tags?: string[]; clearsAt?: string | null }): Promise<boolean> {
  try {
    const r = await apiFetch('/api/status/me', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.ok) window.dispatchEvent(new Event(CHANGED));
    return r.ok;
  } catch {
    return false;
  }
}
