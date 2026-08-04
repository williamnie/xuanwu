export type ProgressStatePoint = {
  status?: string;
  updated_at?: string;
};

export type ProgressSnapshot = {
  git_diff_hash?: string;
  issue?: ProgressStatePoint;
  run?: ProgressStatePoint;
  session?: ProgressStatePoint;
};

export type ProgressEvent = {
  payload?: unknown;
  type: string;
};

export type MeaningfulProgressInput = {
  baseline?: ProgressSnapshot;
  current?: ProgressSnapshot;
  events?: ProgressEvent[];
};

export type MeaningfulProgressResult = {
  has_progress: boolean;
  ignored_reasons: string[];
  reasons: string[];
};

const PROGRESS_REASONS = [
  "agent_message",
  "command_completed",
  "git_diff_changed",
  "issue_status_updated",
  "run_updated",
  "session_updated",
  "verification_signal",
  "commit_signal",
  "issue_update_signal"
] as const;

type ProgressReason = typeof PROGRESS_REASONS[number];
type IgnoredReason = "empty_turn" | "keepalive" | "repeated_error" | "timestamp_only" | "token_usage";
type EventInspection = {
  command: string;
  event: ProgressEvent;
  payload: Record<string, unknown>;
  rawText: string;
  text: string;
};

export function detectMeaningfulProgress(input: MeaningfulProgressInput): MeaningfulProgressResult {
  const reasons = new Set<ProgressReason>();
  const ignored = new Set<IgnoredReason>();
  addSnapshotReasons(input.baseline ?? {}, input.current ?? {}, reasons);
  inspectEvents(input.events ?? [], reasons, ignored);
  return {
    has_progress: reasons.size > 0,
    ignored_reasons: [...ignored],
    reasons: [...reasons]
  };
}

function addSnapshotReasons(
  baseline: ProgressSnapshot,
  current: ProgressSnapshot,
  reasons: Set<ProgressReason>
): void {
  if (hashChanged(baseline.git_diff_hash, current.git_diff_hash)) reasons.add("git_diff_changed");
  if (stateChanged(baseline.issue, current.issue)) reasons.add("issue_status_updated");
  if (stateChanged(baseline.run, current.run)) reasons.add("run_updated");
  if (stateChanged(baseline.session, current.session)) reasons.add("session_updated");
}

function inspectEvents(
  events: ProgressEvent[],
  reasons: Set<ProgressReason>,
  ignored: Set<IgnoredReason>
): void {
  const seenErrors = new Set<string>();
  for (const event of events) inspectEvent({ event, reasons, ignored, seenErrors });
}

function inspectEvent(input: {
  event: ProgressEvent;
  ignored: Set<IgnoredReason>;
  reasons: Set<ProgressReason>;
  seenErrors: Set<string>;
}): void {
  const { event, reasons, ignored, seenErrors } = input;
  const payload = objectValue(parseJsonMaybe(event.payload));
  const text = eventText(event, payload);
  const rawText = rawEventText(event, payload);
  const command = clean(payload.command);
  const inspection = { command, event, payload, rawText, text };
  const ignorable = markIgnorable(inspection, ignored);
  if (isRepeatedError(inspection, seenErrors)) {
    ignored.add("repeated_error");
    return;
  }
  if (ignorable) return;
  if (isAgentMessage(inspection)) reasons.add("agent_message");
  if (isCompletedCommand(payload, command)) reasons.add("command_completed");
  addTextSignalReasons(`${command}\n${text}`, reasons);
  if (event.type === "issue.status_changed") reasons.add("issue_status_updated");
}

function markIgnorable(input: EventInspection, ignored: Set<IgnoredReason>): boolean {
  let ignorable = false;
  if (isTokenUsage(input.event, input.payload)) {
    ignored.add("token_usage");
    ignorable = true;
  }
  if (isKeepalive(input)) {
    ignored.add("keepalive");
    ignorable = true;
  }
  if (isTimestampOnly(input.payload)) {
    ignored.add("timestamp_only");
    ignorable = true;
  }
  if (isEmptyTurn(input)) {
    ignored.add("empty_turn");
    ignorable = true;
  }
  return ignorable;
}

function addTextSignalReasons(value: string, reasons: Set<ProgressReason>): void {
  const text = value.toLowerCase();
  if (/(^|\s)(bun|pnpm|npm|yarn|go|cargo|pytest|vitest|jest)\s+[^。\n]*(test|vitest)|verification/.test(text)) {
    reasons.add("verification_signal");
  }
  if (/\bgit\s+commit\b|\bcommitted\b|commit [0-9a-f]{7,40}/.test(text)) reasons.add("commit_signal");
  if (/xuanwu\s+issue\s+update|issue update --id|--status\s+(done|failed)/.test(text)) {
    reasons.add("issue_update_signal");
  }
}

function isAgentMessage(input: EventInspection): boolean {
  const { event, payload, text, command } = input;
  if (text === "" || command !== "") return false;
  const type = clean(payload.type || event.type).toLowerCase();
  const method = clean(payload.raw_method).toLowerCase();
  return type === "text" || type === "agent_message" || method.includes("agentmessage");
}

function isCompletedCommand(payload: Record<string, unknown>, command: string): boolean {
  if (command === "") return false;
  const status = clean(payload.status).toLowerCase();
  return status === "completed" || status === "done" || status === "success" || status === "0";
}

function isTokenUsage(event: ProgressEvent, payload: Record<string, unknown>): boolean {
  const type = clean(payload.type || event.type).toLowerCase();
  if (/token|usage/.test(type)) return true;
  return containsTokenUsage(payload);
}

function isRepeatedError(input: EventInspection, seenErrors: Set<string>): boolean {
  const { event, payload, rawText, text } = input;
  if (clean(payload.type || event.type).toLowerCase() !== "error" && !payload.error) return false;
  const key = clean(payload.error || text || rawText).toLowerCase();
  if (key === "") return false;
  const repeated = seenErrors.has(key);
  seenErrors.add(key);
  return repeated;
}

function isEmptyTurn(input: EventInspection): boolean {
  const { event, payload, text, command } = input;
  const type = clean(payload.type || event.type).toLowerCase();
  const method = clean(payload.raw_method).toLowerCase();
  const status = clean(payload.status).toLowerCase();
  return command === "" && text === "" &&
    (type.includes("turn") || type === "done" || method.includes("turn/completed")) &&
    status !== "failed";
}

function stateChanged(baseline?: ProgressStatePoint, current?: ProgressStatePoint): boolean {
  if (!baseline || !current) return false;
  return changedText(baseline.status, current.status);
}

function changedText(before?: string, after?: string): boolean {
  return clean(before) !== "" && clean(after) !== "" && clean(before) !== clean(after);
}

function hashChanged(before?: string, after?: string): boolean {
  return (clean(before) !== "" || clean(after) !== "") && clean(before) !== clean(after);
}

function eventText(event: ProgressEvent, payload: Record<string, unknown>): string {
  return clean(payload.text || payload.error);
}

function rawEventText(event: ProgressEvent, payload: Record<string, unknown>): string {
  return clean(payload.raw_payload || event.payload);
}

function parseJsonMaybe(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function containsTokenUsage(value: unknown): boolean {
  const record = objectValue(parseJsonMaybe(value));
  if (Object.keys(record).length === 0) return false;
  if (["input_tokens", "last_token_usage", "output_tokens", "total_tokens", "token_count"].some((key) => key in record)) {
    return true;
  }
  return Object.entries(record).some(([key, item]) =>
    tokenUsageField(key, item) || containsTokenUsage(item)
  );
}

function tokenUsageField(key: string, value: unknown): boolean {
  const normalized = key.toLowerCase();
  if (/token|usage/.test(normalized)) return true;
  return normalized === "type" && typeof value === "string" && /token|usage/.test(value.toLowerCase());
}

function isKeepalive(input: EventInspection): boolean {
  const type = clean(input.payload.type || input.event.type).toLowerCase();
  const method = clean(input.payload.raw_method).toLowerCase();
  const text = `${input.text}\n${input.rawText}`.trim().toLowerCase();
  if (/keep[_-]?alive|heartbeat/.test(type) || /keep[_-]?alive|heartbeat/.test(method)) return true;
  return /^(keep[_-]?alive|heartbeat)(\s|:|$)/.test(text) || text === ": heartbeat";
}

function isTimestampOnly(payload: Record<string, unknown>): boolean {
  const keys = Object.keys(payload);
  return keys.length > 0 && keys.every((key) => isTimestampKey(key) && isTimestampValue(payload[key]));
}

function isTimestampKey(key: string): boolean {
  return ["at", "created_at", "timestamp", "updated_at"].includes(key.trim().toLowerCase());
}

function isTimestampValue(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value.trim()));
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
