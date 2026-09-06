import { channel } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";

// Internal, opt-in developer instrumentation. No report fields, environment
// reads or output side effects. The benchmark subscribes in a Node preload.
const timings = channel("crimes.analysis.timing");

export async function profileAsync<T>(
  phase: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!timings.hasSubscribers) return operation();
  const started = performance.now();
  try {
    return await operation();
  } finally {
    timings.publish({ phase, duration_ms: performance.now() - started });
  }
}

export function profileSync<T>(phase: string, operation: () => T): T {
  if (!timings.hasSubscribers) return operation();
  const started = performance.now();
  try {
    return operation();
  } finally {
    timings.publish({ phase, duration_ms: performance.now() - started });
  }
}
