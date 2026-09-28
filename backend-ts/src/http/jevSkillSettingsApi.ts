import type { RunnerConfig } from "../config/env.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { createPiActionEvent } from "../db/repositories/pi.ts";
import { localSettingsPath, updateLocalSettingsFile } from "../config/localSettings.ts";
import { createDatabaseSecretService } from "../security/secrets/service.ts";
import { registerSecretForRedaction } from "../security/redactionRegistry.ts";
import { configureJevStateDirectory, JEV_SKILL_ID, jevCredentialStatus, jevPackage, jevStateDirectory, parseJevConfig, readJevConfig, record, type JevSkillConfig } from "../skills/jev/config.ts";
import { invokeJevSkill, jevCooldownUntil, resetJevCircuit } from "../skills/jev/invoke.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";

type Context = { config?: RunnerConfig; database: RunnerDatabase };
const KEY_NAME = "skills/jev-assist/api-key";

export function registerJevSkillSettingsRoutes(router: Router, context: Context): void {
  configureJevStateDirectory(context.database, context.config?.stateDir);
  router.get("/api/pi/skills/jev-assist/settings", () => json(publicJevSkillSettings(context.database)));
  router.put("/api/pi/skills/jev-assist/settings", async request => json(await saveJevSkillSettings(context.database, await bodyObject(request))));
  router.post("/api/pi/skills/jev-assist/test", async request => {
    const body = await bodyObject(request);
    const config = submittedConfig(body, readJevConfig(context.database).config);
    const key = submittedKey(body);
    const result = await invokeJevSkill({ db: context.database, input: { title: "Synthetic connectivity test", body: "How do I view task status?" } }, { config, key });
    const output = record(result.output);
    return json({ ok: output.status === "observed", status: output.status, reason: output.reason, duration_ms: result.duration_ms, model: output.model });
  });
}

export function publicJevSkillSettings(db: RunnerDatabase): Record<string, unknown> {
  const { config, diagnostic, migrated } = readJevConfig(db);
  const pkg = jevPackage();
  const credential = jevCredentialStatus(db, config);
  const cooldown = jevCooldownUntil(db);
  const availability = diagnostic ? "invalid" : !pkg.installed || pkg.diagnostic ? "missing"
    : !config.enabled ? "disabled" : !credential.configured ? "unconfigured" : cooldown ? "cooldown" : "ready";
  const recent = db.sqlite.query<{ payload_json: string; created_at: string }, []>(`
    select payload_json, created_at from pi_action_events
    where event_type='optional_skill.called' and json_valid(payload_json)
      and json_extract(payload_json, '$.skill_id')='jev-assist'
    order by id desc limit 20
  `).all().map(row => {
    const value = record(JSON.parse(row.payload_json));
    return { status: value.status, reason: value.reason, duration_ms: value.duration_ms, model: value.model, source: value.source, created_at: row.created_at };
  });
  return { skill_id: JEV_SKILL_ID, installed: pkg.installed, enabled: config.enabled, mode: config.mode, model: config.model,
    scopes: config.scopes, min_confidence: config.minConfidence, timeout_ms: config.timeoutMs, api_key_configured: credential.configured,
    credential_source: credential.source, availability, diagnostic: diagnostic || pkg.diagnostic, migrated_from_github: migrated,
    cooldown_until: cooldown, recent_calls: recent };
}

export async function saveJevSkillSettings(db: RunnerDatabase, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  // 写入前完成所有校验；明文只流向 SecretService。
  const next = submittedConfig(body, readJevConfig(db).config);
  const key = submittedKey(body);
  const secrets = createDatabaseSecretService(db, { stateDir: jevStateDirectory(db) });
  if (key) {
    next.apiKeyRef = secrets.putOrRotate(KEY_NAME, key, "user", "updated optional Jev skill credential").ref;
    next.apiKeyEnvFile = "";
  }
  await updateLocalSettingsFile(localSettingsPath(jevStateDirectory(db)), current => ({
    ...current, optionalSkills: { ...current.optionalSkills, [JEV_SKILL_ID]: next }
  }));
  // 只撤销本技能管理的密钥，不影响用户共享的 env/file 或其他 secret ref。
  if (body.clear_api_key === true && secrets.describe(`secret://${KEY_NAME}`)?.status === "active") {
    secrets.revoke(`secret://${KEY_NAME}`, "user", "removed optional Jev skill credential");
  }
  resetJevCircuit(db);
  createPiActionEvent(db, { actor: "user", event_type: "optional_skill.settings_updated", action_id: `skill-settings:${crypto.randomUUID()}`,
    payload_json: JSON.stringify({ skill_id: JEV_SKILL_ID, enabled: next.enabled, mode: next.mode, scopes: next.scopes,
      credential_changed: Boolean(key) || body.clear_api_key === true }), reason: "updated optional skill settings" });
  return publicJevSkillSettings(db);
}

function submittedConfig(body: Record<string, unknown>, current: JevSkillConfig): JevSkillConfig {
  const fields = new Set(["enabled", "mode", "model", "scopes", "min_confidence", "timeout_ms", "api_key", "clear_api_key"]);
  if (Object.keys(body).some(key => !fields.has(key))) throw new HttpError(400, "包含不支持的技能设置字段");
  if (body.clear_api_key !== undefined && typeof body.clear_api_key !== "boolean") throw new HttpError(400, "clear_api_key 必须是布尔值");
  const key = submittedKey(body);
  if (body.clear_api_key === true && key) throw new HttpError(400, "移除凭据与输入新 Key 不能同时提交");
  const patch = Object.fromEntries(Object.entries(body).filter(([key]) => !["api_key", "clear_api_key", "min_confidence", "timeout_ms"].includes(key)));
  try { return parseJevConfig({ ...current, ...patch,
    ...(body.min_confidence === undefined ? {} : { minConfidence: body.min_confidence }),
    ...(body.timeout_ms === undefined ? {} : { timeoutMs: body.timeout_ms }),
    ...(body.clear_api_key === true ? { apiKeyRef: "", apiKeyEnvFile: "" } : {}) }); }
  catch { throw new HttpError(400, "Jev 设置无效，请检查模式、模型、使用范围、置信度和超时"); }
}
function submittedKey(body: Record<string, unknown>): string {
  if (body.api_key === undefined) return "";
  if (typeof body.api_key !== "string") throw new HttpError(400, "API Key 必须是字符串");
  const key = body.api_key.trim();
  if (key) registerSecretForRedaction(key);
  if (key.length > 4096 || /\s/.test(key)) throw new HttpError(400, "API Key 格式无效");
  return key;
}
async function bodyObject(request: Request): Promise<Record<string, unknown>> {
  const body = await parseJsonBody(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "请求体必须为对象");
  return body as Record<string, unknown>;
}
