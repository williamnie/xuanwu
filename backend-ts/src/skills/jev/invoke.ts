import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { RunnerDatabase } from "../../db/database.ts";
import { createPiActionEvent } from "../../db/repositories/pi.ts";
import { invokeMcpTransport, type McpTransportInvokeRequest, type McpTransportInvokeResult } from "../../pi/mcpTransport.ts";
import type { ToolResult } from "../../pi/toolProviderEnvelope.ts";
import { createSecretService, resolveSecretLocator } from "../../security/secrets/service.ts";
import { assessDataEgress } from "../../security/promptInjectionDefense.ts";
import { registerSecretForRedaction } from "../../security/redactionRegistry.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import { JEV_SKILL_ID, jevPackage, jevStateDirectory, readJevConfig, record, type JevSkillConfig } from "./config.ts";
import { jevAllowed, jevScope, type JevContext } from "./policy.ts";
import { jevMcpServer } from "./registry.ts";

type Circuit = { fingerprint: string; failures: number; until: number; active: number };
const circuits = new WeakMap<RunnerDatabase, Circuit>();
export function resetJevCircuit(db: RunnerDatabase): void { circuits.delete(db); }
export function jevCooldownUntil(db: RunnerDatabase): string {
  const until = circuit(db, readJevConfig(db).config).until;
  return until > Date.now() ? new Date(until).toISOString() : "";
}
function circuit(db: RunnerDatabase, config: JevSkillConfig): Circuit {
  const fingerprint = JSON.stringify(config);
  let state = circuits.get(db);
  if (!state || state.fingerprint !== fingerprint) {
    state = { fingerprint, failures: 0, until: 0, active: 0 };
    circuits.set(db, state);
  }
  return state;
}

export type JevInvocation = {
  db: RunnerDatabase;
  context?: JevContext;
  input: Record<string, unknown>;
  invocationID?: string;
};
export type JevProbe = { config: JevSkillConfig; key?: string };
type Dependencies = { transport?: (input: McpTransportInvokeRequest) => Promise<McpTransportInvokeResult> };

/** 只有设置页的合成连接测试传 probe；模型工具入口永远使用实时宿主配置和权限。 */
export async function invokeJevSkill(request: JevInvocation, probe?: JevProbe, dependencies: Dependencies = {}): Promise<ToolResult> {
  const started = performance.now();
  const context = request.context ?? {};
  const current = readJevConfig(request.db);
  const config = probe?.config ?? current.config;
  const state = circuit(request.db, config);
  const initialFingerprint = JSON.stringify(current.config);
  const currentInvocationAllowed = () => stillAllowed(request, initialFingerprint) && circuits.get(request.db) === state;
  let acquired = false;
  let inputHash = "";
  const finish = (output: Record<string, unknown>): ToolResult => {
    const duration = Math.round(performance.now() - started);
    const value: Record<string, unknown> = { ...output, duration_ms: duration };
    // 不保存原文、上游响应或 transport 环境；审计写失败也不能阻断普通任务。
    try { createPiActionEvent(request.db, { actor: "optional_skill", event_type: "optional_skill.called",
      action_id: request.invocationID || `jev:${crypto.randomUUID()}`, conversation_id: context.conversationID,
      project_id: context.projectID, issue_id: context.issueID, delegation_id: context.delegationID, heartbeat_id: context.heartbeatID,
      payload_json: JSON.stringify({ skill_id: JEV_SKILL_ID, source: probe ? "connection_test" : jevScope(request.db, context),
        status: value.status, reason: value.reason, duration_ms: duration, model: value.model, input_sha256: inputHash }),
      reason: String(value.reason || "unavailable") }); } catch { /* 故障隔离，不写第二套状态账本。 */ }
    return { invocation_id: request.invocationID || crypto.randomUUID(), status: "succeeded", duration_ms: duration, output: value };
  };
  const unavailable = (reason: string) => finish({ status: "unavailable", reason, model: config.model, continue_without_skill: true });
  try {
    if (!probe && current.diagnostic) return unavailable(current.diagnostic);
    if (!probe && !config.enabled) return unavailable("disabled");
    if (!probe && !jevAllowed(request.db, context, config)) return unavailable("scope_denied");
    const server = jevMcpServer(config);
    if (!server) return unavailable(jevPackage().diagnostic || "skill_package_missing");
    if (!validReport(request.input)) return unavailable("invalid_input");
    if (!probe && state.until > Date.now()) return unavailable("cooldown");
    if (state.active >= 4) return unavailable("busy");
    state.active += 1; acquired = true;
    const key = probe?.key?.trim() || await resolveJevCredential(request.db, config);
    if (!key) return unavailable("credential_missing");
    registerSecretForRedaction(key);
    const input = Object.fromEntries(Object.entries(request.input).map(([name, text]) => [name, redactSensitiveText(String(text)).split(key).join("[redacted]")]));
    if (!assessDataEgress(input).allowed) return unavailable("sensitive_input");
    inputHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    // 凭据文件读取期间的禁用/配置变更在发请求前生效。
    if (!probe && (!currentInvocationAllowed() || !jevPackage().installed)) return unavailable("configuration_changed");
    server.transport!.env = { TYPESAFE_API_KEY: key, JEV_MODE: config.mode, JEV_MODEL: config.model,
      JEV_TIMEOUT_MS: String(config.timeoutMs), JEV_MIN_CONFIDENCE: String(config.minConfidence) };
    const result = await (dependencies.transport ?? invokeMcpTransport)({ capability: server.tools[0]!, server, input,
      operation: "tool.call", timeoutMs: config.timeoutMs + 1500,
      beforeStart: () => Boolean(probe) || (currentInvocationAllowed() && jevPackage().installed) });
    if (!probe && !currentInvocationAllowed()) return unavailable("configuration_changed");
    const output = safeOutput(result, config);
    if (output.status === "unavailable") {
      state.failures += 1;
      if (state.failures >= 3) state.until = Date.now() + 60_000;
    } else { state.failures = 0; state.until = 0; }
    return finish(output);
  } catch {
    state.failures += 1;
    if (state.failures >= 3) state.until = Date.now() + 60_000;
    return unavailable("credential_or_service_unavailable");
  } finally { if (acquired) state.active -= 1; }
}

function stillAllowed(request: JevInvocation, fingerprint: string): boolean {
  const latest = readJevConfig(request.db);
  return !latest.diagnostic && JSON.stringify(latest.config) === fingerprint && jevAllowed(request.db, request.context ?? {}, latest.config);
}
async function resolveJevCredential(db: RunnerDatabase, config: JevSkillConfig): Promise<string> {
  if (!config.apiKeyEnvFile) return config.apiKeyRef ? resolveSecretLocator(createSecretService({ stateDir: jevStateDirectory(db) }), config.apiKeyRef) : "";
  const metadata = await stat(config.apiKeyEnvFile);
  if (!metadata.isFile() || metadata.size > 65536 || (metadata.mode & 0o077) !== 0) throw new Error("unsafe_credential_file");
  const text = await readFile(config.apiKeyEnvFile, "utf8");
  const lines = text.split(/\r?\n/).filter(line => /^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=/.test(line));
  if (lines.length !== 1) throw new Error("invalid_credential_file");
  const raw = lines[0]!.replace(/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*/, "").trim();
  const key = (/^(['"])(.*)\1$/.exec(raw)?.[2] ?? raw).trim();
  if (!key || /[\s`$]/.test(key)) throw new Error("invalid_credential_file");
  return key;
}

function validReport(input: Record<string, unknown>): boolean {
  const limits: Record<string, number> = { title: 500, body: 12000, latest_message: 4000 };
  return typeof input.title === "string" && typeof input.body === "string" && Object.entries(input).every(([name, value]) =>
    Object.hasOwn(limits, name) && typeof value === "string" && value.length <= limits[name]!);
}
function safeOutput(result: McpTransportInvokeResult, config: JevSkillConfig): Record<string, unknown> {
  const fallback = { status: "unavailable", reason: result.status === "timeout" ? "timeout" : "invalid_response", model: config.model, continue_without_skill: true };
  if (result.status !== "succeeded") return fallback;
  const value = record(result.output);
  if (value.status === "unavailable") {
    const reason = typeof value.reason === "string" && /^(http_[1-5][0-9]{2}|invalid_input|invalid_configuration|credential_missing|credential_in_input|invalid_response|timeout|unavailable_or_invalid)$/.test(value.reason) ? value.reason : "invalid_response";
    return { ...fallback, reason };
  }
  if (value.status !== "observed" || typeof value.model !== "string" || !/^jev-[a-z0-9.-]{1,80}$/.test(value.model)) return fallback;
  if (config.mode === "shadow") return { status: "observed", reason: "shadow_only", model: value.model };
  if (value.reason === "low_confidence") return { status: "observed", reason: "low_confidence", model: value.model, continue_without_skill: true };
  const advice = record(value.advice);
  const categories = { intent: ["bug_report", "change_request", "question", "unknown"], information: ["supplied", "missing", "unknown"], message_kind: ["report", "supplement", "decision", "revision", "other"] };
  const validated: Record<string, unknown> = {};
  for (const [name, choices] of Object.entries(categories)) {
    const entry = record(advice[name]);
    if (!choices.includes(String(entry.choice)) || typeof entry.confidence !== "number" || !Number.isFinite(entry.confidence) || entry.confidence < config.minConfidence || entry.confidence > 1) return fallback;
    validated[name] = { choice: entry.choice, confidence: entry.confidence };
  }
  if (value.reason !== "advisory" || record(validated.intent).choice === "unknown") return fallback;
  return { status: "observed", reason: "advisory", model: value.model, advice: validated };
}
