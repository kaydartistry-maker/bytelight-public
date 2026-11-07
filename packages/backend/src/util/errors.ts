// Shared error helpers.

/** Human-readable message for anything a `catch` can hand us. */
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
