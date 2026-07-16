import {
  RUN_STATUSES,
  STATE_TRANSITIONS,
  canTransition,
  parseDomainID,
  type DomainActor,
  type Run as CoreRun,
  type RunID,
  type RunStatus,
  type WorkID
} from "../../xuanwu/coreDomainContracts.ts";

export { RUN_STATUSES, type RunID, type RunStatus, type WorkID };

// P00.04 remains the single source for the shared Run vocabulary and edge table.
export const RUN_STATE_TRANSITIONS = STATE_TRANSITIONS.run;

export const RUN_TERMINAL_STATUSES = ["succeeded", "failed", "cancelled"] as const;
export type RunTerminalStatus = typeof RUN_TERMINAL_STATUSES[number];

export const ATTEMPT_STATUSES = ["created", "running", "succeeded", "failed", "cancelled", "interrupted"] as const;
export type AttemptStatus = typeof ATTEMPT_STATUSES[number];

export const ATTEMPT_TERMINAL_STATUSES = ["succeeded", "failed", "cancelled", "interrupted"] as const;
export type AttemptTerminalStatus = typeof ATTEMPT_TERMINAL_STATUSES[number];

export const ATTEMPT_STATE_TRANSITIONS = {
  created: ["running", "failed", "cancelled"],
  running: ["succeeded", "failed", "interrupted"],
  succeeded: [],
  failed: [],
  cancelled: [],
  interrupted: []
} as const satisfies Record<AttemptStatus, readonly AttemptStatus[]>;

export const RUN_TRIGGERS = ["initial", "retry", "supersede"] as const;
export type RunTrigger = typeof RUN_TRIGGERS[number];

export const ATTEMPT_KINDS = ["initial", "resume", "recovery"] as const;
export type AttemptKind = typeof ATTEMPT_KINDS[number];

export type RunAttemptID = `${RunID}~attempt:${number}`;

export type CostUsage = {
  cached_input_tokens: number | null;
  completeness: "unavailable" | "partial" | "complete";
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_output_tokens: number | null;
  total_tokens: number | null;
};

export type MonetaryCost = {
  amount_micros: number | null;
  basis: "unavailable" | "provider_reported" | "pricing_derived";
  currency: string;
};

export type RunCost = {
  money: MonetaryCost;
  pricing_refs: string[];
  source_refs: string[];
  usage: CostUsage;
};

export type ProviderAttemptRef = {
  // Provider refs are opaque facts. They never become Run identity or state authority.
  invocation_ref: string;
  observation_ref?: string;
  provider: string;
  session_ref?: string;
  turn_ref?: string;
};

export type TerminalRecord = {
  reason: string;
  source_ref: string;
};

export type RunLedgerEntry = Omit<CoreRun, "attempt" | "provider_session_ref"> & {
  cost: RunCost;
  revision: number;
  sequence: number;
  supersedes_run_id?: RunID;
  terminal?: TerminalRecord;
  trigger: RunTrigger;
};

export type RunAttempt = {
  cost: RunCost;
  created_at: string;
  ended_at?: string;
  id: RunAttemptID;
  kind: AttemptKind;
  provider_ref: ProviderAttemptRef;
  revision: number;
  run_id: RunID;
  sequence: number;
  started_at?: string;
  status: AttemptStatus;
  terminal?: TerminalRecord;
  updated_at: string;
};

export type RunWorkRelation = {
  actor: DomainActor;
  audit_event_ref: string;
  correlation_id: string;
  kind: "executes";
  occurred_at: string;
  reason: string;
  run_id: RunID;
  work_id: WorkID;
};

export type RunLifecycleSnapshot = {
  attempts: RunAttempt[];
  relation: RunWorkRelation;
  run: RunLedgerEntry;
};

export type RunTransitionGate = {
  authority: "deterministic_policy" | "human_approval";
  decision: "allow" | "deny" | "ask";
  policy_ref: string;
};

export type RunTransitionAudit = {
  actor: DomainActor;
  correlation_id: string;
  event_id: string;
  gate: RunTransitionGate;
  occurred_at: string;
  reason: string;
};

export type RunTransitionCommand = {
  audit: RunTransitionAudit;
  expected_revision: number;
  run_id: RunID;
  to: RunStatus;
};

export type AttemptTransitionCommand = {
  attempt_id: RunAttemptID;
  audit: RunTransitionAudit;
  expected_revision: number;
  run_id: RunID;
  to: AttemptStatus;
};

export type LifecycleTransitionDecision = {
  allowed: boolean;
  violations: string[];
};

export type LegacyProviderRuntimeRef = {
  provider: string;
  provider_run_id: string;
  provider_session_id?: string;
  provider_turn_id?: string;
};

export function makeRunAttemptID(runID: RunID, sequence: number): RunAttemptID {
  if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new Error("Attempt sequence must be positive");
  return `${runID}~attempt:${sequence}` as RunAttemptID;
}

export function providerAttemptRef(input: LegacyProviderRuntimeRef): ProviderAttemptRef {
  const provider = input.provider.trim();
  const invocationRef = input.provider_run_id.trim();
  const sessionRef = input.provider_session_id?.trim() ?? "";
  const turnRef = input.provider_turn_id?.trim() ?? "";
  if (provider === "") throw new Error("provider is required");
  if (invocationRef === "") throw new Error("provider_run_id is required");
  if (turnRef !== "" && sessionRef === "") throw new Error("provider turn requires a session ref");
  return {
    invocation_ref: invocationRef,
    provider,
    ...(sessionRef === "" ? {} : { observation_ref: `${provider}:${sessionRef}`, session_ref: sessionRef }),
    ...(turnRef === "" ? {} : { turn_ref: turnRef })
  };
}

export function mapLegacyIssueRunStatus(status: string): RunStatus {
  switch (status.trim().toLowerCase()) {
    case "in_progress": return "running";
    case "pending_verification":
    case "done": return "succeeded";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    default: throw new Error(`unsupported legacy issue_run status: ${status}`);
  }
}

export function emptyRunCost(): RunCost {
  return {
    money: { amount_micros: null, basis: "unavailable", currency: "" },
    pricing_refs: [],
    source_refs: [],
    usage: {
      cached_input_tokens: null,
      completeness: "unavailable",
      input_tokens: null,
      output_tokens: null,
      reasoning_output_tokens: null,
      total_tokens: null
    }
  };
}

export function aggregateRunCost(attempts: readonly RunAttempt[]): RunCost {
  if (attempts.length === 0) return emptyRunCost();
  const costs = attempts.map((attempt) => attempt.cost);
  const usageFields = [
    "cached_input_tokens",
    "input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens"
  ] as const;
  const usageValues = Object.fromEntries(usageFields.map((field) => [field, sumKnown(costs.map((cost) => cost.usage[field]))])) as
    Pick<CostUsage, typeof usageFields[number]>;
  const anyUsage = usageFields.some((field) => usageValues[field] !== null);
  const usageCompleteness = !anyUsage
    ? "unavailable"
    : costs.every((cost) => cost.usage.completeness === "complete") ? "complete" : "partial";

  const allMoneyKnown = costs.every((cost) => cost.money.amount_micros !== null);
  const currencies = new Set(costs.map((cost) => cost.money.currency).filter(Boolean));
  const moneyKnown = allMoneyKnown && currencies.size === 1;
  const basis = !moneyKnown
    ? "unavailable"
    : costs.some((cost) => cost.money.basis === "pricing_derived") ? "pricing_derived" : "provider_reported";

  return {
    money: {
      amount_micros: moneyKnown ? costs.reduce((total, cost) => total + (cost.money.amount_micros ?? 0), 0) : null,
      basis,
      currency: moneyKnown ? [...currencies][0] ?? "" : ""
    },
    pricing_refs: uniqueStrings(costs.flatMap((cost) => cost.pricing_refs)),
    source_refs: uniqueStrings(costs.flatMap((cost) => cost.source_refs)),
    usage: { ...usageValues, completeness: usageCompleteness }
  };
}

export function validateRunLifecycle(snapshot: RunLifecycleSnapshot): string[] {
  const errors: string[] = [];
  const { run, relation } = snapshot;
  if (parseDomainID(run.id)?.kind !== "run") errors.push(`${run.id} is not a Run id`);
  if (parseDomainID(run.work_id)?.kind !== "work") errors.push(`${run.id} has an invalid Work owner`);
  if (!RUN_STATUSES.includes(run.status)) errors.push(`${run.id} has unsupported status ${run.status}`);
  if (!RUN_TRIGGERS.includes(run.trigger)) errors.push(`${run.id} has unsupported trigger ${run.trigger}`);
  if (!run.provider.trim()) errors.push(`${run.id} provider is required`);
  if (!Number.isSafeInteger(run.sequence) || run.sequence <= 0) errors.push(`${run.id} sequence must be positive`);
  if (!Number.isSafeInteger(run.revision) || run.revision < 0) errors.push(`${run.id} revision must be non-negative`);
  errors.push(...timestampErrors(run.created_at, `${run.id} created_at`));
  errors.push(...timestampErrors(run.updated_at, `${run.id} updated_at`));
  if (run.started_at) errors.push(...timestampErrors(run.started_at, `${run.id} started_at`));
  validateTerminalRecord(run.status, run.ended_at, run.terminal, `${run.id} Run`, errors, isRunTerminal);
  if (run.status !== "created" && !run.started_at) errors.push(`${run.id} non-created Run requires started_at`);
  if (run.trigger === "initial" && run.supersedes_run_id) errors.push(`${run.id} initial Run cannot supersede another Run`);
  if (run.trigger !== "initial" && !run.supersedes_run_id) errors.push(`${run.id} ${run.trigger} Run requires supersedes_run_id`);
  if (run.supersedes_run_id === run.id) errors.push(`${run.id} cannot supersede itself`);
  errors.push(...validateRunWorkRelation(run, relation));

  const attempts = [...snapshot.attempts].sort((left, right) => left.sequence - right.sequence);
  const sequences = new Set<number>();
  const invocationRefs = new Set<string>();
  for (const attempt of attempts) {
    errors.push(...validateAttempt(run, attempt));
    if (sequences.has(attempt.sequence)) errors.push(`${run.id} has duplicate Attempt sequence ${attempt.sequence}`);
    sequences.add(attempt.sequence);
    const invocationKey = `${attempt.provider_ref.provider}:${attempt.provider_ref.invocation_ref}`;
    if (attempt.provider_ref.invocation_ref && invocationRefs.has(invocationKey)) {
      errors.push(`${run.id} has duplicate provider invocation ${invocationKey}`);
    }
    if (attempt.provider_ref.invocation_ref) invocationRefs.add(invocationKey);
  }
  attempts.forEach((attempt, index) => {
    if (attempt.sequence !== index + 1) errors.push(`${run.id} Attempt sequence must be contiguous from 1`);
    if (index === 0 && attempt.kind !== "initial") errors.push(`${attempt.id} first Attempt must be initial`);
    if (index > 0 && attempt.kind === "initial") errors.push(`${attempt.id} only the first Attempt can be initial`);
  });

  const latest = attempts.at(-1);
  const liveAttempts = attempts.filter((attempt) => !isAttemptTerminal(attempt.status));
  if (liveAttempts.length > 1) errors.push(`${run.id} cannot contain multiple live Attempts`);
  if (liveAttempts.length === 1 && liveAttempts[0]?.id !== latest?.id) {
    errors.push(`${run.id} only the latest Attempt can be live`);
  }
  if (run.status === "running" && !latest) errors.push(`${run.id} running Run requires an Attempt`);
  if (run.status === "recovering" && !latest) errors.push(`${run.id} recovering Run requires an Attempt`);
  if (run.status === "recovering" && latest && ![
    "failed", "interrupted", "created"
  ].includes(latest.status)) errors.push(`${run.id} recovering Run requires a failed/interrupted Attempt or a created recovery Attempt`);
  if (run.status === "recovering" && latest?.status === "created" && latest.kind !== "recovery") {
    errors.push(`${run.id} recovering Run can only create a recovery Attempt`);
  }
  if (isRunTerminal(run.status) && attempts.some((attempt) => !isAttemptTerminal(attempt.status))) {
    errors.push(`${run.id} terminal Run cannot contain a live Attempt`);
  }
  if (run.status === "succeeded" && latest?.status !== "succeeded") {
    errors.push(`${run.id} succeeded Run requires the latest Attempt to succeed`);
  }
  if (run.status === "failed" && latest?.status !== "failed") {
    errors.push(`${run.id} failed Run requires the latest Attempt to fail`);
  }
  if (JSON.stringify(run.cost) !== JSON.stringify(aggregateRunCost(attempts))) {
    errors.push(`${run.id} cost must equal the deterministic Attempt aggregate`);
  }
  errors.push(...validateCost(run.cost).map((error) => `${run.id} ${error}`));
  return [...new Set(errors)];
}

export function evaluateRunTransition(
  snapshot: RunLifecycleSnapshot,
  command: RunTransitionCommand
): LifecycleTransitionDecision {
  const violations = validateRunLifecycle(snapshot);
  const { run } = snapshot;
  violations.push(...validateTransitionAudit(command.audit));
  if (command.run_id !== run.id) violations.push(`transition targets ${command.run_id}, not ${run.id}`);
  validateRevision(command.expected_revision, run.revision, violations);
  if (!canTransition("run", run.status, command.to)) violations.push(`illegal Run transition ${run.status} -> ${command.to}`);
  validateGate(command.audit.gate, violations);

  const latest = [...snapshot.attempts].sort((left, right) => left.sequence - right.sequence).at(-1);
  if (command.to === "running" && !latest) violations.push("running Run requires an Attempt");
  if (command.to === "recovering" && latest && !["failed", "interrupted"].includes(latest.status)) {
    violations.push("recovering Run requires a failed or interrupted latest Attempt");
  }
  if (command.to === "succeeded" && latest?.status !== "succeeded") {
    violations.push("succeeded Run requires a succeeded latest Attempt");
  }
  if (command.to === "failed" && latest?.status !== "failed") {
    violations.push("failed Run requires a failed latest Attempt");
  }
  if (isRunTerminal(command.to) && snapshot.attempts.some((attempt) => !isAttemptTerminal(attempt.status))) {
    violations.push("terminal Run cannot contain a live Attempt");
  }
  return decision(violations);
}

export function evaluateAttemptTransition(
  snapshot: RunLifecycleSnapshot,
  command: AttemptTransitionCommand
): LifecycleTransitionDecision {
  const violations = validateRunLifecycle(snapshot);
  const attempts = [...snapshot.attempts].sort((left, right) => left.sequence - right.sequence);
  const attempt = attempts.find((item) => item.id === command.attempt_id);
  violations.push(...validateTransitionAudit(command.audit));
  if (command.run_id !== snapshot.run.id) violations.push(`transition targets ${command.run_id}, not ${snapshot.run.id}`);
  if (!attempt) violations.push(`missing Attempt ${command.attempt_id}`);
  if (attempt) {
    validateRevision(command.expected_revision, attempt.revision, violations);
    if (attempt.id !== attempts.at(-1)?.id) violations.push("only the latest Attempt can transition");
    if (!canAttemptTransition(attempt.status, command.to)) {
      violations.push(`illegal Attempt transition ${attempt.status} -> ${command.to}`);
    }
  }
  validateGate(command.audit.gate, violations);
  return decision(violations);
}

export function canAttemptTransition(from: AttemptStatus, to: AttemptStatus): boolean {
  return ATTEMPT_STATE_TRANSITIONS[from].includes(to as never);
}

export function isRunTerminal(status: RunStatus): status is RunTerminalStatus {
  return RUN_TERMINAL_STATUSES.includes(status as RunTerminalStatus);
}

export function isAttemptTerminal(status: AttemptStatus): status is AttemptTerminalStatus {
  return ATTEMPT_TERMINAL_STATUSES.includes(status as AttemptTerminalStatus);
}

function validateRunWorkRelation(run: RunLedgerEntry, relation: RunWorkRelation): string[] {
  const errors: string[] = [];
  if (relation.kind !== "executes") errors.push(`${run.id} relation kind must be executes`);
  if (relation.run_id !== run.id) errors.push(`${run.id} relation references another Run`);
  if (relation.work_id !== run.work_id) errors.push(`${run.id} relation references another Work`);
  if (!relation.audit_event_ref.trim()) errors.push(`${run.id} relation audit_event_ref is required`);
  if (!relation.actor.id.trim()) errors.push(`${run.id} relation actor.id is required`);
  if (!relation.reason.trim()) errors.push(`${run.id} relation reason is required`);
  if (!relation.correlation_id.trim()) errors.push(`${run.id} relation correlation_id is required`);
  errors.push(...timestampErrors(relation.occurred_at, `${run.id} relation occurred_at`));
  return errors;
}

function validateAttempt(run: RunLedgerEntry, attempt: RunAttempt): string[] {
  const errors: string[] = [];
  if (attempt.run_id !== run.id) errors.push(`${attempt.id} references another Run`);
  if (!Number.isSafeInteger(attempt.sequence) || attempt.sequence <= 0) errors.push(`${attempt.id} sequence must be positive`);
  else if (attempt.id !== makeRunAttemptID(run.id, attempt.sequence)) errors.push(`${attempt.id} does not match its Run/sequence`);
  if (!ATTEMPT_STATUSES.includes(attempt.status)) errors.push(`${attempt.id} has unsupported status ${attempt.status}`);
  if (!ATTEMPT_KINDS.includes(attempt.kind)) errors.push(`${attempt.id} has unsupported kind ${attempt.kind}`);
  if (!Number.isSafeInteger(attempt.revision) || attempt.revision < 0) errors.push(`${attempt.id} revision must be non-negative`);
  errors.push(...timestampErrors(attempt.created_at, `${attempt.id} created_at`));
  errors.push(...timestampErrors(attempt.updated_at, `${attempt.id} updated_at`));
  if (attempt.started_at) errors.push(...timestampErrors(attempt.started_at, `${attempt.id} started_at`));
  if (attempt.status !== "created" && !attempt.started_at) errors.push(`${attempt.id} non-created Attempt requires started_at`);
  validateTerminalRecord(attempt.status, attempt.ended_at, attempt.terminal, `${attempt.id} Attempt`, errors, isAttemptTerminal);
  if (!attempt.provider_ref.provider.trim()) errors.push(`${attempt.id} provider is required`);
  if (attempt.provider_ref.provider !== run.provider) errors.push(`${attempt.id} provider differs from its Run`);
  if (attempt.status !== "created" && !attempt.provider_ref.invocation_ref.trim()) {
    errors.push(`${attempt.id} started Attempt requires provider invocation_ref`);
  }
  if (attempt.provider_ref.turn_ref && !attempt.provider_ref.session_ref) {
    errors.push(`${attempt.id} provider turn requires a session ref`);
  }
  if (attempt.provider_ref.turn_ref && !attempt.provider_ref.invocation_ref) {
    errors.push(`${attempt.id} provider turn requires an invocation ref`);
  }
  errors.push(...validateCost(attempt.cost).map((error) => `${attempt.id} ${error}`));
  return errors;
}

function validateCost(cost: RunCost): string[] {
  const errors: string[] = [];
  if (!["unavailable", "partial", "complete"].includes(cost.usage.completeness)) {
    errors.push("usage completeness is invalid");
  }
  const entries = Object.entries(cost.usage).filter(([key]) => key !== "completeness") as Array<[string, number | null]>;
  for (const [field, value] of entries) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) errors.push(`${field} must be a non-negative integer or null`);
  }
  const usageValues = entries.map(([, value]) => value);
  if (cost.usage.completeness === "unavailable" && usageValues.some((value) => value !== null)) {
    errors.push("unavailable usage cannot contain token values");
  }
  if (cost.usage.completeness === "partial" && usageValues.every((value) => value === null)) {
    errors.push("partial usage requires at least one token value");
  }
  if (cost.usage.completeness === "complete" && usageValues.some((value) => value === null)) {
    errors.push("complete usage requires every token value");
  }
  if ((cost.usage.completeness !== "unavailable" || cost.money.amount_micros !== null) && cost.source_refs.length === 0) {
    errors.push("known cost requires source_refs");
  }
  if (cost.usage.total_tokens !== null && cost.usage.input_tokens !== null && cost.usage.output_tokens !== null &&
    cost.usage.total_tokens !== cost.usage.input_tokens + cost.usage.output_tokens) {
    errors.push("total_tokens must equal input_tokens plus output_tokens");
  }
  if (cost.usage.cached_input_tokens !== null && cost.usage.input_tokens !== null &&
    cost.usage.cached_input_tokens > cost.usage.input_tokens) errors.push("cached_input_tokens cannot exceed input_tokens");
  if (cost.usage.reasoning_output_tokens !== null && cost.usage.output_tokens !== null &&
    cost.usage.reasoning_output_tokens > cost.usage.output_tokens) errors.push("reasoning_output_tokens cannot exceed output_tokens");

  const { amount_micros: amount, basis, currency } = cost.money;
  if (!["unavailable", "provider_reported", "pricing_derived"].includes(basis)) errors.push("money basis is invalid");
  if (amount !== null && (!Number.isSafeInteger(amount) || amount < 0)) errors.push("amount_micros must be a non-negative integer or null");
  if (amount === null && (basis !== "unavailable" || currency !== "")) errors.push("unavailable money must omit currency and amount");
  if (amount !== null && (basis === "unavailable" || !currency.trim())) errors.push("known money requires basis and currency");
  if (basis === "pricing_derived" && cost.pricing_refs.length === 0) errors.push("pricing-derived money requires pricing_refs");
  if (new Set(cost.source_refs).size !== cost.source_refs.length || cost.source_refs.some((ref) => !ref.trim())) {
    errors.push("cost source_refs must be non-empty and unique");
  }
  if (new Set(cost.pricing_refs).size !== cost.pricing_refs.length || cost.pricing_refs.some((ref) => !ref.trim())) {
    errors.push("cost pricing_refs must be non-empty and unique");
  }
  return errors;
}

function validateTerminalRecord<Status extends string>(
  status: Status,
  endedAt: string | undefined,
  terminal: TerminalRecord | undefined,
  label: string,
  errors: string[],
  terminalPredicate: (value: Status) => boolean
): void {
  const isTerminal = terminalPredicate(status);
  if (isTerminal && !endedAt) errors.push(`${label} terminal status requires ended_at`);
  if (!isTerminal && endedAt) errors.push(`${label} non-terminal status cannot have ended_at`);
  if (endedAt) errors.push(...timestampErrors(endedAt, `${label} ended_at`));
  if (isTerminal && !terminal) errors.push(`${label} terminal status requires terminal record`);
  if (!isTerminal && terminal) errors.push(`${label} non-terminal status cannot have terminal record`);
  if (terminal && !terminal.reason.trim()) errors.push(`${label} terminal reason is required`);
  if (terminal && !terminal.source_ref.trim()) errors.push(`${label} terminal source_ref is required`);
}

function validateTransitionAudit(audit: RunTransitionAudit): string[] {
  const errors: string[] = [];
  if (!audit.event_id.trim()) errors.push("transition event_id is required");
  if (!audit.actor.id.trim()) errors.push("transition actor.id is required");
  if (!audit.reason.trim()) errors.push("transition reason is required");
  if (!audit.correlation_id.trim()) errors.push("transition correlation_id is required");
  errors.push(...timestampErrors(audit.occurred_at, "transition occurred_at"));
  return errors;
}

function validateGate(gate: RunTransitionGate, errors: string[]): void {
  if (!["deterministic_policy", "human_approval"].includes(gate.authority)) {
    errors.push("transition gate authority is not trusted");
  }
  if (!["allow", "deny", "ask"].includes(gate.decision)) errors.push("transition gate decision is invalid");
  if (!gate.policy_ref.trim()) errors.push("transition gate policy_ref is required");
  if (gate.decision === "deny") errors.push("transition gate denied");
  if (gate.decision === "ask") errors.push("transition gate requires approval");
}

function validateRevision(expected: number, current: number, errors: string[]): void {
  if (!Number.isSafeInteger(expected) || expected < 0) errors.push("expected revision must be non-negative");
  else if (expected !== current) errors.push(`expected revision ${expected} does not match ${current}`);
}

function timestampErrors(value: string, label: string): string[] {
  return Number.isFinite(Date.parse(value)) ? [] : [`${label} must be a timestamp`];
}

function sumKnown(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((total, value) => total + value, 0);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))];
}

function decision(violations: string[]): LifecycleTransitionDecision {
  const unique = [...new Set(violations)];
  return { allowed: unique.length === 0, violations: unique };
}
