import { channel } from "node:diagnostics_channel";
import { writeFileSync } from "node:fs";

// Loaded only by the developer benchmark, never by ordinary CLI users.
const phases = {};
channel("crimes.analysis.timing").subscribe(({ phase, duration_ms }) => {
  phases[phase] ??= { calls: 0, total_ms: 0 };
  const row = phases[phase];
  row.calls++;
  row.total_ms += duration_ms;
});
process.on("exit", () => {
  writeFileSync(process.env.CRIMES_BENCH_PHASES, JSON.stringify(phases));
});
