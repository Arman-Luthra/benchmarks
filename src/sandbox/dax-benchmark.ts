import type { ProviderConfig } from './types.js';
import type { DaxBenchmarkResult, DaxIterationResult, DaxCpuInfo } from './dax-types.js';
import { computeStats } from '../util/stats.js';
import { withTimeout } from '../util/timeout.js';
import { formatError } from '../util/error.js';

const DISK_FILE_SIZE_MB = 256;
const FSYNC_SAMPLE_COUNT = 20;
const CPU_PROBE_DURATION_MS = 1000;
const STEAL_SAMPLE_WINDOW_MS = 1000;

/**
 * Runs entirely as a single `node -e` script inside the sandbox so it works
 * identically across providers regardless of shell dialect (bash/ash/busybox)
 * or which `dd` flags happen to be supported — every provider already has to
 * run `node -v` to pass the TTI probe, so `node` is a safe common denominator.
 *
 * Sequential write/read throughput is timed with process.hrtime.bigint()
 * inside the sandbox (avoids exec/RTT overhead skewing the numbers), and a
 * fsync-latency series is sampled from small-file writes: local NVMe is
 * sub-ms, while networked/remote block storage tends to be materially higher
 * and jitterier — that gap is the actual signal behind "not networked".
 */
const DISK_PROBE_SCRIPT = `
const fs = require('fs');
const path = '/tmp/.dax_disk_' + process.pid;
try {
  const chunk = Buffer.alloc(1024 * 1024);
  const totalMB = ${DISK_FILE_SIZE_MB};

  const wStart = process.hrtime.bigint();
  const wfd = fs.openSync(path, 'w');
  for (let i = 0; i < totalMB; i++) fs.writeSync(wfd, chunk);
  fs.fsyncSync(wfd);
  fs.closeSync(wfd);
  const wEnd = process.hrtime.bigint();

  const readBuf = Buffer.alloc(1024 * 1024);
  const rStart = process.hrtime.bigint();
  const rfd = fs.openSync(path, 'r');
  while (fs.readSync(rfd, readBuf, 0, readBuf.length, null) > 0) {}
  fs.closeSync(rfd);
  const rEnd = process.hrtime.bigint();

  const writeSec = Number(wEnd - wStart) / 1e9;
  const readSec = Number(rEnd - rStart) / 1e9;
  const totalBytes = totalMB * 1024 * 1024;

  const fsyncLatencyMs = [];
  for (let i = 0; i < ${FSYNC_SAMPLE_COUNT}; i++) {
    const p = path + '.fsync' + i;
    const small = Buffer.alloc(4096, 1);
    const s0 = process.hrtime.bigint();
    const fd = fs.openSync(p, 'w');
    fs.writeSync(fd, small);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    const s1 = process.hrtime.bigint();
    fsyncLatencyMs.push(Number(s1 - s0) / 1e6);
    fs.unlinkSync(p);
  }

  fs.unlinkSync(path);

  console.log(JSON.stringify({
    writeMbps: (totalBytes * 8) / writeSec / 1e6,
    readMbps: (totalBytes * 8) / readSec / 1e6,
    fsyncLatencyMs,
  }));
} catch (err) {
  console.log(JSON.stringify({ error: String(err && err.message || err) }));
}
`.trim();

/**
 * CPU-bound throughput (fixed time window of SHA-256 rounds, so slower CPUs
 * don't overrun a timeout) plus a /proc/stat steal-time sample. Near-zero
 * steal is consistent with running directly on a hypervisor on bare metal
 * rather than nested inside another VM layer — a proxy, not a guarantee.
 */
const CPU_PROBE_SCRIPT = `
(async () => {
  const fs = require('fs');
  const crypto = require('crypto');

  function readStat() {
    try {
      const line = fs.readFileSync('/proc/stat', 'utf8').split('\\n')[0];
      const parts = line.trim().split(/\\s+/).slice(1).map(Number);
      const steal = parts[7] || 0;
      const total = parts.reduce((a, b) => a + b, 0);
      return { steal, total };
    } catch {
      return null;
    }
  }

  const data = crypto.randomBytes(1024);
  const start = process.hrtime.bigint();
  let count = 0;
  while (Number(process.hrtime.bigint() - start) / 1e6 < ${CPU_PROBE_DURATION_MS}) {
    crypto.createHash('sha256').update(data).digest();
    count++;
  }
  const elapsedSec = Number(process.hrtime.bigint() - start) / 1e9;
  const opsPerSec = count / elapsedSec;

  const s0 = readStat();
  await new Promise((r) => setTimeout(r, ${STEAL_SAMPLE_WINDOW_MS}));
  const s1 = readStat();
  let stealPercent;
  if (s0 && s1) {
    const totalDelta = s1.total - s0.total;
    const stealDelta = s1.steal - s0.steal;
    stealPercent = totalDelta > 0 ? (stealDelta / totalDelta) * 100 : 0;
  }

  let model, cores;
  try {
    const cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
    const m = cpuinfo.match(/model name\\s*:\\s*(.+)/);
    model = m ? m[1].trim() : undefined;
    const c = cpuinfo.match(/^processor\\s*:/gm);
    cores = c ? c.length : undefined;
  } catch {}

  console.log(JSON.stringify({ opsPerSec, stealPercent, model, cores }));
})();
`.trim();

interface DiskProbeOutput {
  writeMbps: number;
  readMbps: number;
  fsyncLatencyMs: number[];
  error?: string;
}

interface CpuProbeOutput {
  opsPerSec: number;
  stealPercent?: number;
  model?: string;
  cores?: number;
}

function parseJsonStdout<T>(stdout: string | undefined): T {
  const trimmed = (stdout || '').trim();
  const lastLine = trimmed.split('\n').filter(Boolean).pop();
  if (!lastLine) throw new Error('Probe produced no output');
  return JSON.parse(lastLine) as T;
}

/**
 * Wraps a multi-line script as a `node -e` command that's safe across shell
 * dialects: the script is base64-encoded and decoded+eval'd on the node side,
 * so no shell-quoting of newlines/quotes/backticks in the script body is
 * needed — the base64 alphabet has no shell-special characters.
 */
function toNodeEvalCommand(script: string): string {
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  return `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`;
}

export async function runDiskProbe(sandbox: any, timeout: number): Promise<Pick<DaxIterationResult, 'diskSeqWriteMbps' | 'diskSeqReadMbps' | 'diskFsyncLatencyMs'>> {
  const result = await withTimeout(
    sandbox.runCommand(toNodeEvalCommand(DISK_PROBE_SCRIPT)),
    timeout,
    'Disk probe timed out',
  ) as { exitCode: number; stdout?: string; stderr?: string };

  if (result.exitCode !== 0) {
    throw new Error(`Disk probe failed with exit code ${result.exitCode}: ${result.stderr || 'Unknown error'}`);
  }

  const parsed = parseJsonStdout<DiskProbeOutput>(result.stdout);
  if (parsed.error) throw new Error(`Disk probe error: ${parsed.error}`);

  return {
    diskSeqWriteMbps: parsed.writeMbps,
    diskSeqReadMbps: parsed.readMbps,
    diskFsyncLatencyMs: parsed.fsyncLatencyMs,
  };
}

export async function runCpuProbe(sandbox: any, timeout: number): Promise<{ cpuOpsPerSec: number; cpuStealPercent?: number; cpuInfo: DaxCpuInfo }> {
  const result = await withTimeout(
    sandbox.runCommand(toNodeEvalCommand(CPU_PROBE_SCRIPT)),
    timeout,
    'CPU probe timed out',
  ) as { exitCode: number; stdout?: string; stderr?: string };

  if (result.exitCode !== 0) {
    throw new Error(`CPU probe failed with exit code ${result.exitCode}: ${result.stderr || 'Unknown error'}`);
  }

  const parsed = parseJsonStdout<CpuProbeOutput>(result.stdout);

  return {
    cpuOpsPerSec: parsed.opsPerSec,
    cpuStealPercent: parsed.stealPercent,
    cpuInfo: { model: parsed.model, cores: parsed.cores },
  };
}

/**
 * Attempts a real pause/resume round-trip via the unified `sandbox.pause()` /
 * `sandbox.resume()` primitive added in computesdk/computesdk PR #645
 * (https://github.com/computesdk/computesdk/pull/645). Every provider's
 * wrapped sandbox object exposes these two methods regardless of support —
 * unsupported providers throw `Error("Pause is not supported by the X
 * provider.")` (and equivalent for resume), which this treats the same as any
 * other pause/resume failure: `pauseResumeSupported: false` with the message
 * captured for diagnostics. Until PR #645 merges and this repo's
 * `@computesdk/*` deps are bumped past it, `sandbox.pause` won't exist on the
 * installed type/runtime at all, so the `typeof` guard below fails the same
 * way — no code change needed here when that lands.
 */
export async function runPauseResumeProbe(
  sandbox: any,
  timeout: number,
): Promise<Pick<DaxIterationResult, 'pauseMs' | 'resumeMs' | 'pauseResumeSupported' | 'pauseResumeSkipReason'>> {
  const pausable = sandbox as { pause?: (options?: any) => Promise<void>; resume?: () => Promise<void> };

  if (typeof pausable.pause !== 'function' || typeof pausable.resume !== 'function') {
    return { pauseResumeSupported: false, pauseResumeSkipReason: 'pause/resume not available on this sandbox object' };
  }

  const markerPath = `/tmp/.dax_pause_marker_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const token = `${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;

  try {
    const writeResult = await withTimeout(
      sandbox.runCommand(`printf '%s' '${token}' > ${markerPath}`),
      30_000,
      'Marker file write timed out',
    ) as { exitCode: number; stderr?: string };
    if (writeResult.exitCode !== 0) {
      throw new Error(`Marker file write failed: ${writeResult.stderr || 'Unknown error'}`);
    }

    const pauseStart = performance.now();
    await withTimeout(pausable.pause(), timeout, 'Pause timed out');
    const pauseMs = performance.now() - pauseStart;

    const resumeStart = performance.now();
    await withTimeout(pausable.resume(), timeout, 'Resume timed out');
    const resumeMs = performance.now() - resumeStart;

    const readResult = await withTimeout(
      sandbox.runCommand(`cat ${markerPath} 2>/dev/null || true`),
      30_000,
      'Marker file read timed out',
    ) as { exitCode: number; stdout?: string };
    const survived = (readResult.stdout || '').trim() === token;

    if (!survived) {
      throw new Error('Marker file did not survive pause/resume round-trip — this was a cold rebuild, not a real pause');
    }

    return { pauseMs, resumeMs, pauseResumeSupported: true };
  } catch (err) {
    return { pauseResumeSupported: false, pauseResumeSkipReason: formatError(err) };
  }
}

async function runIteration(
  compute: any,
  timeout: number,
  sandboxOptions: Record<string, any> | undefined,
  destroyTimeoutMs: number,
): Promise<DaxIterationResult> {
  let sandbox: any = null;

  try {
    sandbox = await withTimeout(compute.sandbox.create(sandboxOptions), timeout, 'Sandbox creation timed out');

    const disk = await runDiskProbe(sandbox, timeout);
    const cpu = await runCpuProbe(sandbox, timeout);
    const pauseResume = await runPauseResumeProbe(sandbox, timeout);

    return {
      ...disk,
      cpuOpsPerSec: cpu.cpuOpsPerSec,
      cpuStealPercent: cpu.cpuStealPercent,
      cpuInfo: cpu.cpuInfo,
      ...pauseResume,
    };
  } catch (err) {
    return { error: formatError(err), pauseResumeSupported: false };
  } finally {
    if (sandbox) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          sandbox.destroy(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Destroy timeout')), destroyTimeoutMs);
          }),
        ]);
      } catch (err) {
        console.warn(`    [cleanup] destroy failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }
}

export async function runDaxBenchmark(config: ProviderConfig): Promise<DaxBenchmarkResult> {
  const { name, iterations = 10, timeout = 120_000, requiredEnvVars, sandboxOptions, destroyTimeoutMs = 15_000 } = config;

  const emptySummary = {
    diskSeqWriteMbps: { median: 0, p95: 0, p99: 0 },
    diskSeqReadMbps: { median: 0, p95: 0, p99: 0 },
    diskFsyncLatencyMs: { median: 0, p95: 0, p99: 0 },
    cpuOpsPerSec: { median: 0, p95: 0, p99: 0 },
    cpuStealPercent: { median: 0, p95: 0, p99: 0 },
  };

  const missingVars = requiredEnvVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    return {
      provider: name,
      mode: 'dax',
      iterations: [],
      summary: emptySummary,
      pauseResumeSupported: false,
      skipped: true,
      skipReason: `Missing: ${missingVars.join(', ')}`,
    };
  }

  const compute = config.createCompute();
  const results: DaxIterationResult[] = [];

  console.log(`\n--- Dax Benchmarking: ${name} (${iterations} iterations) ---`);

  for (let i = 0; i < iterations; i++) {
    console.log(`  Iteration ${i + 1}/${iterations}...`);
    const result = await runIteration(compute, timeout, sandboxOptions, destroyTimeoutMs);
    results.push(result);

    if (result.error) {
      console.log(`    FAILED: ${result.error}`);
    } else {
      const pr = result.pauseResumeSupported
        ? `pause ${Math.round(result.pauseMs!)}ms / resume ${Math.round(result.resumeMs!)}ms`
        : `pause/resume: not supported (${result.pauseResumeSkipReason})`;
      console.log(
        `    Disk: ${result.diskSeqWriteMbps?.toFixed(1)} Mbps write / ${result.diskSeqReadMbps?.toFixed(1)} Mbps read | ` +
        `CPU: ${result.cpuOpsPerSec?.toFixed(0)} ops/s (steal ${result.cpuStealPercent?.toFixed(2)}%) | ${pr}`,
      );
    }
  }

  const successful = results.filter(r => !r.error);
  const pauseResumeSuccessful = successful.filter(r => r.pauseResumeSupported);
  const cpuInfo: DaxCpuInfo | undefined = successful.find(r => r.cpuInfo)?.cpuInfo;

  return {
    provider: name,
    mode: 'dax',
    iterations: results,
    summary: {
      diskSeqWriteMbps: computeStats(successful.map(r => r.diskSeqWriteMbps!).filter(v => v !== undefined)),
      diskSeqReadMbps: computeStats(successful.map(r => r.diskSeqReadMbps!).filter(v => v !== undefined)),
      diskFsyncLatencyMs: computeStats(successful.flatMap(r => r.diskFsyncLatencyMs || [])),
      cpuOpsPerSec: computeStats(successful.map(r => r.cpuOpsPerSec!).filter(v => v !== undefined)),
      cpuStealPercent: computeStats(successful.map(r => r.cpuStealPercent!).filter(v => v !== undefined)),
      ...(pauseResumeSuccessful.length > 0 ? {
        pauseMs: computeStats(pauseResumeSuccessful.map(r => r.pauseMs!)),
        resumeMs: computeStats(pauseResumeSuccessful.map(r => r.resumeMs!)),
      } : {}),
    },
    pauseResumeSupported: pauseResumeSuccessful.length > 0,
    ...(cpuInfo ? { cpuInfo } : {}),
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function roundStats(s: { median: number; p95: number; p99: number }) {
  return { median: round(s.median), p95: round(s.p95), p99: round(s.p99) };
}

export async function writeDaxResultsJson(results: DaxBenchmarkResult[], outPath: string): Promise<void> {
  const fs = await import('fs');
  const os = await import('os');

  const cleanResults = results.map(r => ({
    provider: r.provider,
    mode: r.mode,
    iterations: r.iterations.map(i => ({
      ...(i.diskSeqWriteMbps !== undefined ? { diskSeqWriteMbps: round(i.diskSeqWriteMbps) } : {}),
      ...(i.diskSeqReadMbps !== undefined ? { diskSeqReadMbps: round(i.diskSeqReadMbps) } : {}),
      ...(i.diskFsyncLatencyMs ? { diskFsyncLatencyMs: i.diskFsyncLatencyMs.map(round) } : {}),
      ...(i.cpuOpsPerSec !== undefined ? { cpuOpsPerSec: round(i.cpuOpsPerSec) } : {}),
      ...(i.cpuStealPercent !== undefined ? { cpuStealPercent: round(i.cpuStealPercent) } : {}),
      pauseResumeSupported: i.pauseResumeSupported,
      ...(i.pauseMs !== undefined ? { pauseMs: round(i.pauseMs) } : {}),
      ...(i.resumeMs !== undefined ? { resumeMs: round(i.resumeMs) } : {}),
      ...(i.pauseResumeSkipReason ? { pauseResumeSkipReason: i.pauseResumeSkipReason } : {}),
      ...(i.error ? { error: i.error } : {}),
    })),
    summary: {
      diskSeqWriteMbps: roundStats(r.summary.diskSeqWriteMbps),
      diskSeqReadMbps: roundStats(r.summary.diskSeqReadMbps),
      diskFsyncLatencyMs: roundStats(r.summary.diskFsyncLatencyMs),
      cpuOpsPerSec: roundStats(r.summary.cpuOpsPerSec),
      cpuStealPercent: roundStats(r.summary.cpuStealPercent),
      ...(r.summary.pauseMs ? { pauseMs: roundStats(r.summary.pauseMs) } : {}),
      ...(r.summary.resumeMs ? { resumeMs: roundStats(r.summary.resumeMs) } : {}),
    },
    pauseResumeSupported: r.pauseResumeSupported,
    ...(r.cpuInfo ? { cpuInfo: r.cpuInfo } : {}),
    ...(r.compositeScore !== undefined ? { compositeScore: round(r.compositeScore) } : {}),
    ...(r.successRate !== undefined ? { successRate: round(r.successRate) } : {}),
    ...(r.skipped ? { skipped: r.skipped, skipReason: r.skipReason } : {}),
  }));

  const output = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
    },
    config: {
      iterations: results[0]?.iterations.length || 0,
    },
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Results written to ${outPath}`);
}
