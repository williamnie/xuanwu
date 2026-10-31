import { getProject } from "../../db/repositories/projects.ts";
import { applyIssueWorkAction, createIssueBackedWork, updateIssueBackedWork, workIDToIssueID } from "../../domain/work/issueAdapter.ts";
import { WORK_TYPES } from "../../domain/work/contracts.ts";
import { declareIssueReadinessRequirements, readIssueReadiness } from "../../domain/readiness/contracts.ts";
import type { ReadApiContext } from "../readApiContext.ts";
import type { Router } from "../router.ts";
import { cleanString } from "../../util/values.ts";
import { workResponse, summaryResponse, workError } from "./workApi.decodeWorkCursor.ts";
import { listResponse, boardResponse, detailResponse, timelineResponse, requireWork, workID, objectBody, assertKeys } from "./workApi.listResponse.ts";
import { readinessDeclaration, kickProject, requiredString, validateWorkExecutionSelection, auditInput, positiveIssueIDArray, mutationResponse, revisionInput, actionInput } from "./workApi.validateWorkExecutionSelection.ts";

export function registerWorkRoutes(router: Router, context: ReadApiContext): void {
  const readDatabase = context.readDatabase ?? context.database;
  router.get("/api/works/summary", (request) => workResponse(() => summaryResponse(readDatabase, request)));
  router.get("/api/works", (request) => workResponse(() => listResponse(readDatabase, request, context)));
  router.get("/api/works/board", (request) => workResponse(() => boardResponse(readDatabase, request, context)));
  router.get("/api/works/:id", (request) => workResponse(() => detailResponse(readDatabase, request, context)));
  router.get("/api/works/:id/timeline", (request) => (
    workResponse(() => timelineResponse(readDatabase, request))
  ));
  router.put("/api/works/:id/readiness-requirements", async (request) => workResponse(async () => {
    const work = requireWork(context.database, workID(request));
    const body = await objectBody(request);
    assertKeys(body, ["audit", "requirements", "schema_version", "work_id"]);
    const declaration = readinessDeclaration(body, work);
    const result = declareIssueReadinessRequirements(context.database, workIDToIssueID(work.id), declaration);
    kickProject(context, work);
    return {
      mutation: { event_id: result.event_id, replayed: result.replayed },
      readiness: readIssueReadiness(context.database, workIDToIssueID(work.id)),
      work
    };
  }));
  router.post("/api/works", async (request) => workResponse(async () => {
    const body = await objectBody(request);
    assertKeys(body, ["agent_profile_id", "audit", "depends_on_issue_ids", "goal", "project_id", "status", "title", "type"]);
    const projectID = requiredString(body.project_id, "project_id");
    const project = getProject(context.database, projectID);
    if (!project) throw workError(404, "project_not_found", "Project not found");
    const agentProfileID = cleanString(body.agent_profile_id);
    validateWorkExecutionSelection(context, project, agentProfileID);
    const type = cleanString(body.type) || "engineering_task";
    if (!WORK_TYPES.includes(type as typeof WORK_TYPES[number])) {
      throw workError(400, "invalid_request", "type is invalid");
    }
    if (type !== "engineering_task") {
      throw workError(
        409,
        "work_authority_restriction",
        "objective Work creation is unavailable while Issues remain the write authority"
      );
    }
    const status = cleanString(body.status) || "triage";
    if (status !== "triage" && status !== "todo") {
      throw workError(400, "invalid_request", "status must be triage or todo when creating Work");
    }
    const result = createIssueBackedWork(context.database, {
      agent_profile_id: agentProfileID,
      audit: auditInput(body.audit),
      depends_on_issue_ids: positiveIssueIDArray(body.depends_on_issue_ids),
      goal: requiredString(body.goal, "goal"),
      project_id: projectID,
      status,
      ...(cleanString(body.title) ? { title: cleanString(body.title) } : {}),
      type
    });
    kickProject(context, result.work);
    return mutationResponse(result, 201);
  }));
  router.patch("/api/works/:id", async (request) => workResponse(async () => {
    const work = requireWork(context.database, workID(request));
    const body = await objectBody(request);
    assertKeys(body, ["agent_profile_id", "audit", "depends_on_issue_ids", "expected_revision", "goal", "title"]);
    const requestedAgentProfileID = Object.hasOwn(body, "agent_profile_id") ? cleanString(body.agent_profile_id) : undefined;
    if (work.status === "in_progress" && requestedAgentProfileID !== undefined && requestedAgentProfileID !== (work.agent_profile_id ?? "")) {
      throw workError(409, "running_work_profile_locked", "running Work agent_profile_id cannot be changed");
    }
    if (Object.hasOwn(body, "agent_profile_id")) {
      const project = getProject(context.database, work.owner.project_id);
      if (!project) throw workError(404, "project_not_found", "Project not found");
      validateWorkExecutionSelection(context, project, requestedAgentProfileID ?? "");
    }
    const patch = {
      ...(requestedAgentProfileID !== undefined ? { agent_profile_id: requestedAgentProfileID } : {}),
      ...(Object.hasOwn(body, "depends_on_issue_ids")
        ? { depends_on_issue_ids: positiveIssueIDArray(body.depends_on_issue_ids) ?? [] }
        : {}),
      ...(Object.hasOwn(body, "goal") ? { goal: requiredString(body.goal, "goal") } : {}),
      ...(Object.hasOwn(body, "title") && cleanString(body.title) ? { title: cleanString(body.title) } : {})
    };
    if (Object.keys(patch).length === 0) throw workError(400, "invalid_request", "Work patch is empty");
    const result = updateIssueBackedWork(context.database, {
      audit: auditInput(body.audit),
      expected_revision: revisionInput(body.expected_revision),
      patch,
      work_id: work.id
    });
    return mutationResponse(result);
  }));
  router.post("/api/works/:id/actions/:action", async (request) => workResponse(async () => {
    const work = requireWork(context.database, workID(request));
    const action = actionInput(request);
    const body = await objectBody(request);
    assertKeys(body, ["audit", "expected_revision"]);
    const result = applyIssueWorkAction(context.database, {
      action,
      audit: auditInput(body.audit),
      expected_revision: revisionInput(body.expected_revision),
      work_id: work.id
    });
    if (result.applied) kickProject(context, result.work);
    return mutationResponse(result);
  }));
}
