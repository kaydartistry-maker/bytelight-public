import { useEffect, useRef } from 'react';
import { pushBackHandler } from './back-stack';

/**
 * Answer back from inside an app, while there is somewhere inner to go.
 *
 * `active` is the whole interface: register while she is deeper than the app's
 * own root and let go when she is not, so the app closes normally from its
 * front page. The handler is held in a ref so a screen re-rendering does not
 * churn the stack — only `active` changing moves anything.
 */
export function useBackHandler(active: boolean, handler: () => void): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!active) return;
    return pushBackHandler(() => { latest.current(); return true; });
  }, [active]);
}
