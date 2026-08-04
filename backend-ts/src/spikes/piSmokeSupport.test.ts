import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolvePiPackageAssetDir } from "./piSmokeSupport.ts";

describe("PI smoke runtime support", () => {
  test("prefers staged PI package assets next to the deployed binary", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-pi-assets-"));
    try {
      const packageDir = join(root, "pi-coding-agent");
      await mkdir(packageDir, { recursive: true });
      await writeFile(join(packageDir, "package.json"), "{}\n");

      const resolved = resolvePiPackageAssetDir("/missing/repo", {
        cwd: join(root, "work"),
        execPath: join(root, "bin", "xuanwu")
      });

      expect(resolved).toBe(packageDir);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
