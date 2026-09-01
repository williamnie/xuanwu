import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerReleaseUpdateRoutes } from "./releaseUpdateApi.ts";
import { createRouter } from "./router.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("release update API", () => {
  test("reports an available release and enqueues one audited OS-updater job", async () => {
    const stateDir = await tempState();
    let triggers = 0;
    const router = createRouter();
    registerReleaseUpdateRoutes(router, {
      checkUpdate: async () => ({ current: "v1.0.0", latest: "v1.1.0", update_available: true }),
      jobID: () => "job-1",
      now: () => new Date("2026-09-01T02:03:04.000Z"),
      releaseInstall: true,
      stateDir,
      triggerUpdate: async () => { triggers += 1; }
    });

    const status = await jsonBody(await router.handle(new Request("http://runner/api/system/update")));
    expect(status).toMatchObject({ current: "v1.0.0", latest: "v1.1.0", supported: true, update_available: true });

    const response = await router.handle(new Request("http://runner/api/system/update", {
      body: JSON.stringify({ confirm: "upgrade", version: "v1.1.0" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }));
    expect(response.status).toBe(202);
    expect(await jsonBody(response)).toMatchObject({ accepted: true, job: { id: "job-1", state: "pending" } });
    expect(triggers).toBe(1);
    expect((await readFile(join(stateDir, "release-update-jobs", "pending"), "utf8")).trim()).toBe("job-1");
    expect((await readFile(join(stateDir, "release-update-jobs", "job-1", "target_version"), "utf8")).trim()).toBe("v1.1.0");

    const duplicate = await router.handle(new Request("http://runner/api/system/update", {
      body: JSON.stringify({ confirm: "upgrade", version: "v1.1.0" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }));
    expect(duplicate.status).toBe(409);
  });

  test("fails closed when the independent updater cannot start", async () => {
    const stateDir = await tempState();
    const router = createRouter();
    registerReleaseUpdateRoutes(router, {
      checkUpdate: async () => ({ current: "v2.0.0", latest: "v2.0.1", update_available: true }),
      jobID: () => "job-failed",
      releaseInstall: true,
      stateDir,
      triggerUpdate: async () => { throw new Error("service missing"); }
    });
    const response = await router.handle(new Request("http://runner/api/system/update", {
      body: JSON.stringify({ confirm: "upgrade", version: "v2.0.1" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }));
    expect(response.status).toBe(503);
    expect((await readFile(join(stateDir, "release-update-jobs", "job-failed", "state"), "utf8")).trim()).toBe("failed");
    expect((await readFile(join(stateDir, "release-update-jobs", "job-failed", "error_code"), "utf8")).trim()).toBe("updater_start_failed");
  });

  test("rejects unconfirmed mutations and source-checkout runtimes", async () => {
    const stateDir = await tempState();
    const router = createRouter();
    registerReleaseUpdateRoutes(router, { releaseInstall: false, stateDir });
    const status = await jsonBody(await router.handle(new Request("http://runner/api/system/update")));
    expect(status).toMatchObject({ release_install: false, supported: false, update_available: false });
    const response = await router.handle(new Request("http://runner/api/system/update", {
      body: JSON.stringify({ confirm: "no", version: "v1.0.0" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }));
    expect(response.status).toBe(400);
  });
});

async function tempState(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-release-update-api-"));
  roots.push(root);
  return root;
}

async function jsonBody(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}
