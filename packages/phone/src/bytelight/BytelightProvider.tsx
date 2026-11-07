// Runs the Bytelight connection lifecycle: checks auth on mount, then connects
// the WebSocket once the user is authenticated (or auth is disabled).

import { useEffect, type ReactNode } from 'react';
import { checkAuth, stopAuthPolling } from './api';
import { connect, disconnect } from './socket';
import { useAuth } from './hooks';

export function BytelightProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();

  useEffect(() => {
    void checkAuth();
    return () => stopAuthPolling();
  }, []);

  useEffect(() => {
    if (auth.checking) return;
    const canConnect = auth.authenticated || !auth.required;
    if (canConnect) {
      connect();
      return () => disconnect();
    }
    disconnect();
  }, [auth.checking, auth.authenticated, auth.required]);

  return <>{children}</>;
}
