import { Database } from "bun:sqlite";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isSensitiveFieldName, redactionRegistry } from "../redactionRegistry.ts";
import type { SecretService } from "./service.ts";

type ConfigFinding = { field: string; source: string };
type ScanFinding = { column: string; matches: number; source: "database"; table: string } |
  { matches: number; source: "config"; path: string };

export function migrateLegacySecretConfigs(input: {
  actor: string;
  apply: boolean;
  reason: string;
  secrets: SecretService;
  stateDir: string;
}): Record<string, unknown> {
  const plans = configPlans(input.stateDir);
  const findings = plans.flatMap((plan) => plan.findings);
  if (input.apply) {
    for (const plan of plans) plan.apply(input.secrets, input.actor, input.reason);
  }
  return {
    operation: "migrate_legacy_secret_configs",
    applied: input.apply,
    findings,
    migrated_fields: input.apply ? findings.length : 0,
    source_of_truth: "secret_ref",
    legacy_dual_read: true,
    legacy_dual_write: false
  };
}

export function scanHistoricalSecretPayloads(input: { dbPath: string; stateDir: string }): Record<string, unknown> {
  const findings: ScanFinding[] = [];
  if (existsSync(input.dbPath)) findings.push(...scanDatabase(input.dbPath));
  for (const path of configPaths(input.stateDir)) {
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, "utf8");
    const value = parseJson(raw);
    const matches = redactionRegistry.findings(value ?? raw).length;
    if (matches > 0) findings.push({ matches, path: publicConfigPath(path, input.stateDir), source: "config" });
  }
  return {
    operation: "scan_historical_secret_payloads",
    scanned_at: new Date().toISOString(),
    findings,
    finding_count: findings.reduce((total, finding) => total + finding.matches, 0),
    values_included: false
  };
}

function scanDatabase(path: string): ScanFinding[] {
  const database = new Database(path, { readonly: true, strict: true });
  try {
    const findings: ScanFinding[] = [];
    const tables = database.query<{ name: string }, []>(`
      select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name
    `).all();
    for (const { name: table } of tables) {
      const columns = database.query<{ name: string; type: string }, []>(`pragma table_info(${quote(table)})`).all()
        .filter((column) => /TEXT|JSON|CHAR|CLOB/i.test(column.type));
      for (const column of columns) {
        let matches = 0;
        const rows = database.query<Record<string, unknown>, []>(
          `select ${quote(column.name)} as value from ${quote(table)} where ${quote(column.name)} is not null and ${quote(column.name)} != ''`
        ).all();
        for (const row of rows) {
          const value = String(row.value ?? "");
          const inspected = isSensitiveFieldName(column.name)
            ? { [column.name]: parseJson(value) ?? value }
            : parseJson(value) ?? value;
          if (redactionRegistry.findings(inspected).length > 0) matches += 1;
        }
        if (matches > 0) findings.push({ column: column.name, matches, source: "database", table });
      }
    }
    return findings;
  } finally {
    database.close();
  }
}

function configPlans(stateDir: string): Array<{ apply(secrets: SecretService, actor: string, reason: string): void; findings: ConfigFinding[] }> {
  return [modelsPlan(join(stateDir, "pi-runtime", "agent", "models.json")), localSettingsPlan(join(stateDir, "runner-settings.local.json"))]
    .filter((plan) => plan.findings.length > 0);
}

function modelsPlan(path: string) {
  const document = readJsonObject(path);
  const providers = record(document?.providers);
  const findings = Object.entries(providers).flatMap(([id, value]) => {
    const provider = record(value);
    return stringValue(provider.apiKey) === "" ? [] : [{ field: `providers.${id}.apiKey`, source: publicFilename(path) }];
  });
  return {
    findings,
    apply(secrets: SecretService, actor: string, reason: string) {
      if (!document) return;
      for (const [id, value] of Object.entries(providers)) {
        const provider = record(value);
        const apiKey = stringValue(provider.apiKey);
        if (apiKey === "") continue;
        provider.apiKeyRef = secrets.putOrRotate(`pi/provider/${encodeURIComponent(id)}/api-key`, apiKey, actor, reason).ref;
        delete provider.apiKey;
        providers[id] = provider;
      }
      document.providers = providers;
      writeJson(path, document);
    }
  };
}

function localSettingsPlan(path: string) {
  const document = readJsonObject(path);
  const integrations = record(document?.integrations);
  const mappings = [
    ["feishu", "appSecret", "appSecretRef", "integrations/feishu/app-secret"],
    ["feishu", "encryptKey", "encryptKeyRef", "integrations/feishu/encrypt-key"],
    ["feishu", "verificationToken", "verificationTokenRef", "integrations/feishu/verification-token"],
    ["github", "token", "tokenRef", "integrations/github/token"],
    ["gitlab", "token", "tokenRef", "integrations/gitlab/token"]
  ] as const;
  const findings = mappings.flatMap(([integration, valueKey]) =>
    stringValue(record(integrations[integration])[valueKey]) === ""
      ? []
      : [{ field: `integrations.${integration}.${valueKey}`, source: publicFilename(path) }]
  );
  return {
    findings,
    apply(secrets: SecretService, actor: string, reason: string) {
      if (!document) return;
      for (const [integration, valueKey, refKey, name] of mappings) {
        const config = record(integrations[integration]);
        const value = stringValue(config[valueKey]);
        if (value === "") continue;
        config[refKey] = secrets.putOrRotate(name, value, actor, reason).ref;
        delete config[valueKey];
        integrations[integration] = config;
      }
      document.integrations = integrations;
      writeJson(path, document);
    }
  };
}

function configPaths(stateDir: string): string[] {
  return [join(stateDir, "runner-settings.local.json"), join(stateDir, "pi-runtime", "agent", "models.json")];
}

function readJsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  const value = parseJson(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${publicFilename(path)} is not valid JSON object`);
  return value as Record<string, unknown>;
}

function parseJson(value: string): unknown | null {
  try { return JSON.parse(value); } catch { return null; }
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function writeJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function publicConfigPath(path: string, stateDir: string): string {
  return path.startsWith(stateDir) ? `<stateDir>${path.slice(stateDir.length)}` : publicFilename(path);
}

function publicFilename(path: string): string {
  return path.split(/[\\/]/).slice(-3).join("/");
}
