import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactionRegistry } from "../redactionRegistry.ts";
import { FileSecretStore } from "./fileBackend.ts";
import { KeychainSecretStore, type KeychainCommandRunner } from "./keychainBackend.ts";
import { migrateLegacySecretConfigs, scanHistoricalSecretPayloads } from "./migration.ts";
import { SecretService } from "./service.ts";
import { installPiProviderSecretOverride } from "./piProviderRuntime.ts";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { force: true, recursive: true });
});

describe("Xuanwu secret lifecycle", () => {
  test("redacts camelCase secret fields and values while preserving opaque refs", () => {
    expect(redactionRegistry.redactValue({
      appSecret: "do-not-show",
      secret_ref: "secret://integrations/feishu/app-secret",
      token_count: 42
    })).toEqual({
      appSecret: "[redacted]",
      secret_ref: "secret://integrations/feishu/app-secret",
      token_count: 42
    });
  });

  test("encrypts file secrets, rotates, revokes, audits metadata, and never offers readback metadata", () => {
    const root = fixtureRoot();
    const events: Array<{ operation: string; ref: string; version: number }> = [];
    const service = new SecretService(new FileSecretStore(root), (event) => events.push({
      operation: event.operation,
      ref: event.metadata.ref,
      version: event.metadata.version
    }));

    const created = service.put("providers/openai/api-key", "sk-live-first-secret", "operator", "initial setup");
    expect(created).toMatchObject({ status: "active", version: 1 });
    expect(created).not.toHaveProperty("value");
    expect(readFileSync(join(root, "secrets", "store.json"), "utf8")).not.toContain("sk-live-first-secret");
    expect(service.resolve(created.ref)).toBe("sk-live-first-secret");
    expect(redactionRegistry.redactText("key=sk-live-first-secret")).toBe("key=[redacted]");

    const rotated = service.rotate(created.ref, "sk-live-second-secret", "operator", "scheduled rotation");
    expect(rotated.version).toBe(2);
    expect(service.resolve(created.ref)).toBe("sk-live-second-secret");
    expect(readFileSync(join(root, "secrets", "store.json"), "utf8")).not.toContain("sk-live-second-secret");

    const revoked = service.revoke(created.ref, "operator", "provider removed");
    expect(revoked.status).toBe("revoked");
    expect(() => service.resolve(created.ref)).toThrow("secret is revoked");
    expect(events).toEqual([
      { operation: "created", ref: created.ref, version: 1 },
      { operation: "rotated", ref: created.ref, version: 2 },
      { operation: "revoked", ref: created.ref, version: 2 }
    ]);
  });

  test("uses keychain command stdin instead of exposing secret values in argv", () => {
    const root = fixtureRoot();
    const values = new Map<string, string>();
    const calls: Array<{ args: string[]; input: string }> = [];
    const run: KeychainCommandRunner = (args, input = "") => {
      calls.push({ args, input });
      const account = args[args.indexOf("-a") + 1];
      if (args[0] === "add-generic-password") { values.set(account, input.trimEnd()); return ok(); }
      if (args[0] === "find-generic-password") return { ...ok(), stdout: `${values.get(account) ?? ""}\n` };
      if (args[0] === "delete-generic-password") { values.delete(account); return ok(); }
      return { exitCode: 1, stderr: "unexpected", stdout: "" };
    };
    const service = new SecretService(new KeychainSecretStore(root, run));
    const created = service.put("connectors/github/token", "github-secret-value", "operator", "setup");
    expect(service.resolve(created.ref)).toBe("github-secret-value");
    service.revoke(created.ref, "operator", "revoke");
    expect(calls.flatMap((call) => call.args)).not.toContain("github-secret-value");
    expect(readFileSync(join(root, "secrets", "keychain-metadata.json"), "utf8")).not.toContain("github-secret-value");
  });

  test("migrates legacy config to refs and scans historical payloads without returning values", () => {
    const root = fixtureRoot();
    const agentDir = join(root, "pi-runtime", "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: { openai: { api: "openai-responses", apiKey: "legacy-provider-secret" } }
    }));
    writeFileSync(join(root, "runner-settings.local.json"), JSON.stringify({
      integrations: { feishu: { appId: "cli", appSecret: "legacy-feishu-secret" } }
    }));
    const service = new SecretService(new FileSecretStore(root));

    const dryRun = migrateLegacySecretConfigs({ actor: "operator", apply: false, reason: "migration", secrets: service, stateDir: root });
    expect(dryRun).toMatchObject({ applied: false, migrated_fields: 0 });
    expect(readFileSync(join(agentDir, "models.json"), "utf8")).toContain("legacy-provider-secret");

    const applied = migrateLegacySecretConfigs({ actor: "operator", apply: true, reason: "migration", secrets: service, stateDir: root });
    expect(applied).toMatchObject({ applied: true, migrated_fields: 2, source_of_truth: "secret_ref" });
    const models = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
    expect(models.providers.openai).toEqual({ api: "openai-responses", apiKeyRef: "secret://pi/provider/openai/api-key" });
    expect(readFileSync(join(root, "runner-settings.local.json"), "utf8")).not.toContain("legacy-feishu-secret");

    const dbPath = join(root, "history.db");
    const db = new Database(dbPath, { create: true });
    db.run("create table history (id integer primary key, payload text not null)");
    db.run("insert into history(payload) values (?)", [JSON.stringify({ api_key: "historical-secret" })]);
    db.close();
    const report = scanHistoricalSecretPayloads({ dbPath, stateDir: root });
    expect(report).toMatchObject({ values_included: false });
    expect(JSON.stringify(report)).not.toContain("historical-secret");
    expect((report.finding_count as number)).toBeGreaterThan(0);
  });

  test("reports a clear missing-key error", () => {
    const service = new SecretService(new FileSecretStore(fixtureRoot()));
    expect(() => service.resolve("secret://missing/key")).toThrow("secret is not configured");
  });

  test("materializes only the selected PI provider secret as an in-memory runtime override", async () => {
    const root = fixtureRoot();
    const service = new SecretService(new FileSecretStore(root));
    const metadata = service.put("pi/provider/openai/api-key", "runtime-only-key", "operator", "setup");
    const agentDir = join(root, "pi-runtime", "agent");
    mkdirSync(agentDir, { recursive: true });
    const modelsPath = join(agentDir, "models.json");
    writeFileSync(modelsPath, JSON.stringify({ providers: { openai: { apiKeyRef: metadata.ref } } }));
    const overrides: Record<string, string> = {};

    await installPiProviderSecretOverride({
      setRuntimeApiKey(provider, apiKey) { overrides[provider] = apiKey; }
    }, modelsPath, root, "openai");

    expect(overrides).toEqual({ openai: "runtime-only-key" });
    expect(readFileSync(modelsPath, "utf8")).not.toContain("runtime-only-key");
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "xuanwu-secrets-"));
  roots.push(root);
  return root;
}

function ok() {
  return { exitCode: 0, stderr: "", stdout: "" };
}
