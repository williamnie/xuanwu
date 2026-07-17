import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./command.ts";
import { Database } from "bun:sqlite";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { force: true, recursive: true });
});

describe("secrets CLI", () => {
  test("puts, rotates, inspects metadata, revokes, and audits without readback", async () => {
    const root = mkdtempSync(join(tmpdir(), "secrets-cli-"));
    roots.push(root);
    const dbPath = join(root, "runner.db");
    const valuePath = join(root, "value.txt");
    writeFileSync(valuePath, "first-cli-secret\n");

    const created = await cli([
      "secrets", "put", "--state-dir", root, "--db", dbPath,
      "--name", "connectors/demo/token", "--value-file", valuePath,
      "--actor", "operator", "--reason", "initial setup", "--json"
    ]);
    expect(created.code).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({
      ref: "secret://connectors/demo/token",
      status: "active",
      version: 1
    });
    expect(created.stdout).not.toContain("first-cli-secret");
    expect(readFileSync(join(root, "secrets", "store.json"), "utf8")).not.toContain("first-cli-secret");

    const status = await cli([
      "secrets", "status", "--state-dir", root,
      "--ref", "secret://connectors/demo/token", "--json"
    ]);
    expect(JSON.parse(status.stdout)).not.toHaveProperty("value");

    writeFileSync(valuePath, "second-cli-secret\n");
    const rotated = await cli([
      "secrets", "rotate", "--state-dir", root, "--db", dbPath,
      "--ref", "secret://connectors/demo/token", "--value-file", valuePath,
      "--actor", "operator", "--reason", "scheduled rotation", "--json"
    ]);
    expect(JSON.parse(rotated.stdout)).toMatchObject({ status: "active", version: 2 });

    const revoked = await cli([
      "secrets", "revoke", "--state-dir", root, "--db", dbPath,
      "--ref", "secret://connectors/demo/token",
      "--actor", "operator", "--reason", "connector removed", "--json"
    ]);
    expect(JSON.parse(revoked.stdout)).toMatchObject({ status: "revoked", version: 2 });
    const database = new Database(dbPath, { readonly: true });
    const events = database.query<{ event_type: string; payload_json: string }, []>(
      "select event_type, payload_json from pi_action_events where event_type like 'secret.%' order by id"
    ).all();
    database.close();
    expect(events.map((event) => event.event_type)).toEqual(["secret.created", "secret.rotated", "secret.revoked"]);
    expect(JSON.stringify(events)).not.toContain("first-cli-secret");
    expect(JSON.stringify(events)).not.toContain("second-cli-secret");
  });

  test("scans historical payloads but never includes matched values", async () => {
    const root = mkdtempSync(join(tmpdir(), "secrets-scan-cli-"));
    roots.push(root);
    const dbPath = join(root, "runner.db");
    const setup = await cli(["secrets", "put", "--state-dir", root, "--db", dbPath,
      "--name", "demo/key", "--value-file", seedValue(root, "bootstrap-secret"),
      "--actor", "operator", "--reason", "bootstrap", "--json"]);
    expect(setup.code).toBe(0);
    const scan = await cli(["secrets", "scan", "--state-dir", root, "--db", dbPath, "--json"]);
    expect(scan.code).toBe(0);
    expect(JSON.parse(scan.stdout)).toMatchObject({ values_included: false });
    expect(scan.stdout).not.toContain("bootstrap-secret");
  });
});

async function cli(args: string[]) {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const code = await runCli(args, stdout, stderr);
  return { code, stderr: stderr.text, stdout: stdout.text };
}

function seedValue(root: string, value: string): string {
  const path = join(root, `${crypto.randomUUID()}.txt`);
  writeFileSync(path, `${value}\n`);
  return path;
}

class MemoryWriter {
  text = "";
  write(chunk: string | Uint8Array): void {
    this.text += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
  }
}
