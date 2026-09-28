import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunnerDatabase } from "../../db/database.ts";
import { readLocalSettingsSync, type RunnerLocalSettings } from "../../config/localSettings.ts";
import { createSecretService } from "../../security/secrets/service.ts";

export const JEV_SKILL_ID = "jev-assist";
export const JEV_CAPABILITY_ID = "jev-assist:tool:jev_classify_report";
export const JEV_TOOL_NAME = "jev_classify_report";
export const JEV_SCOPES = ["web", "github", "feishu", "telegram", "background"] as const;
export type JevScope = typeof JEV_SCOPES[number];
export type JevSkillConfig = {
  enabled: boolean;
  mode: "shadow" | "assist";
  model: string;
  scopes: JevScope[];
  apiKeyRef: string;
  apiKeyEnvFile: string;
  minConfidence: number;
  timeoutMs: number;
};
export type JevConfiguration = { config: JevSkillConfig; diagnostic: string; migrated: boolean };
const stateDirs = new WeakMap<RunnerDatabase, string>();

export function configureJevStateDirectory(db: RunnerDatabase, stateDir?: string): void {
  if (stateDir) stateDirs.set(db, stateDir);
}
export function jevStateDirectory(db: RunnerDatabase): string { return stateDirs.get(db) ?? dirname(db.path); }

export function defaultJevConfig(): JevSkillConfig {
  return { enabled: false, mode: "shadow", model: "jev-latest", scopes: [], apiKeyRef: "env://TYPESAFE_API_KEY",
    apiKeyEnvFile: "", minConfidence: 0.9, timeoutMs: 5000 };
}

export function readJevConfig(db: RunnerDatabase): JevConfiguration {
  try { return jevConfigFromSettings(readLocalSettingsSync(jevStateDirectory(db))); }
  catch { return { config: defaultJevConfig(), diagnostic: "settings_unavailable", migrated: false }; }
}

/** 兼容旧配置但不扩大外发范围；新配置存在（包括关闭）时永远优先。 */
export function jevConfigFromSettings(settings: RunnerLocalSettings): JevConfiguration {
  const configured = settings.optionalSkills?.[JEV_SKILL_ID];
  const issueSync = record(settings.integrations?.github?.issueSync);
  const legacy = record(issueSync.jev);
  const migrated = configured === undefined && Object.keys(legacy).length > 0;
  if (migrated && legacy.mode !== undefined && !["off", "shadow", "routing"].includes(String(legacy.mode))) {
    return { config: defaultJevConfig(), diagnostic: "invalid_configuration", migrated };
  }
  const raw = configured ?? (migrated ? {
    ...legacy, enabled: issueSync.enabled === true && ["shadow", "routing"].includes(String(legacy.mode)),
    mode: legacy.mode === "routing" ? "assist" : "shadow", scopes: ["github"]
  } : {});
  try { return { config: parseJevConfig(raw), diagnostic: "", migrated }; }
  catch { return { config: defaultJevConfig(), diagnostic: "invalid_configuration", migrated }; }
}

export function parseJevConfig(value: unknown): JevSkillConfig {
  const raw = record(value);
  const result = { ...defaultJevConfig(), ...raw } as JevSkillConfig;
  if (typeof result.enabled !== "boolean" || !["shadow", "assist"].includes(result.mode)) throw new Error("invalid_mode");
  if (typeof result.model !== "string" || !/^jev-[a-z0-9.-]{1,80}$/.test(result.model)) throw new Error("invalid_model");
  if (!Array.isArray(result.scopes) || result.scopes.some(scope => !JEV_SCOPES.includes(scope))) throw new Error("invalid_scopes");
  if (typeof result.apiKeyRef !== "string" || (result.apiKeyRef !== "" && !/^(secret|env):\/\/[^\s]+$/.test(result.apiKeyRef))) throw new Error("invalid_credential_reference");
  if (typeof result.apiKeyEnvFile !== "string" || (result.apiKeyEnvFile !== "" && !result.apiKeyEnvFile.startsWith("/"))) throw new Error("invalid_credential_file");
  if (!Number.isFinite(result.minConfidence) || result.minConfidence < 0.5 || result.minConfidence > 1) throw new Error("invalid_confidence");
  if (!Number.isInteger(result.timeoutMs) || result.timeoutMs < 500 || result.timeoutMs > 30000) throw new Error("invalid_timeout");
  // 只保留已知配置字段，不能把提交的明文或任意 transport 字段落盘。
  return { enabled: result.enabled, mode: result.mode, model: result.model, scopes: [...new Set(result.scopes)],
    apiKeyRef: result.apiKeyRef, apiKeyEnvFile: result.apiKeyEnvFile, minConfidence: result.minConfidence, timeoutMs: result.timeoutMs };
}

export function jevPackage(): { installed: boolean; directory: string; command: string; diagnostic: string } {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const assetRoot = process.env.PI_PACKAGE_DIR?.trim();
  // 开发态 PI loader 会把 PI_PACKAGE_DIR 指向 npm SDK 资源，应用技能仍在仓库中。
  const sdkResources = assetRoot && resolve(assetRoot) === resolve(repoRoot, "backend-ts/node_modules/@earendil-works/pi-coding-agent");
  const root = assetRoot && !sdkResources ? assetRoot : (existsSync(join(repoRoot, "skills")) ? repoRoot : dirname(process.execPath));
  const directory = join(root, "skills", JEV_SKILL_ID);
  const command = Bun.which("node") || Bun.which("bun") || "";
  try {
    const entry = join(directory, "SKILL.md");
    const script = join(directory, "scripts", "server.mjs");
    if (!existsSync(entry) || !existsSync(script)) return { installed: false, directory, command, diagnostic: "skill_package_missing" };
    if (!statSync(entry).isFile() || statSync(entry).size > 128 * 1024 || !statSync(script).isFile()) {
      return { installed: false, directory, command, diagnostic: "skill_package_invalid" };
    }
    const text = readFileSync(entry, "utf8");
    if (!text.startsWith("---\n") || !/^name: jev-assist\s*$/m.test(text) || !/^description: .+/m.test(text) || statSync(script).size > 128 * 1024) {
      return { installed: false, directory, command, diagnostic: "skill_package_invalid" };
    }
    return { installed: true, directory, command, diagnostic: command ? "" : "skill_runtime_missing" };
  } catch { return { installed: false, directory, command, diagnostic: "skill_package_invalid" }; }
}

/** 状态检查不读取密钥内容，也不发网络请求。 */
export function jevCredentialStatus(db: RunnerDatabase, config: JevSkillConfig) {
  try {
    if (config.apiKeyEnvFile) {
      const stat = statSync(config.apiKeyEnvFile);
      return { configured: stat.isFile() && stat.size <= 65536 && (stat.mode & 0o077) === 0, source: "file" };
    }
    if (config.apiKeyRef.startsWith("env://")) return { configured: Boolean(process.env[config.apiKeyRef.slice(6)]?.trim()), source: "environment" };
    if (config.apiKeyRef.startsWith("secret://")) return { configured: createSecretService({ stateDir: jevStateDirectory(db) }).describe(config.apiKeyRef)?.status === "active", source: "secret" };
  } catch { /* 单个可选技能的凭据故障不能阻断宿主。 */ }
  return { configured: false, source: "none" };
}
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
