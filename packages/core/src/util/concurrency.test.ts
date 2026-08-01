import { describe, expect, it } from "vitest";
import { DEFAULT_IO_CONCURRENCY, mapWithConcurrency } from "./concurrency.js";

/** Resolve on the next macrotask so interleaving is observable. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("mapWithConcurrency", () => {
  it("returns results in input order, not completion order", async () => {
    const items = [30, 20, 10, 0];
    const out = await mapWithConcurrency(
      items,
      async (ms) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
        return ms;
      },
      4,
    );
    expect(out).toEqual([30, 20, 10, 0]);
  });

  it("never exceeds the limit in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 50 }, (_, i) => i);

    await mapWithConcurrency(
      items,
      async (i) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await tick();
        inFlight -= 1;
        return i;
      },
      4,
    );

    expect(peak).toBe(4);
  });

  it("still visits every item when the limit exceeds the input length", async () => {
    const seen: number[] = [];
    const out = await mapWithConcurrency(
      [1, 2, 3],
      async (n) => {
        await tick();
        seen.push(n);
        return n * 2;
      },
      100,
    );
    expect(out).toEqual([2, 4, 6]);
    expect(seen.sort()).toEqual([1, 2, 3]);
  });

  it("passes the input index to the callback", async () => {
    const out = await mapWithConcurrency(
      ["a", "b", "c"],
      async (item, i) => `${i}${item}`,
      2,
    );
    expect(out).toEqual(["0a", "1b", "2c"]);
  });

  it("handles an empty input without spawning workers", async () => {
    let calls = 0;
    const out = await mapWithConcurrency(
      [],
      async () => {
        calls += 1;
        return 1;
      },
      8,
    );
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  it("treats a non-positive limit as serial rather than spinning", async () => {
    let peak = 0;
    let inFlight = 0;
    await mapWithConcurrency(
      [1, 2, 3, 4],
      async (n) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await tick();
        inFlight -= 1;
        return n;
      },
      0,
    );
    expect(peak).toBe(1);
  });

  it("propagates a rejection", async () => {
    await expect(
      mapWithConcurrency(
        [1, 2, 3],
        async (n) => {
          if (n === 2) throw new Error("boom");
          return n;
        },
        2,
      ),
    ).rejects.toThrow("boom");
  });

  it("defaults to a limit an order of magnitude under the macOS fd budget", () => {
    expect(DEFAULT_IO_CONCURRENCY).toBeLessThan(256);
    expect(DEFAULT_IO_CONCURRENCY).toBeGreaterThan(1);
  });
});
