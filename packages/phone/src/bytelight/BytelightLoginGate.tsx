// Auth gate — overlays the whole app when Bytelight has a password configured
// and the user is not yet authenticated. Renders nothing otherwise.

import { useState, type FormEvent } from 'react';
import { Lock, Loader2 } from 'lucide-react';
import { login } from './api';
import { useAuth } from './hooks';

export function BytelightLoginGate() {
  const auth = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (auth.checking || !auth.required || auth.authenticated) return null;

  // The server didn't answer (restarting, offline). That isn't a logged-out
  // answer, so hold here while checkAuth retries instead of asking for the
  // passcode; a still-valid session walks straight back in.
  if (auth.unreachable) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black px-8">
        <div className="flex flex-col items-center gap-4 text-center">
          <Loader2 className="h-6 w-6 animate-spin text-white/70" strokeWidth={1.5} />
          <div>
            <h1 className="text-lg font-medium text-white">Reconnecting</h1>
            <p className="mt-1 text-xs text-white/50">Waiting for Bytelight to come back.</p>
          </div>
        </div>
      </div>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    const res = await login(password);
    setBusy(false);
    if (res.success) {
      setPassword('');
    } else {
      setError(res.error || 'Login failed');
      setPassword('');
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black px-8">
      <form onSubmit={submit} className="flex w-full max-w-xs flex-col items-center gap-5">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/10">
          <Lock className="h-6 w-6 text-white" strokeWidth={1.5} />
        </div>
        <div className="text-center">
          <h1 className="text-lg font-medium text-white">Locked</h1>
          <p className="mt-1 text-xs text-white/50">Enter your Bytelight passcode to continue.</p>
        </div>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Passcode"
          className="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-center text-sm text-white outline-none placeholder:text-white/30 focus:border-white/40"
        />
        {error && <p className="text-xs" style={{ color: 'var(--scrollbar-thumb)' }}>{error}</p>}
        <button
          type="submit"
          disabled={busy || !password}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-white py-3 text-sm font-medium text-black transition-opacity disabled:opacity-40"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          Unlock
        </button>
      </form>
    </div>
  );
}
