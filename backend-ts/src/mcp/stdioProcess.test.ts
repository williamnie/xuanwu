import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { runStdioProcess } from "./stdioProcess.ts";

function run(script: string, overrides: Partial<Parameters<typeof runStdioProcess>[0]> = {}) {
  return runStdioProcess({
    command: process.execPath, args: ["-e", script], input: "",
    stdoutLimit: 1024, stderrLimit: 128, timeoutMs: 2_000, ...overrides
  });
}

test("stdio child waits do not block the event loop", async () => {
  let timerRan = false;
  const timer = setTimeout(() => { timerRan = true; }, 10);
  try {
    const result = await run('setTimeout(() => process.stdout.write("ready"), 150)');
    expect(timerRan).toBe(true);
    expect(result).toMatchObject({ status: 0, stdout: "ready" });
    expect(result.error).toBeUndefined();
  } finally { clearTimeout(timer); }
});

test("stdio output budgets terminate stdout and stderr floods", async () => {
  for (const stream of ["stdout", "stderr"] as const) {
    const result = await run(`process.${stream}.write("x".repeat(100000)); setInterval(() => {}, 1000)`);
    expect(result.error?.code).toBe("ENOBUFS");
    expect(Buffer.byteLength(result[stream])).toBeLessThanOrEqual(stream === "stdout" ? 1024 : 128);
  }
});

test("stdio timeout kills child and releases capacity", async () => {
  const started = performance.now();
  const result = await run('setInterval(() => {}, 1000)', { timeoutMs: 60 });
  expect(result.error?.code).toBe("ETIMEDOUT");
  expect(performance.now() - started).toBeLessThan(1_000);
  expect((await run('process.stdout.write("next")')).stdout).toBe("next");
});

test("stdio queue time counts toward timeout and expired jobs do not execute", async () => {
  const occupied = Array.from({ length: 4 }, () => run('setTimeout(() => {}, 200)'));
  const result = await run('process.stdout.write("must not start")', { timeoutMs: 30 });
  expect(result.error?.code).toBe("ETIMEDOUT");
  expect(result.stdout).toBe("");
  await Promise.all(occupied);
});

test("stdio spawn failure resolves and cleans up", async () => {
  const result = await run("", { command: "/nonexistent/xuanwu-test-mcp" });
  expect(result.error).toBeDefined();
  expect((await run('process.stdout.write("ok")')).stdout).toBe("ok");
});

test("stdio deadline closes pipes inherited by child descendants", async () => {
  if (process.platform === "win32") return;
  const started = performance.now();
  const result = await run(`
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
    process.exit(0);
  `, { timeoutMs: 100 });
  expect(result.error?.code).toBe("ETIMEDOUT");
  expect(performance.now() - started).toBeLessThan(1_000);
});


test("stdio expired queue entries never spawn when deadline timers have not fired yet", async () => {
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const spawn = spyOn(childProcess, "spawn");
  try {
    const occupied = Array.from({ length: 4 }, () => run("setTimeout(() => {}, 40)"));
    const expired = run('process.stdout.write("must not start")', { timeoutMs: 500 });
    now = 1_000;
    const [result] = await Promise.all([expired, ...occupied]);
    expect(result.error?.code).toBe("ETIMEDOUT");
    expect(spawn).toHaveBeenCalledTimes(4);
    expect((await run('process.stdout.write("recovered")')).stdout).toBe("recovered");
  } finally { spawn.mockRestore(); clock.mockRestore(); }
});
