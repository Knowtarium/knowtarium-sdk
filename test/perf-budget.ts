/// <reference types="vite/types/importMeta.d.ts" />
// Timing for the performance tests, robust to a busy machine. Every measurement runs warm-ups
// first and takes the median of several runs. Limits are written for a quiet CI runner; by default
// they are scaled by how slow this run is (a fixed CPU-bound workload timed in the same process,
// against its time on a quiet laptop) and given 3x slack, so parallel builds don't fail them,
// while a regression of an order of magnitude still does. KNOWTARIUM_PERF=strict (CI on a quiet
// runner) applies the limits as written. The correctness checks around them always run.

// the library has no DOM or Node types; every test runtime has these
declare const performance: { now(): number };

/** The calibration workload's median on a quiet laptop (Apple M-series, Node 24), in ms. */
const REFERENCE_MS = 6;
/** Extra room in relaxed mode, on top of the measured slowdown. */
const RELAXED_SLACK = 3;

/** Tokenizes, counts and sorts like the search index does: a stand-in for this run's speed. */
function workload(): number {
  const counts = new Map<string, number>();
  let text = "";
  for (let i = 0; i < 20_000; i++)
    text += `word${String((i * 7919) % 5003)} note-${String(i % 977)} `;
  for (const token of text.split(" ")) counts.set(token, (counts.get(token) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).length;
}

/** The median time of `runs` calls after `warmups` unmeasured ones, and the last result. */
export function measure<T>(
  run: () => T,
  options: { readonly warmups?: number; readonly runs?: number } = {},
): { readonly ms: number; readonly result: T } {
  for (let i = 0; i < (options.warmups ?? 1); i++) run();
  const times: number[] = [];
  let result!: T;
  for (let i = 0; i < (options.runs ?? 5); i++) {
    const start = performance.now();
    result = run();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { ms: times[Math.floor(times.length / 2)] ?? 0, result };
}

/** Whether limits apply as written (`KNOWTARIUM_PERF=strict`). */
export const strict = import.meta.env["KNOWTARIUM_PERF"] === "strict";

let slowdown: number | undefined;

/** How much slower than the quiet reference this run is (at least 1), measured once. */
export function calibration(): number {
  slowdown ??= Math.max(1, measure(workload, { warmups: 3, runs: 9 }).ms / REFERENCE_MS);
  return slowdown;
}

/** A limit in ms for this run: as written when strict, else scaled by the slowdown, with slack. */
export function budget(ms: number): number {
  return strict ? ms : ms * calibration() * RELAXED_SLACK;
}
