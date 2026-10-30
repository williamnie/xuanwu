import { afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

export async function tempStateDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "xuanwu-config-"));
  tempRoots.push(path);
  return path;
}
