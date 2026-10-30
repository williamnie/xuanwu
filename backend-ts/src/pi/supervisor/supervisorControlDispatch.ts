import type { RunnerDatabase } from "../../db/database.ts";
import { getPiActionByIdempotencyKey } from "../../db/repositories/pi.ts";
import { registerWorkRoutes } from "../../http/work/workApi.ts";
import { registerRunRoutes } from "../../http/work/runApi.ts";
import { createRouter, type Router } from "../../http/router.ts";
import { executeSafePiAction } from "../actions/actionEngine.ts";
import type { PiRunnerActionContext } from "../runnerTools/runnerActions.ts";
import { scopedRunnerChatActionContext } from "../runnerTools/runnerChatAuthorization.ts";
import { SUPERVISOR_CONTROL_READ_ACTION_TYPES } from "./supervisorControlContracts.ts";
import { isRecord } from "../../util/values.ts";
import { MutationActionType, idempotencyKey, DomainCall } from "./supervisorControlTools.ts";
import { compactActionRecord } from "./supervisorControlProjection.ts";
import { targetProjectID, cleanObject, projectID, scopedIdempotencyKey, assertIdempotencyCompatible, requiredString } from "./supervisorControlValidation.ts";

export function readAction(
  db: RunnerDatabase,
  context: PiRunnerActionContext,
  actionType: typeof SUPERVISOR_CONTROL_READ_ACTION_TYPES[number],
  targetProjectID: string,
  payload: Record<string, unknown>,
  execute: () => Promise<unknown>
) {
  return executeSafePiAction(db, context, {
    actionType,
    payload: cleanObject(payload),
    projectID: targetProjectID,
    execute
  });
}

export async function mutationAction(
  db: RunnerDatabase,
  context: PiRunnerActionContext,
  input: {
    actionType: MutationActionType;
    execute: (eventID: string) => Promise<unknown>;
    idempotencyKey: string;
    issueID?: number;
    payload: Record<string, unknown>;
    preconditionFailure?: string;
    projectID: string;
    reason: string;
    target: string;
  }
) {
  const key = scopedIdempotencyKey(input.actionType, input.projectID, input.target, input.idempotencyKey);
  assertIdempotencyCompatible(db, key, input.actionType, input.projectID, input.issueID ?? 0, input.payload);
  const actionContext = scopedRunnerChatActionContext(context, input.actionType, {
    issueID: input.issueID,
    projectID: input.projectID
  });
  await executeSafePiAction(db, actionContext, {
    actionType: input.actionType,
    idempotencyKey: key,
    issueID: input.issueID,
    payload: input.payload,
    projectID: input.projectID,
    rationale: input.reason,
    preconditionFailure: input.preconditionFailure,
    execute: () => input.execute(key)
  });
  const action = getPiActionByIdempotencyKey(db, key);
  if (!action) throw new Error("Supervisor control action missing after execution");
  return compactActionRecord(action);
}

export function createDomainRouter(db: RunnerDatabase, context: PiRunnerActionContext): Router {
  const router = createRouter();
  const apiContext = {
    bus: context.bus,
    database: db,
    providers: context.providers
  };
  registerWorkRoutes(router, apiContext);
  registerRunRoutes(router, apiContext);
  return router;
}

export async function callDomain(
  router: Router,
  path: string,
  body?: Record<string, unknown>,
  method: "GET" | "PATCH" | "POST" = "GET"
): Promise<DomainCall> {
  const response = await router.handle(new Request(`http://supervisor.internal${path}`, {
    ...(body ? { body: JSON.stringify(body) } : {}),
    headers: body ? { "content-type": "application/json" } : undefined,
    method
  }));
  const parsed = await response.json().catch(() => ({ code: "invalid_domain_response", message: "Domain API returned non-JSON" }));
  const output = isRecord(parsed) ? parsed : { value: parsed };
  if (response.status >= 500) {
    throw new Error(requiredString(output.message, "Domain API failure"));
  }
  return { body: output, ok: response.ok, status: response.status };
}
