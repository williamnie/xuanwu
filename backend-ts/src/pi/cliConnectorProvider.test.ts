import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCliConnectorRegistry } from "./cliConnectorProvider.ts";

const FIXTURE = join(import.meta.dir, "../../../docs/fixtures/pi-cli-connector-manifest-v0.fixture.json");
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("CLI connector provider registry", () => {
  test("maps enabled manifest commands into AssistantTool records", async () => {
    const dir = await fixtureDir({ valid: true });
    const registry = loadCliConnectorRegistry({ env: { FIXTURE_INBOX_TOKEN: "token-value" }, manifestDirs: [dir] });

    expect(registry.diagnostics).toEqual([]);
    expect(registry.providers).toEqual([expect.objectContaining({
      id: "fixture-local-inbox",
      kind: "cli",
      status: "enabled"
    })]);
    expect(registry.tools).toEqual([expect.objectContaining({
      description: "Fetch new inbox items after an optional cursor.",
      input_schema: expect.objectContaining({ type: "object" }),
      name: "sync_items",
      permission: "read",
      provider_id: "fixture-local-inbox",
      timeout_ms: 10000
    })]);
    expect(registry.tools[0]?.audit.redact).toEqual(expect.arrayContaining(["env.FIXTURE_INBOX_TOKEN"]));
  });

  test("keeps disabled or invalid connector manifests from breaking registry load", async () => {
    const dir = await fixtureDir({ invalid: true, valid: true });
    const registry = loadCliConnectorRegistry({ env: {}, manifestDirs: [dir, join(dir, "missing")] });

    expect(registry.providers).toEqual([expect.objectContaining({
      id: "fixture-local-inbox",
      status: "disabled"
    })]);
    expect(registry.tools).toEqual([]);
    expect(registry.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      "directory_unavailable",
      "manifest_invalid"
    ]));
  });
});

async function fixtureDir(options: { invalid?: boolean; valid?: boolean }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codex-runner-cli-provider-"));
  tempRoots.push(dir);
  if (options.valid) await writeFile(join(dir, "fixture.json"), readFileSync(FIXTURE, "utf8"));
  if (options.invalid) await writeFile(join(dir, "broken.json"), "{\"id\":\"bad provider\"}");
  return dir;
}
