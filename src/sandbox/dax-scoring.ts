import type { DaxBenchmarkResult, DaxStats } from './dax-types.js';

/**
 * Ceilings used to normalize each metric to a 0-100 scale. These are rough
 * "excellent vs. poor" bounds, not hard physical limits — tune once real
 * numbers come in across providers.
 */
const DISK_MBPS_CEILING = 20_000;       // ~2.5 GB/s sequential, local-NVMe territory
const FSYNC_LATENCY_CEILING_MS = 50;    // local NVMe fsync is sub-ms; 50ms+ reads as networked/remote
const CPU_OPS_CEILING = 500_000;        // single-core SHA-256(1KB) rounds/sec, fast bare-metal core
const STEAL_CEILING_PERCENT = 20;       // 20%+ steal reads as heavily nested/contended
const PAUSE_RESUME_CEILING_MS = 10_000; // same order of magnitude as the TTI ceiling

/** Higher-is-better metric, linear against a ceiling. */
function scoreUp(value: number, ceiling: number): number {
  return Math.max(0, Math.min(100, 100 * (value / ceiling)));
}

/** Lower-is-better metric, linear against a ceiling. */
function scoreDown(value: number, ceiling: number): number {
  return Math.max(0, 100 * (1 - value / ceiling));
}

/**
 * Compute the success rate for a dax result (0 to 1). Disk/CPU probes must
 * have completed; pause/resume support does not affect success rate — a
 * provider that legitimately doesn't support pause/resume isn't "failing".
 */
export function computeDaxSuccessRate(result: DaxBenchmarkResult): number {
  if (result.skipped || result.iterations.length === 0) return 0;
  const ok = result.iterations.filter(i => !i.error).length;
  return ok / result.iterations.length;
}

function scoreDaxStats(summary: DaxStats): number {
  const diskScore =
    0.5 * scoreUp(summary.diskSeqWriteMbps.median, DISK_MBPS_CEILING) +
    0.3 * scoreUp(summary.diskSeqReadMbps.median, DISK_MBPS_CEILING) +
    0.2 * scoreDown(summary.diskFsyncLatencyMs.median, FSYNC_LATENCY_CEILING_MS);

  const cpuScore =
    0.7 * scoreUp(summary.cpuOpsPerSec.median, CPU_OPS_CEILING) +
    0.3 * scoreDown(summary.cpuStealPercent.median, STEAL_CEILING_PERCENT);

  const hasPauseResume = summary.pauseMs !== undefined && summary.resumeMs !== undefined;
  const pauseResumeScore = hasPauseResume
    ? 0.5 * scoreDown(summary.pauseMs!.median, PAUSE_RESUME_CEILING_MS) +
      0.5 * scoreDown(summary.resumeMs!.median, PAUSE_RESUME_CEILING_MS)
    : undefined;

  // Renormalize weights over whatever metric groups actually ran — a provider
  // without pause/resume support isn't penalized for a capability it doesn't
  // have yet, it's just scored on disk + CPU.
  if (pauseResumeScore === undefined) {
    return 0.5 * diskScore + 0.5 * cpuScore;
  }
  return 0.35 * diskScore + 0.35 * cpuScore + 0.30 * pauseResumeScore;
}

/**
 * Compute composite scores for all dax results and attach them.
 * compositeScore = weighted metric score × successRate.
 */
export function computeDaxCompositeScores(results: DaxBenchmarkResult[]): void {
  for (const result of results) {
    const successRate = computeDaxSuccessRate(result);
    result.successRate = successRate;

    if (result.skipped || successRate === 0) {
      result.compositeScore = 0;
      continue;
    }

    const score = scoreDaxStats(result.summary);
    result.compositeScore = Math.round(score * successRate * 100) / 100;
  }
}

/** Sort dax results by composite score (highest first). Skipped providers are always last. */
export function sortDaxByCompositeScore(results: DaxBenchmarkResult[]): DaxBenchmarkResult[] {
  return [...results].sort((a, b) => {
    if (a.skipped && !b.skipped) return 1;
    if (!a.skipped && b.skipped) return -1;
    if (a.skipped && b.skipped) return 0;
    return (b.compositeScore ?? 0) - (a.compositeScore ?? 0);
  });
}
