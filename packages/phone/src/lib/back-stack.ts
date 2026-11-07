/**
 * Who answers "back" first.
 *
 * The system back gesture and the back button both end up in one place, and
 * that place used to close the whole app — so an app with inner pages threw
 * away every step at once. Letters could be three deep in a letter and back
 * would put her on the home screen.
 *
 * An app that has somewhere inner to go registers a handler while that is
 * true. Back asks the TOP handler and stops if it says it dealt with it;
 * otherwise the app closes, exactly as before.
 *
 * Only the top handler is asked, deliberately. Walking down the stack until
 * somebody accepts would mean a screen answering for a screen above it, and
 * the top one is by definition the thing she is looking at.
 *
 * An app that registers nothing behaves precisely as it always has, which is
 * what makes this safe to wire one app at a time.
 */
export type BackHandler = () => boolean;

const stack: BackHandler[] = [];

/** Register a handler. Returns the function that takes it back off. */
export function pushBackHandler(handler: BackHandler): () => void {
  stack.push(handler);
  return () => {
    const at = stack.lastIndexOf(handler);
    if (at !== -1) stack.splice(at, 1);
  };
}

/**
 * Offer a back press to the innermost registered screen.
 * Returns true when something took it and the caller should do nothing more.
 */
export function runBackHandler(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  try {
    return top() === true;
  } catch {
    // A screen that throws on the way out must not trap her inside it.
    return false;
  }
}

/** Test seam only — a module-level stack outlives a test file otherwise. */
export function resetBackHandlersForTest(): void {
  stack.length = 0;
}
