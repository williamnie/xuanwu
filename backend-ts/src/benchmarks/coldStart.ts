export function coldStartTrace(phase: string): void {
  if (process.env.XUANWU_COLD_START_TRACE !== "1") return;
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
