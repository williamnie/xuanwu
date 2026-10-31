import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNodeCliConfig } from "./cli.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
});

async function home(config?: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "xuanwu-node-cli-"));
  roots.push(dir);
  if (config !== undefined) {
    await Bun.write(join(dir, ".xuanwu", "node.json"), JSON.stringify(config));
  }
  return dir;
}

describe("resolveNodeCliConfig", () => {
  test("reads the default config file", async () => {
    const HOME = await home({ hub: "http://100.64.0.1:8787", roots: ["/srv/code"], token: "xwn_file" });
    expect(await resolveNodeCliConfig([], { HOME })).toEqual({
      allowedRoots: ["/srv/code"], hubUrl: "http://100.64.0.1:8787", token: "xwn_file"
    });
  });

  test("flags override the environment, which overrides the file", async () => {
    const HOME = await home({ hub: "http://file:1", roots: ["/file"], token: "xwn_file" });
    const config = await resolveNodeCliConfig(
      ["--hub=http://flag:2", "--root", "/a", "--root", "/b", "--max-parallel", "3"],
      { HOME, XUANWU_NODE_HUB: "http://env:3", XUANWU_NODE_TOKEN: "xwn_env" }
    );
    expect(config).toEqual({ allowedRoots: ["/a", "/b"], hubUrl: "http://flag:2", maxParallel: 3, token: "xwn_env" });
  });

  test("rejects missing or malformed settings", async () => {
    const HOME = await home();
    await expect(resolveNodeCliConfig([], { HOME })).rejects.toThrow("missing hub address");
    await expect(resolveNodeCliConfig(["--hub", "100.64.0.1:8787", "--token", "t"], { HOME })).rejects.toThrow("http://");
    await expect(resolveNodeCliConfig(["--hub", "http://h:1"], { HOME })).rejects.toThrow("missing node token");
    await expect(resolveNodeCliConfig(["--bogus"], { HOME })).rejects.toThrow("unknown option");
    await expect(resolveNodeCliConfig(["--token"], { HOME })).rejects.toThrow("missing value for --token");
    await expect(resolveNodeCliConfig(["--hub", "http://h:1", "--token", "t", "--max-parallel", "0"], { HOME })).rejects.toThrow("between 1 and 64");
  });

  test("an explicit --config file must exist", async () => {
    const HOME = await home();
    const path = join(HOME, "custom.json");
    await expect(resolveNodeCliConfig(["--config", path], { HOME })).rejects.toThrow("cannot read node config");
    await writeFile(path, "[]");
    await expect(resolveNodeCliConfig(["--config", path], { HOME })).rejects.toThrow("must be a JSON object");
  });
});
