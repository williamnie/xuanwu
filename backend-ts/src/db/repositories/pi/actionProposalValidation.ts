import {
  cleanString,
  confidence,
  objectArray,
  objectValue,
  requiredString,
  stringList,
  type JsonObject
} from "../intakeRunSupport.ts";

export type ActionProposalRisk = "low" | "medium" | "high";

export type ActionProposalAction = {
  confidence: number;
  evidence_refs: string[];
  error?: string;
  execution_status?: string;
  id: string;
  payload: JsonObject;
  pi_action_id?: string;
  rationale: string;
  requires_approval: boolean;
  result?: JsonObject;
  risk: ActionProposalRisk;
  summary: string;
  target_hints: JsonObject[];
  type: string;
};

const BUILT_IN_ACTION_TYPES = new Set([
  "ask_user",
  "issue.create",
  "issue.enqueue",
  "issue.status_lookup",
  "memory.create",
  "message.reply_draft",
  "message.reply_send",
  "no_action",
  "reminder.create",
  "watch_thread"
]);

export function normalizeActionProposalActions(
  actions: unknown,
  defaults: { evidenceRefs?: string[]; targetHints?: JsonObject[] } = {}
): ActionProposalAction[] {
  if (!Array.isArray(actions) || actions.length === 0) throw new Error("actions is required");
  return actions.map((action, index) => normalizeAction(action, index, defaults));
}

export function normalizedConfidence(value: unknown): number {
  const score = confidence(value);
  if (score < 0) return 0;
  if (score > 1) return 1;
  return score;
}

function normalizeAction(
  raw: unknown,
  index: number,
  defaults: { evidenceRefs?: string[]; targetHints?: JsonObject[] }
): ActionProposalAction {
  const input = objectValue(raw);
  const type = actionType(input.type);
  const payload = objectValue(input.payload);
  validateTypedPayload(type, payload);
  return {
    confidence: normalizedConfidence(input.confidence),
    evidence_refs: defaultedStrings(input.evidence_refs, defaults.evidenceRefs),
    error: optionalString(input.error),
    execution_status: optionalString(input.execution_status),
    id: cleanString(input.id) || `action-${index + 1}-${safeID(type)}`,
    payload,
    pi_action_id: optionalString(input.pi_action_id),
    rationale: cleanString(input.rationale),
    requires_approval: Boolean(input.requires_approval),
    result: optionalObject(input.result),
    risk: actionRisk(input.risk),
    summary: cleanString(input.summary),
    target_hints: defaultedObjects(input.target_hints, defaults.targetHints),
    type
  };
}

function validateTypedPayload(type: string, payload: JsonObject): void {
  if (!BUILT_IN_ACTION_TYPES.has(type)) return;
  if (type === "issue.create") requireText(payload.title, "action payload for issue.create requires title");
  if (type === "issue.enqueue") requirePositiveInteger(payload.issue_id, "action payload for issue.enqueue requires issue_id");
  if (type === "message.reply_draft") requireText(payload.draft, "action payload for message.reply_draft requires draft");
  if (type === "message.reply_send") requireAnyText(payload, ["text", "message", "draft"], "action payload for message.reply_send requires text");
  if (type === "issue.status_lookup") requireStatusLookupPayload(payload);
  if (type === "ask_user") requireText(payload.question, "action payload for ask_user requires question");
  if (type === "memory.create") requireAnyText(payload, ["content", "summary", "title"], "action payload for memory.create requires content");
  if (type === "reminder.create") requireAnyText(payload, ["title", "summary"], "action payload for reminder.create requires title");
  if (type === "no_action") requireText(payload.reason, "action payload for no_action requires reason");
}

function requireStatusLookupPayload(payload: JsonObject): void {
  if (cleanString(payload.query) !== "") return;
  if (positiveIntegerValue(payload.issue_id) > 0) return;
  if (objectArray(payload.target_hints).length > 0) return;
  throw new Error("action payload for issue.status_lookup requires query");
}

function defaultedStrings(value: unknown, fallback: string[] | undefined): string[] {
  const items = stringList(value);
  return items.length > 0 ? items : fallback ?? [];
}

function defaultedObjects(value: unknown, fallback: JsonObject[] | undefined): JsonObject[] {
  const items = objectArray(value);
  return items.length > 0 ? items : fallback ?? [];
}

function actionType(value: unknown): string {
  const type = requiredString(value, "actions.type");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(type)) throw new Error("actions.type is invalid");
  return type;
}

function actionRisk(value: unknown): ActionProposalRisk {
  const risk = cleanString(value);
  return risk === "medium" || risk === "high" ? risk : "low";
}

function requireText(value: unknown, message: string): void {
  if (cleanString(value) === "") throw new Error(message);
}

function optionalString(value: unknown): string | undefined {
  const text = cleanString(value);
  return text === "" ? undefined : text;
}

function optionalObject(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonObject;
}

function requireAnyText(payload: JsonObject, keys: string[], message: string): void {
  if (!keys.some((key) => cleanString(payload[key]) !== "")) throw new Error(message);
}

function requirePositiveInteger(value: unknown, message: string): void {
  if (positiveIntegerValue(value) <= 0) throw new Error(message);
}

function positiveIntegerValue(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function safeID(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "custom";
}
