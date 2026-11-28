/**
 * Standalone ingest latency benchmark (#239).
 *
 * Usage:
 *   bun scripts/measure-ingest-latency.ts [path]
 *
 * `path` defaults to ~/four-turbo-tui. The benchmark uses a throwaway
 * BRAIN_HOME under /tmp (mkdtemp) so the real brain database is never touched.
 *
 * Event-loop lag is sampled every 10ms; the script reports duration and
 * max/p95/p99 lag and exits 1 when the maximum lag reaches 1000ms.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SAMPLE_INTERVAL_MS = 10;
const MAX_LAG_LIMIT_MS = 1000;

/** Nearest-rank percentile of an already sorted, ascending array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const idx = Math.min(sorted.length - 1, Math.max(0, rank));
  return sorted[idx];
}

async function main(): Promise<number> {
  const target = resolve(process.argv[2] ?? join(homedir(), "four-turbo-tui"));

  // Throwaway home — must be set before the config singleton is first read.
  const home = mkdtempSync(join(tmpdir(), "brain-ingest-bench-"));
  process.env.BRAIN_HOME = home;

  // Dynamic imports so module-level config reads see the temporary home.
  const { initBrainDatabase } = await import("../src/schema");
  const { ingestPath } = await import("../src/ingest");

  const db = initBrainDatabase();

  const lags: number[] = [];
  let maxLag = 0;
  let maxLagAt = 0;
  let last = performance.now();
  const samplerStart = last;

  const sampler = setInterval(() => {
    const now = performance.now();
    const lag = now - last - SAMPLE_INTERVAL_MS;
    last = now;
    if (lag > 0) {
      lags.push(lag);
      if (lag > maxLag) {
        maxLag = lag;
        maxLagAt = now - samplerStart;
      }
    }
  }, SAMPLE_INTERVAL_MS);

  const startedAt = Date.now();
  try {
    const result = await ingestPath(db, target);
    const durationMs = Date.now() - startedAt;

    clearInterval(sampler);
    lags.sort((a, b) => a - b);
    const p95 = percentile(lags, 95);
    const p99 = percentile(lags, 99);

    console.log(`path:      ${target}`);
    console.log(`files:     ${result.filesFound} (indexed ${result.filesIndexed}, skipped ${result.filesSkipped}, errors ${result.errors.length})`);
    console.log(`duration:  ${(durationMs / 1000).toFixed(1)} s`);
    console.log(`lag max:   ${maxLag.toFixed(0)} ms (at ${(maxLagAt / 1000).toFixed(1)} s)`);
    console.log(`lag p95:   ${p95.toFixed(0)} ms`);
    console.log(`lag p99:   ${p99.toFixed(0)} ms`);

    return maxLag >= MAX_LAG_LIMIT_MS ? 1 : 0;
  } finally {
    clearInterval(sampler);
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
}

process.exit(await main());
