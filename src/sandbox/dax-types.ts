import type { Stats } from './types.js';

/**
 * Timing/result data for a single "dax" iteration: disk, CPU, and pause/resume
 * probes run back-to-back in one sandbox lifecycle.
 */
export interface DaxIterationResult {
  /** Sequential write throughput in Mbps (256MB file, fdatasync'd). */
  diskSeqWriteMbps?: number;
  /** Sequential read throughput in Mbps (reading the same file back). */
  diskSeqReadMbps?: number;
  /** Per-op fsync latency samples in ms from repeated small-file writes. */
  diskFsyncLatencyMs?: number[];
  /** CPU-bound workload throughput (SHA-256 rounds per second). */
  cpuOpsPerSec?: number;
  /** CPU steal time percentage sampled over ~1s via /proc/stat. */
  cpuStealPercent?: number;
  /** CPU model/core-count metadata captured alongside the CPU probe (informational only). */
  cpuInfo?: DaxCpuInfo;
  /** Time for sandbox.pause() to resolve, in ms. */
  pauseMs?: number;
  /** Time for sandbox.resume() to resolve, in ms. */
  resumeMs?: number;
  /** Whether this iteration's pause/resume round-trip succeeded. */
  pauseResumeSupported: boolean;
  /** Reason pause/resume was unavailable or failed (e.g. the "not supported" error). */
  pauseResumeSkipReason?: string;
  /** Error message if the disk/CPU portion of this iteration failed. */
  error?: string;
}

export interface DaxStats {
  diskSeqWriteMbps: Stats;
  diskSeqReadMbps: Stats;
  diskFsyncLatencyMs: Stats;
  cpuOpsPerSec: Stats;
  cpuStealPercent: Stats;
  pauseMs?: Stats;
  resumeMs?: Stats;
}

/** Informational CPU metadata, captured but not scored. */
export interface DaxCpuInfo {
  model?: string;
  cores?: number;
}

export interface DaxBenchmarkResult {
  provider: string;
  mode: 'dax';
  iterations: DaxIterationResult[];
  summary: DaxStats;
  /** True if at least one iteration completed a real pause/resume round-trip. */
  pauseResumeSupported: boolean;
  cpuInfo?: DaxCpuInfo;
  /** Composite weighted score (0-100, higher = better). Computed post-benchmark. */
  compositeScore?: number;
  /** Success rate as a fraction (0 to 1). Computed post-benchmark. */
  successRate?: number;
  skipped?: boolean;
  skipReason?: string;
}
