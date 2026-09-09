import { expect, spyOn, test } from "bun:test";
import { runGit, withGitWorkspaceObservation } from "./gitWorkspaceObservation.ts";
import { tmpdir } from "node:os";

test("Git observation yields while a command is running", async () => {
  let ticked = false;
  const timer = setTimeout(() => { ticked = true; }, 10);
  try {
    const result = await runGit(tmpdir(), ["-c", "alias.xuanwu-test=!sleep 0.15", "xuanwu-test"], performance.now() + 1_000);
    expect(result).not.toBeNull();
    expect(ticked).toBe(true);
  } finally { clearTimeout(timer); }
});

test("Git observation timeout cleans up shell descendants and inherited pipes", async () => {
  const started = performance.now();
  const result = await runGit(tmpdir(), ["-c", "alias.xuanwu-test=!sleep 3", "xuanwu-test"], performance.now() + 60);
  expect(result).toBeNull();
  expect(performance.now() - started).toBeLessThan(1_000);
});

test("Git observation serializes the same repository and releases failed observations", async () => {
  let active = 0;
  let peak = 0;
  const observe = () => withGitWorkspaceObservation(tmpdir(), async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return true;
  });
  expect(await Promise.all(Array.from({ length: 5 }, observe))).toEqual([true, true, true, true, true]);
  expect(peak).toBe(1);
  await expect(withGitWorkspaceObservation(tmpdir(), async () => { throw new Error("fixture"); })).rejects.toThrow("fixture");
  expect(await observe()).toBe(true);
});


test("Git queued observations do not run after their deadline even before timeout callbacks", async () => {
  let now = 0;
  let reads = 0;
  let queueReached!: () => void;
  const queued = new Promise<void>((resolve) => { queueReached = resolve; });
  const clock = spyOn(performance, "now").mockImplementation(() => {
    reads += 1;
    if (reads === 6) queueReached();
    return now;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  let expiredCaptureRan = false;
  let first: Promise<unknown> | undefined;
  let second: Promise<unknown> | undefined;
  try {
    first = withGitWorkspaceObservation(tmpdir(), async () => { started(); await held; return true; });
    await entered;
    second = withGitWorkspaceObservation(tmpdir(), async () => { expiredCaptureRan = true; return true; });
    await queued;
    now = 16_000;
    release();
    expect(await second).toBeNull();
    expect(await first).toBe(true);
    expect(expiredCaptureRan).toBe(false);
    expect(await withGitWorkspaceObservation(tmpdir(), async () => true)).toBe(true);
  } finally { release(); await Promise.allSettled([first, second]); clock.mockRestore(); }
});
