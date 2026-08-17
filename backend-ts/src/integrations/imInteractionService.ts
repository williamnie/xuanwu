import type { RunnerDatabase } from "../db/database.ts";
import {
  claimImInteractionBinding,
  completeImInteractionBinding,
  getImInteractionBinding,
  type ImInteractionBinding
} from "../db/repositories/imInteractionBindings.ts";
import { redactSensitiveText } from "../util/redact.ts";

/**
 * Generic IM interaction service (design §5.6/§10.3): provider callback
 * parsers normalize their protocol payloads into an `ImInteractionCallback`
 * and hand it here. This service performs the fail-closed gates that are
 * provider-neutral — opaque token resolution, connector/scope binding,
 * expiry, revision and consume-once — then delegates the authoritative
 * business transition to the action-kind resolver. It never trusts callback
 * payload fields beyond the opaque token + action index.
 */

export type ImInteractionCallback = {
  actor: {
    id?: string;
    openId?: string;
  };
  connectorId: string;
  /** Raw provider event/callback id used for duplicate short-circuit audits. */
  eventId?: string;
  /** 128-bit opaque token from the provider callback payload. */
  interactionId: string;
  /** Opaque action index emitted by the channel presentation adapter. */
  actionId: string;
  revision: number;
  scopeKey: string;
};

export type ImInteractionResolutionContext = {
  action: ImInteractionBinding["actions"][number];
  actor: ImInteractionCallback["actor"];
  binding: ImInteractionBinding;
  callback: ImInteractionCallback;
  database: RunnerDatabase;
  now: Date;
};

export type ImInteractionResolveResult = {
  ok: boolean;
  status: string;
};

export type ImInteractionResolvers = {
  approval?: (context: ImInteractionResolutionContext) => Promise<ImInteractionResolveResult>;
  piAction?: (context: ImInteractionResolutionContext) => Promise<ImInteractionResolveResult>;
  projectSelection?: (context: ImInteractionResolutionContext) => Promise<ImInteractionResolveResult>;
};

export type ImInteractionHandleResult = {
  reason:
    | "action_mismatch"
    | "actor_mismatch"
    | "already_consumed"
    | "consumed"
    | "expired"
    | "missing_binding"
    | "resolution_in_progress"
    | "resolution_lost"
    | "resolver_unavailable"
    | "revision_mismatch"
    | "source_mismatch"
    | "unsupported_action_kind";
  resolution?: ImInteractionResolveResult;
};

const ACTION_KIND_RESOLVER_KEYS = {
  approval: "approval",
  pi_action: "piAction",
  project_selection: "projectSelection"
} as const;

export type ImInteractionServiceOptions = {
  clock?: { now(): Date };
  database: RunnerDatabase;
  leaseMs?: number;
  resolvers: ImInteractionResolvers;
};

export function createImInteractionService(options: ImInteractionServiceOptions) {
  return {
    handle: (callback: ImInteractionCallback) => handleImInteraction(options, callback)
  };
}

export async function handleImInteraction(
  options: ImInteractionServiceOptions,
  callback: ImInteractionCallback
): Promise<ImInteractionHandleResult> {
  const interactionId = cleanString(callback.interactionId);
  const connectorId = cleanString(callback.connectorId);
  if (interactionId === "" || connectorId === "") {
    return { reason: "missing_binding" };
  }
  const binding = getImInteractionBinding(options.database, interactionId);
  if (!binding) return { reason: "missing_binding" };
  const resolverKey = ACTION_KIND_RESOLVER_KEYS[binding.action_kind as keyof typeof ACTION_KIND_RESOLVER_KEYS];
  if (!resolverKey) return { reason: "unsupported_action_kind" };
  const resolver = options.resolvers[resolverKey];
  if (!resolver) return { reason: "resolver_unavailable" };
  const action = binding.actions.find((item) => item.action_id === cleanString(callback.actionId));
  if (!action) return { reason: "action_mismatch" };
  const now = options.clock?.now() ?? new Date();
  const claimed = claimImInteractionBinding(options.database, {
    actionId: callback.actionId,
    actor: callback.actor,
    connectorId,
    interactionId,
    leaseMs: options.leaseMs,
    now,
    revision: callback.revision,
    scopeKey: callback.scopeKey
  });
  if (claimed.status !== "claimed" || !claimed.binding || claimed.leaseId === "") {
    return {
      reason: mapClaimFailure(claimed.status),
      ...(claimed.status === "already_consumed"
        ? { resolution: storedResolution(claimed.binding?.resolution_json) }
        : {})
    };
  }
  let resolution: ImInteractionResolveResult;
  try {
    resolution = await resolver({
      action,
      actor: callback.actor,
      binding: claimed.binding,
      callback,
      database: options.database,
      now
    });
  } catch (error) {
    // A deterministic 4xx business rejection (invalid action/state/scope) is
    // terminal for this callback. Persist it as the one stable resolution so
    // it cannot pin the durable update cursor in an infinite retry loop.
    // Unclassified failures still keep the lease/retry path for crash and
    // transient recovery.
    if (!isPermanentResolverError(error)) throw error;
    resolution = { ok: false, status: safeInteractionError(error) };
  }
  const completed = completeImInteractionBinding(options.database, {
    interactionId,
    leaseId: claimed.leaseId,
    resolution,
    now: options.clock?.now() ?? new Date()
  });
  if (!completed) return { reason: "resolution_lost" };
  return { reason: "consumed", resolution };
}

function storedResolution(value: string | undefined): ImInteractionResolveResult | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return typeof parsed.ok === "boolean" && typeof parsed.status === "string"
      ? { ok: parsed.ok, status: parsed.status }
      : undefined;
  } catch {
    return undefined;
  }
}

function mapClaimFailure(status: string): ImInteractionHandleResult["reason"] {
  if (status === "action_mismatch") return "action_mismatch";
  if (status === "actor_mismatch") return "actor_mismatch";
  if (status === "already_consumed") return "already_consumed";
  if (status === "expired") return "expired";
  if (status === "source_mismatch") return "source_mismatch";
  if (status === "revision_mismatch") return "revision_mismatch";
  if (status === "resolution_in_progress") return "resolution_in_progress";
  return "missing_binding";
}

export function safeInteractionError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error))
    .replace(/(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g, "[redacted-path]");
}

function isPermanentResolverError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = Number((error as { status?: unknown }).status);
  return Number.isInteger(status) && status >= 400 && status < 500;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
