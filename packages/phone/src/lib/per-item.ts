/**
 * Run one request per item, in order, for actions the backend only exposes as a
 * single-item route. One failure does not stop the rest; the caller gets both
 * lists back and decides what to say about the misses.
 */
export async function runPerItem<T>(
  items: readonly T[],
  run: (item: T) => Promise<void>,
): Promise<{ done: T[]; failed: T[] }> {
  const done: T[] = [];
  const failed: T[] = [];
  for (const item of items) {
    try {
      await run(item);
      done.push(item);
    } catch {
      failed.push(item);
    }
  }
  return { done, failed };
}
