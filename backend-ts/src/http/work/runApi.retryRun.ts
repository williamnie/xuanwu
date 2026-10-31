import { type RunDetail } from "../../db/repositories/runs.ts";
import { requestNewRun } from "../../domain/run/service.ts";
import { json } from "../errors.ts";
import type { ReadApiContext } from "../readApiContext.ts";
import type { Router } from "../router.ts";
import { runResponse, listResponse, requireRun } from "./runApi.listResponse.ts";
import { detailResponse, transcriptResponse, runID, actionInput, objectBody, assertKeys, revisionInput, auditInput, latestAttempt } from "./runApi.transcriptResponse.ts";
import { interruptRun, resumeRun, kickProject, mutationResponse } from "./runApi.resumeRun.ts";

export function registerRunRoutes(router: Router, context: ReadApiContext): void {
  router.get("/api/runs", (request) => runResponse(() => listResponse(context, request), request));
  router.get("/api/runs/:id", (request) => runResponse(() => detailResponse(context, request)));
  router.get("/api/runs/:id/transcript", (request) => runResponse(() => transcriptResponse(context, request)));
  router.post("/api/runs/:id/actions/:action", async (request) => runResponse(async () => {
    const run = requireRun(context, runID(request));
    const action = actionInput(request);
    const body = await objectBody(request);
    if (action === "interrupt") return interruptRun(context, run, body);
    if (action === "resume") return resumeRun(context, run, body);
    return retryRun(context, run, body);
  }));
}

export function retryRun(
  context: ReadApiContext,
  run: RunDetail,
  body: Record<string, unknown>
): Response | Record<string, unknown> {
  assertKeys(body, ["audit", "expected_revision"]);
  const expectedRevision = revisionInput(body.expected_revision, "expected_revision");
  const audit = auditInput(body.audit);
  const latest = latestAttempt(run);
  const operation = run.status && ["succeeded", "failed", "cancelled"].includes(run.status)
    ? "retry"
    : latest.status === "interrupted" ? "supersede" : "retry";
  const result = requestNewRun(context.database, {
    audit,
    expected_revision: expectedRevision,
    issue_run_id: run.legacy.id,
    operation,
    run_id: run.id
  });
  if (!result.applied) {
    return json({
      code: "run_precondition_failed",
      message: "Run retry rejected",
      mutation: { action: "retry", audit_event_id: audit.event_id, operation },
      violations: result.violations
    }, { status: 409 });
  }
  kickProject(context, run.project_id);
  return mutationResponse(context, run.id, {
    action: "retry",
    audit_event_id: audit.event_id,
    operation,
    replayed: result.replayed,
    requested_sequence: result.requested_sequence
  });
}
