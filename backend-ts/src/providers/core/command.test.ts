import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProviderCommand } from "./command.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("provider command detection", () => {
  test("treats an executable path containing spaces as one path", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider command "));
    roots.push(root);
    const executable = join(root, "Application Support", "xuanwu.qodercli.mjs");
    await mkdir(join(root, "Application Support"), { recursive: true });
    await writeFile(executable, "#!/usr/bin/env node\n", "utf8");
    await chmod(executable, 0o755);

    expect(detectProviderCommand(executable)).toEqual({ installed: true, path: executable });
  });

  test("still supports a quoted executable followed by arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-command-"));
    roots.push(root);
    const executable = join(root, "provider executable");
    await writeFile(executable, "#!/bin/sh\n", "utf8");
    await chmod(executable, 0o755);

    expect(detectProviderCommand(`"${executable}" --stdio`)).toEqual({ installed: true, path: executable });
  });
});
