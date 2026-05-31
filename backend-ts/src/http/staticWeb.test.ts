import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDefaultRouter, createRequestHandler } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3018";
const tempRoots: string[] = [];

async function tempWebDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-web-"));
  tempRoots.push(root);
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<main>runner ui</main>");
  await writeFile(join(root, "assets", "app.js"), "console.log('ok')");
  return root;
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun static web UI", () => {
  test("serves SPA assets and fallback without shadowing API routes", async () => {
    const webDir = await tempWebDir();
    const handle = createRequestHandler(createDefaultRouter(), "", { webDir });

    const root = await handle(new Request(`${BASE_URL}/`));
    const asset = await handle(new Request(`${BASE_URL}/assets/app.js`));
    const spaRoute = await handle(new Request(`${BASE_URL}/issues/42`));
    const apiMissing = await handle(new Request(`${BASE_URL}/api/nope`));

    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toContain("text/html");
    expect(await root.text()).toContain("runner ui");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(await asset.text()).toContain("console.log");
    expect(spaRoute.status).toBe(200);
    expect(await spaRoute.text()).toContain("runner ui");
    expect(apiMissing.status).toBe(404);
    expect(await apiMissing.json()).toEqual({ message: "not found" });
  });
});
