import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  parseCliConnectorManifestJson,
  validateCliConnectorManifest
} from "./cliConnectorManifest.ts";

const FIXTURE = join(import.meta.dir, "../../../docs/fixtures/pi-cli-connector-manifest-v0.fixture.json");

describe("CLI connector manifest v0", () => {
  test("parses the neutral fixture manifest", async () => {
    const result = parseCliConnectorManifestJson(await Bun.file(FIXTURE).text());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.manifest).toMatchObject({
      id: "fixture-local-inbox",
      kind: "cli",
      manifest_version: "pi-cli-connector.v0",
      timeout: { default_ms: 5000, max_ms: 30000 }
    });
    expect(result.manifest.commands[0]).toMatchObject({
      name: "sync_items",
      stdout: { mode: "json" },
      exit_codes: { success: [0] },
      cursor: { input_field: "cursor", output_field: "next_cursor" },
      idempotency: { input_field: "idempotency_key" }
    });
  });

  test("reports located validation errors for invalid manifests", () => {
    const issues = validateCliConnectorManifest({
      id: "bad provider",
      kind: "feishu",
      name: "",
      commands: [{
        command: { executable: "sh -c", args: ["{{input.missing}}"] },
        description: "",
        exit_codes: { success: [1] },
        input_schema: { type: "object", properties: { cursor: { type: "string" } } },
        name: "sync",
        output_schema: [],
        permission: "admin",
        stdout: { mode: "text" }
      }]
    });

    expect(issues).toEqual(expect.arrayContaining([
      { path: "manifest_version", message: "must be pi-cli-connector.v0" },
      { path: "id", message: "must use lowercase letters, digits, dot, underscore, or dash" },
      { path: "name", message: "must be a non-empty string" },
      { path: "kind", message: "must be cli" },
      { path: "commands[0].permission", message: "must be read, write, or dangerous" },
      { path: "commands[0].command.executable", message: "must be a safe executable name or path without shell syntax" },
      { path: "commands[0].command.args[0]", message: "template references unknown input field: missing" },
      { path: "commands[0].output_schema", message: "must be an object" },
      { path: "commands[0].stdout.mode", message: "must be json" },
      { path: "commands[0].exit_codes.success", message: "must include 0" }
    ]));
  });

  test("rejects malformed JSON with a root issue", () => {
    const result = parseCliConnectorManifestJson("{ nope");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected parse failure");
    expect(result.issues[0]?.path).toBe("$");
  });
});
