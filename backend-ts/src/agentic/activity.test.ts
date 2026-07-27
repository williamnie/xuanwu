import { describe, expect, test } from "bun:test";
import { createAgenticIdleMemoryReclaimer } from "./activity.ts";

describe("Agentic idle memory reclaimer", () => {
  test("waits for every concurrent request and cancels reclaim when new work starts", async () => {
    let reclaims = 0;
    const idle = createAgenticIdleMemoryReclaimer({ delayMs: 5, reclaim: () => { reclaims += 1; } });

    idle.requestStarted();
    idle.requestStarted();
    idle.requestFinished();
    await Bun.sleep(15);
    expect(reclaims).toBe(0);

    idle.requestFinished();
    await Bun.sleep(15);
    expect(reclaims).toBe(1);

    idle.requestStarted();
    idle.requestFinished();
    idle.requestStarted();
    await Bun.sleep(15);
    expect(reclaims).toBe(1);

    idle.requestFinished();
    await Bun.sleep(15);
    expect(reclaims).toBe(2);
  });
});
