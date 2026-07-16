import { parseDomainID, type DomainActor, type HandoffID, type WorkID } from "../../xuanwu/coreDomainContracts.ts";
import { redactedUserVisibleText } from "../../util/redact.ts";

export const REMOTE_GIT_PROVIDER_CONTRACT_VERSION = 1 as const;

export const REMOTE_GIT_PULL_REQUEST_READINESS = ["draft", "ready"] as const;
export type RemoteGitPullRequestReadiness = typeof REMOTE_GIT_PULL_REQUEST_READINESS[number];

export const REMOTE_GIT_PULL_REQUEST_LIFECYCLES = ["open", "closed", "merged"] as const;
export type RemoteGitPullRequestLifecycle = typeof REMOTE_GIT_PULL_REQUEST_LIFECYCLES[number];

export const REMOTE_GIT_PROVIDER_ERROR_KINDS = [
  "auth",
  "permission",
  "not_found",
  "validation",
  "conflict",
  "idempotency_conflict",
  "rate_limit",
  "temporary",
  "permanent"
] as const;
export type RemoteGitProviderErrorKind = typeof REMOTE_GIT_PROVIDER_ERROR_KINDS[number];

export type RemoteGitOperation =
  | "push_branch"
  | "create_pull_request"
  | "update_pull_request"
  | "read_pull_request";

export type RemoteGitProviderDescriptor = {
  contract_version: typeof REMOTE_GIT_PROVIDER_CONTRACT_VERSION;
  display_name: string;
  provider_id: string;
};

/** A locator for a credential managed outside provider requests and results. */
export type RemoteGitAuthRef = {
  kind: "secret_ref";
  provider_id: string;
  ref: string;
};

export type RemoteGitRepositoryRef = {
  provider_id: string;
  repository_ref: string;
};

export type RemoteGitWriteContext = {
  actor: DomainActor;
  authorization: {
    authority: "deterministic_policy" | "human_approval";
    decision: "allow";
    policy_ref: string;
  };
  correlation_id: string;
  handoff_id: HandoffID;
  idempotency_key: string;
  intent_event_ref: string;
  work_id: WorkID;
};

export type RemoteGitRateLimit = {
  limit?: number;
  remaining?: number;
  reset_at?: string;
  resource?: string;
  retry_after_seconds?: number;
};

export type RemoteGitProviderResponse<T> = {
  provider_request_ref?: string;
  rate_limit?: RemoteGitRateLimit;
  value: T;
};

export type RemoteGitMutationResponse<T> = RemoteGitProviderResponse<T> & {
  idempotency: {
    key: string;
    replayed: boolean;
  };
};

export type RemoteGitPushBranchRequest = {
  auth_ref: RemoteGitAuthRef;
  commit_ref: string;
  expected_remote_revision: string | null;
  local_branch_ref: string;
  local_repository_path: string;
  remote_branch: string;
  repository: RemoteGitRepositoryRef;
  write: RemoteGitWriteContext;
};

export type RemoteGitPushResult = {
  before_revision: string | null;
  commit_ref: string;
  outcome: "created" | "updated" | "unchanged";
  remote_branch: string;
  remote_ref: string;
};

export type RemoteGitCreatePullRequestRequest = {
  auth_ref: RemoteGitAuthRef;
  base_branch: string;
  body: string;
  head_branch: string;
  head_revision: string;
  labels?: readonly string[];
  readiness: RemoteGitPullRequestReadiness;
  repository: RemoteGitRepositoryRef;
  reviewer_refs?: readonly string[];
  title: string;
  write: RemoteGitWriteContext;
};

export type RemoteGitPullRequestPatch = {
  body?: string;
  labels?: readonly string[];
  readiness?: RemoteGitPullRequestReadiness;
  reviewer_refs?: readonly string[];
  title?: string;
};

export type RemoteGitUpdatePullRequestRequest = {
  auth_ref: RemoteGitAuthRef;
  patch: RemoteGitPullRequestPatch;
  pull_request_ref: string;
  repository: RemoteGitRepositoryRef;
  write: RemoteGitWriteContext;
};

export type RemoteGitReadPullRequestRequest = {
  auth_ref: RemoteGitAuthRef;
  pull_request_ref: string;
  repository: RemoteGitRepositoryRef;
};

export type RemoteGitPullRequest = {
  base_branch: string;
  body: string;
  head_branch: string;
  head_revision: string;
  labels: string[];
  lifecycle: RemoteGitPullRequestLifecycle;
  pull_request_ref: string;
  readiness: RemoteGitPullRequestReadiness;
  repository_ref: string;
  reviewer_refs: string[];
  title: string;
  updated_at: string;
  url: string;
};

export interface RemoteGitProvider {
  readonly descriptor: RemoteGitProviderDescriptor;

  pushBranch(request: RemoteGitPushBranchRequest): Promise<RemoteGitMutationResponse<RemoteGitPushResult>>;
  createPullRequest(
    request: RemoteGitCreatePullRequestRequest
  ): Promise<RemoteGitMutationResponse<RemoteGitPullRequest>>;
  updatePullRequest(
    request: RemoteGitUpdatePullRequestRequest
  ): Promise<RemoteGitMutationResponse<RemoteGitPullRequest>>;
  readPullRequest(request: RemoteGitReadPullRequestRequest): Promise<RemoteGitProviderResponse<RemoteGitPullRequest>>;
}

export class RemoteGitProviderError extends Error {
  readonly kind: RemoteGitProviderErrorKind;
  readonly operation: RemoteGitOperation;
  readonly provider_id?: string;
  readonly provider_request_ref?: string;
  readonly rate_limit?: RemoteGitRateLimit;
  readonly retryable: boolean;
  readonly status_code?: number;

  constructor(message: string, options: {
    kind: RemoteGitProviderErrorKind;
    operation: RemoteGitOperation;
    provider_id?: string;
    provider_request_ref?: string;
    rate_limit?: RemoteGitRateLimit;
    status_code?: number;
  }) {
    const safeMessage = redactedUserVisibleText(message) || "Remote Git provider error";
    super(safeMessage);
    this.name = "RemoteGitProviderError";
    this.kind = options.kind;
    this.operation = options.operation;
    this.provider_id = options.provider_id;
    this.provider_request_ref = options.provider_request_ref;
    this.rate_limit = options.rate_limit;
    this.retryable = options.kind === "rate_limit" || options.kind === "temporary";
    this.status_code = options.status_code;
  }
}

export class RemoteGitRateLimitError extends RemoteGitProviderError {
  readonly retry_after_seconds?: number;

  constructor(message: string, options: {
    operation: RemoteGitOperation;
    provider_id?: string;
    provider_request_ref?: string;
    rate_limit: RemoteGitRateLimit;
    status_code?: number;
  }) {
    super(message, { ...options, kind: "rate_limit" });
    this.name = "RemoteGitRateLimitError";
    this.retry_after_seconds = options.rate_limit.retry_after_seconds;
  }
}

export class RemoteGitIdempotencyConflictError extends RemoteGitProviderError {
  readonly idempotency_key: string;

  constructor(message: string, options: {
    idempotency_key: string;
    operation: Exclude<RemoteGitOperation, "read_pull_request">;
    provider_id?: string;
    provider_request_ref?: string;
  }) {
    super(message, { ...options, kind: "idempotency_conflict" });
    this.name = "RemoteGitIdempotencyConflictError";
    this.idempotency_key = options.idempotency_key;
  }
}

/** Runtime guard shared by adapters before resolving credentials. */
export function assertRemoteGitAuthRef(
  value: unknown,
  expectedProviderID: string,
  operation: RemoteGitOperation
): asserts value is RemoteGitAuthRef {
  const input = objectValue(value, "auth_ref", operation);
  exactKeys(input, ["kind", "provider_id", "ref"], "auth_ref", operation);
  if (input.kind !== "secret_ref") validationError("auth_ref.kind must be secret_ref", operation);
  const providerID = requiredText(input.provider_id, "auth_ref.provider_id", operation, 128);
  if (providerID !== requiredText(expectedProviderID, "provider id", operation, 128)) {
    validationError("auth_ref.provider_id does not match the provider", operation);
  }
  requiredText(input.ref, "auth_ref.ref", operation, 4096);
}

/** Runtime guard shared by adapters before every external write. */
export function assertRemoteGitWriteContext(
  value: unknown,
  operation: Exclude<RemoteGitOperation, "read_pull_request">
): asserts value is RemoteGitWriteContext {
  const input = objectValue(value, "write context", operation);
  exactKeys(input, [
    "actor",
    "authorization",
    "correlation_id",
    "handoff_id",
    "idempotency_key",
    "intent_event_ref",
    "work_id"
  ], "write context", operation);

  const actor = objectValue(input.actor, "write.actor", operation);
  exactKeys(actor, ["id", "kind"], "write.actor", operation);
  requiredText(actor.id, "write.actor.id", operation, 4096);
  if (!["user", "supervisor", "runner", "guardian", "automation", "system"].includes(String(actor.kind))) {
    validationError("write.actor.kind is not trusted", operation);
  }

  const authorization = objectValue(input.authorization, "write.authorization", operation);
  exactKeys(authorization, ["authority", "decision", "policy_ref"], "write.authorization", operation);
  if (authorization.authority !== "deterministic_policy" && authorization.authority !== "human_approval") {
    validationError("write.authorization.authority is not trusted", operation);
  }
  if (authorization.decision !== "allow") {
    validationError("remote Git writes require an allow decision", operation);
  }
  requiredText(authorization.policy_ref, "write.authorization.policy_ref", operation, 4096);
  requiredText(input.correlation_id, "write.correlation_id", operation, 4096);
  requiredText(input.idempotency_key, "write.idempotency_key", operation, 256);
  requiredText(input.intent_event_ref, "write.intent_event_ref", operation, 8192);

  const handoffID = requiredText(input.handoff_id, "write.handoff_id", operation, 8192);
  const workID = requiredText(input.work_id, "write.work_id", operation, 8192);
  if (parseDomainID(handoffID)?.kind !== "handoff") validationError("write.handoff_id is invalid", operation);
  if (parseDomainID(workID)?.kind !== "work") validationError("write.work_id is invalid", operation);
}

function objectValue(value: unknown, label: string, operation: RemoteGitOperation): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) validationError(`${label} must be an object`, operation);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  operation: RemoteGitOperation
): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) validationError(`${label} contains unsupported fields: ${extras.sort().join(", ")}`, operation);
}

function requiredText(value: unknown, label: string, operation: RemoteGitOperation, maximum: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") validationError(`${label} is required`, operation);
  if (text.length > maximum) validationError(`${label} exceeds ${maximum} characters`, operation);
  if (/\0|\r|\n/.test(text)) validationError(`${label} cannot contain control lines`, operation);
  return text;
}

function validationError(message: string, operation: RemoteGitOperation): never {
  throw new RemoteGitProviderError(message, { kind: "validation", operation });
}
