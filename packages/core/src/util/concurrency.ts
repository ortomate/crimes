/**
 * Bounded-concurrency map for the scan's IO-heavy index builders.
 *
 * The index builders each open one file per candidate. `Promise.all` over
 * that list is unbounded by construction: on a repo with 20k source files
 * it asks the OS for 20k descriptors at once, and the failure mode is
 * `EMFILE` on the user's machine rather than anything the scan can
 * recover from. A fixed worker pool draining a shared cursor caps the
 * in-flight count without changing the result.
 *
 * `crimes`' own `unbounded_async_fanout` detector flags exactly this
 * shape, and flagged these builders on a self-scan. This module is the
 * bound it was asking for.
 */

/**
 * Default in-flight limit. Sized against the descriptor budget rather
 * than the CPU count: the work is `readFile` plus a parse, so the pool
 * exists to keep the fd count bounded, not to saturate cores. 32 keeps
 * throughput indistinguishable from unbounded on the fixtures while
 * staying an order of magnitude under the default `ulimit -n` on both
 * macOS (256) and Linux (1024).
 */
export const DEFAULT_IO_CONCURRENCY = 32;

/**
 * Apply `fn` to every item with at most `limit` calls in flight.
 *
 * Results come back in input order regardless of completion order —
 * callers depend on that for reproducible output. Rejections propagate
 * like `Promise.all`: the first one wins, though in-flight work is
 * allowed to settle rather than being abandoned mid-write.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  limit: number = DEFAULT_IO_CONCURRENCY,
): Promise<R[]> {
  if (items.length === 0) return [];
  const width = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;

  const drain = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < width; i += 1) workers.push(drain());
  await Promise.all(workers);

  return results;
}
