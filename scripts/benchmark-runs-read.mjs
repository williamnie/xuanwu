#!/usr/bin/env bun

import { readFile } from 'node:fs/promises';

const DEFAULTS = Object.freeze({
  concurrentIterations: 8,
  hardLimitMs: 500,
  pageSize: 30,
  p95TargetMs: 250,
  warmIterations: 12,
  warmupIterations: 2,
});

export async function benchmarkRunsRead(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const baseUrl = requiredBaseUrl(config.baseUrl);
  const headers = config.token ? { authorization: `Bearer ${config.token}` } : {};
  const runsUrl = new URL(`/api/runs?page=1&page_size=${config.pageSize}`, baseUrl);
  const staticUrl = new URL('/', baseUrl);

  for (let index = 0; index < config.warmupIterations; index += 1) {
    await timedGet(runsUrl, headers);
  }

  const warmSamples = [];
  for (let index = 0; index < config.warmIterations; index += 1) {
    warmSamples.push(await timedGet(runsUrl, headers));
  }

  const concurrentRuns = [];
  const concurrentStatic = [];
  for (let index = 0; index < config.concurrentIterations; index += 1) {
    const [runs, staticPage] = await Promise.all([
      timedGet(runsUrl, headers),
      timedGet(staticUrl, headers),
    ]);
    concurrentRuns.push(runs);
    concurrentStatic.push(staticPage);
  }

  const warm = summarize(warmSamples);
  const concurrent = {
    runs: summarize(concurrentRuns),
    static: summarize(concurrentStatic),
  };
  const passed = warm.p95_ms < config.p95TargetMs && warm.max_ms < config.hardLimitMs;
  return {
    benchmark: 'runs-read-v1',
    configuration: {
      concurrent_iterations: config.concurrentIterations,
      hard_limit_ms: config.hardLimitMs,
      page_size: config.pageSize,
      p95_target_ms: config.p95TargetMs,
      warm_iterations: config.warmIterations,
      warmup_iterations: config.warmupIterations,
    },
    concurrent,
    gate: {
      passed,
      warm_max_below_hard_limit: warm.max_ms < config.hardLimitMs,
      warm_p95_below_target: warm.p95_ms < config.p95TargetMs,
    },
    method: 'read_only_http_get',
    privacy: 'response_bodies_and_auth_token_not_recorded',
    warm,
  };
}

async function timedGet(url, headers) {
  const startedAt = performance.now();
  const response = await fetch(url, { headers });
  await response.arrayBuffer();
  if (!response.ok) throw new Error(`GET ${url.pathname} returned HTTP ${response.status}`);
  return round(performance.now() - startedAt);
}

function summarize(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    max_ms: sorted.at(-1) ?? 0,
    min_ms: sorted[0] ?? 0,
    p50_ms: percentile(sorted, 0.50),
    p95_ms: percentile(sorted, 0.95),
    p99_ms: percentile(sorted, 0.99),
    samples_ms: samples,
  };
}

function percentile(sorted, quantile) {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function requiredBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('--base-url is required');
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('--base-url must use HTTP(S)');
  return url;
}

async function main(argv) {
  const args = parseArgs(argv);
  const token = await readToken(args.tokenFile);
  const report = await benchmarkRunsRead({
    baseUrl: args.baseUrl,
    concurrentIterations: args.concurrentIterations,
    hardLimitMs: args.hardLimitMs,
    pageSize: args.pageSize,
    p95TargetMs: args.p95TargetMs,
    token,
    warmIterations: args.warmIterations,
    warmupIterations: args.warmupIterations,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.gate.passed) process.exitCode = 1;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('arguments must be --name value pairs');
    values.set(key, value);
  }
  return {
    baseUrl: values.get('--base-url') || process.env.XUANWU_ADDR || '',
    concurrentIterations: integer(values.get('--concurrent-iterations'), DEFAULTS.concurrentIterations),
    hardLimitMs: positiveNumber(values.get('--hard-limit-ms'), DEFAULTS.hardLimitMs),
    pageSize: integer(values.get('--page-size'), DEFAULTS.pageSize),
    p95TargetMs: positiveNumber(values.get('--p95-target-ms'), DEFAULTS.p95TargetMs),
    tokenFile: values.get('--token-file') || process.env.XUANWU_AUTH_TOKEN_FILE || '',
    warmIterations: integer(values.get('--warm-iterations'), DEFAULTS.warmIterations),
    warmupIterations: integer(values.get('--warmup-iterations'), DEFAULTS.warmupIterations),
  };
}

async function readToken(tokenFile) {
  if (process.env.XUANWU_AUTH_TOKEN) return process.env.XUANWU_AUTH_TOKEN.trim();
  if (!tokenFile) return '';
  return (await readFile(tokenFile, 'utf8')).trim();
}

function integer(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`expected positive integer, received ${value}`);
  return parsed;
}

function positiveNumber(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`expected positive number, received ${value}`);
  return parsed;
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ benchmark: 'runs-read-v1', error: error.message })}\n`);
    process.exitCode = 1;
  });
}
