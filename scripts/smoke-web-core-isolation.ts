#!/usr/bin/env bun
import { lstatSync, readlinkSync, readdirSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

type Child = ReturnType<typeof Bun.spawn>;
type Sample = { asset_ms: number; index_ms: number };
const AUTHORIZATION = "Bearer isolation-smoke-token";

const args = parseArgs(Bun.argv.slice(2));
const binary = resolve(args.binary ?? "dist/codex-issue-runner");
const webDir = resolve(args.webDir ?? "frontend/dist");
const slowMs = boundedInteger(args.slowMs, 6_000, 5_000, 10_000);
const samples = boundedInteger(args.samples, 30, 10, 100);
const root = await mkdtemp(join(tmpdir(), "runner-web-core-smoke-"));
const stateDir = join(root, "state");
const dbPath = join(stateDir, "runner.db");
const assetPath = await findHashedAsset(webDir);
const [webPort, corePort, agenticPort] = await freePorts();
const webUrl = `http://127.0.0.1:${webPort}`;
const coreUrl = `http://127.0.0.1:${corePort}`;
const agenticUrl = `http://127.0.0.1:${agenticPort}`;
let agentic: Child | undefined;
let core: Child | undefined;
let web: Child | undefined;

try {
  agentic = spawnRole("agentic", agenticPort);
  await waitForHealth(agenticUrl);
  core = spawnRole("core", corePort);
  web = spawnRole("web", webPort);
  await Promise.all([waitForHealth(coreUrl), waitForHealth(webUrl)]);

  const slowRequest = fetch(`${coreUrl}/api/system/test/block`, { headers: { authorization: AUTHORIZATION } });
  await Bun.sleep(100);
  const timings: Sample[] = [];
  for (let index = 0; index < samples; index += 1) {
    const [indexMs, assetMs] = await Promise.all([
      timedGet(`${webUrl}/`),
      timedGet(`${webUrl}/${assetPath}`)
    ]);
    timings.push({ asset_ms: assetMs, index_ms: indexMs });
  }
  const slowResponse = await slowRequest;
  const slowBody = await slowResponse.json() as { blocked_ms?: number };

  const indexStats = stats(timings.map((sample) => sample.index_ms));
  const assetStats = stats(timings.map((sample) => sample.asset_ms));
  const performancePass = indexStats.p95 < 100 && indexStats.p99 < 250
    && assetStats.p95 < 100 && assetStats.p99 < 250;
  const webDbFdOpen = processOpenedPath(web.pid, dbPath);
  const coreDbFdOpen = processOpenedPath(core.pid, dbPath);
  const agenticDbFdOpen = processOpenedPath(agentic.pid, dbPath);

  agentic.kill("SIGSTOP");
  await Bun.sleep(100);
  const coreWhileAgenticPaused = await timedStatus(`${coreUrl}/api/projects`, { authorization: AUTHORIZATION });
  agentic.kill("SIGCONT");
  await stop(agentic);
  agentic = undefined;
  const coreWhileAgenticDown = await timedStatus(`${coreUrl}/api/projects`, { authorization: AUTHORIZATION });
  const agenticUnavailable = await timedStatus(`${coreUrl}/api/system/agentic-health`, { authorization: AUTHORIZATION });
  agentic = spawnRole("agentic", agenticPort);
  await waitForHealth(agenticUrl);
  const agenticRecovered = await timedStatus(`${coreUrl}/api/system/agentic-health`, { authorization: AUTHORIZATION });

  await stop(core);
  core = undefined;
  const shellWhileCoreDown = await timedStatus(`${webUrl}/`);
  const unavailable = await timedStatus(`${webUrl}/api/projects`, { authorization: AUTHORIZATION });

  core = spawnRole("core", corePort);
  await waitForHealth(coreUrl);
  const recovered = await fetch(`${webUrl}/api/projects`, { headers: { authorization: AUTHORIZATION } });
  const recoveredBody = await recovered.json();

  const result = {
    contract: "runner-web-core-agentic-isolation-smoke.v2",
    ok: performancePass
      && slowResponse.ok
      && slowBody.blocked_ms === slowMs
      && webDbFdOpen === false
      && coreDbFdOpen === true
      && agenticDbFdOpen === true
      && coreWhileAgenticPaused.status === 200
      && coreWhileAgenticPaused.elapsed_ms < 250
      && coreWhileAgenticDown.status === 200
      && agenticUnavailable.status === 503
      && agenticUnavailable.elapsed_ms < 2_000
      && agenticRecovered.status === 200
      && shellWhileCoreDown.status === 200
      && unavailable.status === 503
      && unavailable.elapsed_ms < 2_000
      && recovered.ok
      && Array.isArray(recoveredBody),
    artifact: basename(binary),
    asset: assetPath,
    core_block_ms: slowBody.blocked_ms ?? 0,
    process_isolation: {
      agentic_pid: agentic.pid,
      core_pid: core.pid,
      distinct_pids: core.pid !== web.pid && core.pid !== agentic.pid && web.pid !== agentic.pid,
      agentic_db_fd_open: agenticDbFdOpen,
      core_db_fd_open: coreDbFdOpen,
      web_db_fd_open: webDbFdOpen,
      web_pid: web.pid
    },
    agentic_restart: {
      core_api_paused_elapsed_ms: coreWhileAgenticPaused.elapsed_ms,
      core_api_paused_status: coreWhileAgenticPaused.status,
      core_api_status: coreWhileAgenticDown.status,
      health_recovered_status: agenticRecovered.status,
      unavailable_elapsed_ms: agenticUnavailable.elapsed_ms,
      unavailable_status: agenticUnavailable.status
    },
    static_latency_ms: { asset: assetStats, index: indexStats, samples },
    core_restart: {
      api_recovered_status: recovered.status,
      unavailable_elapsed_ms: unavailable.elapsed_ms,
      unavailable_status: unavailable.status,
      web_shell_status: shellWhileCoreDown.status
    },
    thresholds_ms: { p95: 100, p99: 250 }
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    contract: "runner-web-core-agentic-isolation-smoke.v2",
    error: error instanceof Error ? error.message : String(error),
    ok: false
  })}\n`);
  process.exitCode = 1;
} finally {
  if (web) await stop(web);
  if (core) await stop(core);
  if (agentic) await stop(agentic);
  await rm(root, { recursive: true, force: true });
}

function spawnRole(role: "agentic" | "core" | "web", port: number): Child {
  const roleArgs = role === "core"
    ? [
        "serve", "--role", "core", "--addr", `127.0.0.1:${port}`,
        "--agentic-addr", agenticUrl, "--state-dir", stateDir, "--db", dbPath,
        "--codex-cmd", Bun.which("true") ?? "/usr/bin/true"
      ]
    : role === "agentic"
      ? [
          "serve", "--role", "agentic", "--addr", `127.0.0.1:${port}`,
          "--state-dir", stateDir, "--db", dbPath, "--codex-cmd", Bun.which("true") ?? "/usr/bin/true"
        ]
      : [
        "serve", "--role", "web", "--addr", `127.0.0.1:${port}`,
        "--core-addr", coreUrl, "--web-dir", webDir, "--proxy-timeout-ms", "1000"
      ];
  const child = Bun.spawn([binary, ...roleArgs], {
    env: {
      ...Bun.env,
      CODEX_RUNNER_AUTH_TOKEN: role === "web" ? "" : AUTHORIZATION.slice("Bearer ".length),
      CODEX_RUNNER_AUTH_TOKEN_FILE: "",
      ...(role === "core" ? { CODEX_RUNNER_TEST_BLOCK_MS: String(slowMs) } : {})
    },
    stderr: "pipe",
    stdout: "pipe"
  });
  void consume(child.stdout);
  void consume(child.stderr);
  return child;
}

async function consume(stream: ReadableStream<Uint8Array> | number | undefined): Promise<void> {
  if (stream && typeof stream !== "number") await new Response(stream).arrayBuffer().catch(() => {});
}

async function stop(child: Child): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = Promise.resolve(child.exited);
  const timeout = Bun.sleep(2_000).then(() => "timeout" as const);
  if (await Promise.race([exited, timeout]) === "timeout") {
    child.kill("SIGKILL");
    await child.exited;
  }
}

async function waitForHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) })).ok) return;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error(`service did not become healthy: ${baseUrl}`);
}

async function timedGet(url: string): Promise<number> {
  const result = await timedStatus(url);
  if (result.status !== 200) throw new Error(`unexpected static status ${result.status}: ${url}`);
  return result.elapsed_ms;
}

async function timedStatus(url: string, headers?: HeadersInit): Promise<{ elapsed_ms: number; status: number }> {
  const started = performance.now();
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(3_000) });
  await response.arrayBuffer();
  return { elapsed_ms: round(performance.now() - started), status: response.status };
}

function stats(values: number[]): { max: number; p50: number; p95: number; p99: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (value: number) => sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)] ?? 0;
  return { max: round(sorted.at(-1) ?? 0), p50: round(percentile(0.5)), p95: round(percentile(0.95)), p99: round(percentile(0.99)) };
}

function processOpenedPath(pid: number, path: string): boolean {
  const lsof = Bun.which("lsof");
  if (lsof) {
    const result = Bun.spawnSync([lsof, "-nP", "-a", "-p", String(pid), path], { stderr: "ignore", stdout: "pipe" });
    return new TextDecoder().decode(result.stdout).includes(path);
  }
  const fdDir = `/proc/${pid}/fd`;
  try {
    return readdirSync(fdDir).some((fd) => {
      const fdPath = join(fdDir, fd);
      try { return lstatSync(fdPath).isSymbolicLink() && resolve(readlinkSync(fdPath)) === resolve(path); } catch { return false; }
    });
  } catch {
    throw new Error("cannot verify Web DB file descriptors: lsof and /proc are unavailable");
  }
}

async function findHashedAsset(root: string): Promise<string> {
  const assets = join(root, "assets");
  for (const name of await readdir(assets)) {
    if (/-[A-Za-z0-9_-]{8,}\.(?:css|js)$/.test(name)) return `assets/${name}`;
  }
  throw new Error(`no hashed asset found in ${assets}`);
}

async function freePorts(): Promise<[number, number, number]> {
  const first = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
  const firstPort = first.port;
  const second = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
  const secondPort = second.port;
  const third = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
  const thirdPort = third.port;
  first.stop(true);
  second.stop(true);
  third.stop(true);
  return [firstPort, secondPort, thirdPort];
}

function parseArgs(argv: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index] ?? "";
    const value = argv[index + 1] ?? "";
    if (!flag.startsWith("--") || value === "") throw new Error(`invalid argument: ${flag}`);
    const key = flag.slice(2).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    values[key] = value;
  }
  return values;
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`expected integer between ${minimum} and ${maximum}, received ${value}`);
  }
  return parsed;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
