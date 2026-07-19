export const COLD_START_BUDGETS = {
  idle_rss_p95_bytes: 256 * 1024 * 1024,
  idle_rss_drift_bytes: 32 * 1024 * 1024,
  warmup_seconds: 5 * 60,
  observation_seconds: 30 * 60
} as const;

export type ColdStartSample = {
  api_rss_bytes: number;
  ps_rss_bytes: number;
  sampled_at: string;
};

export function summarizeColdStartSamples(samples: ColdStartSample[]) {
  const rss = samples.map(effectiveRss).sort((left, right) => left - right);
  const p95 = percentile(rss, 0.95);
  const minimum = rss[0] ?? 0;
  const maximum = rss.at(-1) ?? 0;
  return {
    samples: rss.length,
    rss_drift_bytes: maximum - minimum,
    rss_p95_bytes: p95,
    within_budget: rss.length > 0 &&
      p95 <= COLD_START_BUDGETS.idle_rss_p95_bytes &&
      maximum - minimum <= COLD_START_BUDGETS.idle_rss_drift_bytes
  };
}

export function coldStartTrace(phase: string): void {
  if (process.env.CODEX_RUNNER_COLD_START_TRACE !== "1") return;
  const memory = process.memoryUsage();
  process.stderr.write(`${JSON.stringify({
    cold_start_phase: phase,
    memory: {
      array_buffers_bytes: memory.arrayBuffers,
      external_bytes: memory.external,
      heap_total_bytes: memory.heapTotal,
      heap_used_bytes: memory.heapUsed,
      rss_bytes: memory.rss
    },
    pid: process.pid,
    sampled_at: new Date().toISOString()
  })}\n`);
}

function effectiveRss(sample: ColdStartSample): number {
  return Math.max(sample.api_rss_bytes, sample.ps_rss_bytes);
}

function percentile(sorted: number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.ceil(sorted.length * quantile) - 1] ?? 0;
}
