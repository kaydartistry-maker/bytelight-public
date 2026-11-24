/** Call before rendering or network setup. The fragment is never sent to HTTP. */
export function takePairingToken(location: Pick<Location, 'hash' | 'pathname' | 'search'>, history: Pick<History, 'replaceState'>): string | null {
  if (location.pathname !== '/pair') return null;
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  history.replaceState(null, '', location.pathname + location.search);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}
