import { matchPiAuthorizationPolicyScope } from "./authorizationScope.ts";
import { recoveryLimitDecision } from "./actionGateRecovery.ts";
import { assessDataEgress, isExternalEgressAction } from "../../security/promptInjectionDefense.ts";
import { piActionContract } from "./actionContracts.ts";
import { cleanString, objectValue } from "../../util/values.ts";
import { PiRiskClassification, SAFE_ACTIONS, CONFIRM_ACTIONS, HIGH_RISK_ACTIONS, type PiActionEnvelope, type PiGatePolicy, type PiGateDecision, PiRiskGate, READ_ONLY_ACTIONS } from "./actionGate.ts";
import { isRiskLevel, gateFor, risk, withScopeReason, stringList, cleanID, timeMs, authorizedByEnvelope } from "./actionAuthorizationValues.ts";

export function classifyPiActionRisk(actionType: string, override: Partial<PiRiskClassification> = {}): PiRiskClassification {
  const base = baseRisk(actionType);
  const riskLevel = isRiskLevel(override.riskLevel) ? override.riskLevel : base.riskLevel;
  const requiresConfirmation = override.requiresConfirmation ?? base.requiresConfirmation;
  return { gate: gateFor(riskLevel, requiresConfirmation), requiresConfirmation, riskLevel };
}

export function baseRisk(actionType: string): PiRiskClassification {
  const contract = piActionContract(actionType);
  if (contract) return risk(contract.risk, contract.risk === "safe" ? "low" : contract.risk === "confirm" ? "medium" : "high");
  if (SAFE_ACTIONS.has(actionType)) return risk("safe", "low");
  if (CONFIRM_ACTIONS.has(actionType)) return risk("confirm", "medium");
  if (HIGH_RISK_ACTIONS.has(actionType)) return risk("high", "high");
  return risk("high", "high");
}

export function gatePiActionEnvelope(envelope: PiActionEnvelope, policy: PiGatePolicy = {}): PiGateDecision {
  return decidePiAuthorization(envelope, policy);
}

export function decidePiAuthorization(
  envelope: PiActionEnvelope,
  policy: PiGatePolicy = {}
): PiGateDecision {
  if (isExternalEgressAction(envelope.action_type)) {
    const egress = assessDataEgress(envelope.payload);
    if (!egress.allowed) return { decision: "deny", reason: egress.reason };
  }
  const riskGate = actionRiskGate(envelope);
  if (riskGate === "forbidden" || forbiddenByPolicy(envelope, policy)) {
    return { decision: "deny", reason: "action is forbidden by policy" };
  }
  if (cleanString(envelope.snoozed_until) !== "") return { decision: "snooze", reason: "action is snoozed" };
  const windowDecision = authorizationWindowDecision(policy);
  if (windowDecision) return windowDecision;
  const recoveryDecision = recoveryLimitDecision(envelope, policy);
  if (recoveryDecision) return recoveryDecision;
  if (!allowedActionType(envelope, policy, riskGate)) return { decision: "deny", reason: "action is not covered by allowed_actions" };
  const scopeDecision = matchPiAuthorizationPolicyScope(envelope, policy);
  if (!scopeDecision.matched) return { decision: "deny", reason: scopeDecision.reason };
  if (!authorizedMcpCapabilities(envelope, policy)) {
    return { decision: "deny", reason: "MCP capability is not covered by authorization allowlist" };
  }
  if (trustedReadOnlyAction(envelope, riskGate)) {
    if (policy.enforceAuthorizedReadScope === true && !delegatedActionCovered(envelope, policy)) {
      return { decision: "deny", reason: "trusted read-only action is outside the authorized action envelope" };
    }
    return { decision: "execute", reason: withScopeReason("trusted read-only action is allowed by gate", scopeDecision.reason) };
  }
  const mode = policy.mode ?? "attended";
  const contract = piActionContract(envelope.action_type);
  if (mode === "manual") return contract?.resolution === "inline_current_turn"
    ? { decision: "deny", reason: "action requires exact current-turn authorization" }
    : { decision: "ask", reason: "manual mode requires user approval" };
  if (mode === "delegated" || mode === "autonomous") {
    if (!authorizedSkillIntents(envelope, policy.allowedSkillIntents ?? policy.allowed_skill_intents)) {
      return { decision: "deny", reason: "delegated skill intent is not covered by authorization allowlist" };
    }
    if (contract?.resolution === "inline_current_turn" && !exactAuthorizedActionCovered(envelope, policy)) {
      return { decision: "deny", reason: "action requires exact current-turn authorization" };
    }
    if (!delegatedActionCovered(envelope, policy)) {
      if (policy.askOnMissingAuthorization === true || policy.ask_on_missing_authorization === true) {
        return {
          decision: "ask",
          reason: "action is allowed by policy but requires explicit user approval for this target"
        };
      }
      return { decision: "deny", reason: "delegated action is not covered by authorization envelope" };
    }
    if (riskGate === "high") return { decision: "ask", reason: "high-risk action requires user confirmation" };
    return { decision: "execute", reason: withScopeReason("delegated action is covered by authorization envelope", scopeDecision.reason) };
  }
  if (riskGate === "confirm" || riskGate === "high") return { decision: "ask", reason: "risk requires user confirmation" };
  return { decision: "execute", reason: withScopeReason("low-risk action is allowed by gate", scopeDecision.reason) };
}

export function authorizedSkillIntents(envelope: PiActionEnvelope, allowed: string[] | undefined): boolean {
  if (!allowed) return true;
  const requested = skillIntentsFromPayload(envelope.payload);
  if (requested.length === 0) return true;
  const allowlist = new Set(allowed.map(cleanString).filter(Boolean));
  return requested.every((id) => allowlist.has(id));
}

export function skillIntentsFromPayload(payload: Record<string, unknown>): string[] {
  return [
    ...stringList(payload.skill_intents),
    ...stringList(payload.required_skill_intents),
    ...stringList(payload.recommended_skill_intents)
  ];
}

export function authorizedMcpCapabilities(envelope: PiActionEnvelope, policy: PiGatePolicy): boolean {
  const allowed = mcpCapabilityAllowlist(policy);
  if (allowed === undefined) return true;
  const requested = mcpCapabilitiesFromPayload(envelope.payload);
  if (requested.length === 0) return true;
  const allowlist = new Set(allowed.map(cleanID).filter(Boolean));
  return requested.every((id) => allowlist.has(cleanID(id)));
}

export function mcpCapabilitiesFromPayload(payload: Record<string, unknown>): string[] {
  const patch = objectValue(payload.patch);
  return [
    ...stringList(payload.capability_id),
    ...stringList(payload.capability_ids),
    ...stringList(payload.required_mcp_capabilities),
    ...stringList(payload.recommended_mcp_capabilities),
    ...stringList(patch.required_mcp_capabilities),
    ...stringList(patch.recommended_mcp_capabilities)
  ];
}

export function mcpCapabilityAllowlist(policy: PiGatePolicy): string[] | undefined {
  if (policy.allowedMcpCapabilities === undefined && policy.allowed_mcp_capabilities === undefined) return undefined;
  const allowed = [
    ...stringList(policy.allowedMcpCapabilities),
    ...stringList(policy.allowed_mcp_capabilities)
  ];
  return allowed.length > 0 ? allowed : undefined;
}

export function actionRiskGate(envelope: PiActionEnvelope): PiRiskGate | "forbidden" {
  const explicit = cleanString(envelope.risk_gate);
  if (explicit === "safe" || explicit === "confirm" || explicit === "high" || explicit === "forbidden") return explicit;
  if (cleanString(envelope.risk_level) === "forbidden") return "forbidden";
  return gateFor(envelope.risk_level, envelope.requires_confirmation);
}

export function forbiddenByPolicy(envelope: PiActionEnvelope, policy: PiGatePolicy): boolean {
  const forbidden = actionList(policy.forbidden_actions ?? policy.forbiddenActions);
  return forbidden.length > 0 && forbidden.includes(envelope.action_type);
}

export function allowedActionType(envelope: PiActionEnvelope, policy: PiGatePolicy, riskGate: PiRiskGate): boolean {
  const allowed = actionList(policy.allowed_actions ?? policy.allowedActions);
  return allowed.length === 0 || allowed.includes(envelope.action_type) || trustedReadOnlyAction(envelope, riskGate);
}

export function actionList(value: unknown): string[] {
  return stringList(value);
}

export function trustedReadOnlyAction(envelope: PiActionEnvelope, riskGate: PiRiskGate): boolean {
  return READ_ONLY_ACTIONS.has(envelope.action_type) &&
    riskGate === "safe" &&
    envelope.requires_confirmation === false &&
    envelope.risk_level === "low";
}

export function authorizationWindowDecision(policy: PiGatePolicy): PiGateDecision | undefined {
  const nowMs = timeMs(policy.now ?? new Date()) ?? Date.now();
  const startsAt = timeMs(policy.starts_at ?? policy.startsAt);
  const expiresAt = timeMs(policy.expires_at ?? policy.expiresAt);
  if (startsAt !== undefined && nowMs < startsAt) {
    return { decision: "snooze", reason: "authorization window has not started" };
  }
  if (expiresAt !== undefined && nowMs >= expiresAt) {
    return { decision: "deny", reason: "authorization window has expired" };
  }
  return undefined;
}

export function delegatedActionCovered(envelope: PiActionEnvelope, policy: PiGatePolicy): boolean {
  const authorized = policy.authorizedActions ?? [];
  if (authorized.length > 0) return authorizedByEnvelope(envelope, authorized);
  return actionList(policy.allowed_actions ?? policy.allowedActions).length > 0;
}

export function exactAuthorizedActionCovered(envelope: PiActionEnvelope, policy: PiGatePolicy): boolean {
  const authorized = policy.authorizedActions ?? [];
  return authorized.length > 0 && authorizedByEnvelope(envelope, authorized);
}
