import type { RunnerDatabase } from "../db/database.ts";
import { getProjectPiSettings, readProjectPiPolicy } from "../db/repositories/pi.ts";
import { getProject } from "../db/repositories/projects.ts";
import {
  resolveSourcePolicy,
  SOURCE_PROFILES,
  type SourceProfile
} from "../pi/eventRouter.ts";
import { HttpError, json } from "./errors.ts";
import type { Router } from "./router.ts";

type JsonObject = Record<string, unknown>;
type PiSourcePolicyContext = { database: RunnerDatabase };

const LAYERS = [
  { scope: "source_profile", owner: "eventRouter profile defaults", writable: false },
  { scope: "project", owner: "project_pi_settings / project_pi_policies", writable: false },
  { scope: "global", owner: "runtime safety defaults", writable: false },
  { scope: "automation", owner: "Automation permission_policy_ref", writable: false }
];

export function registerPiSourcePolicyRoutes(router: Router, context: PiSourcePolicyContext): void {
  router.get("/api/pi/source-policies", (request) => json(listResponse(context, request)));
}

function listResponse(context: PiSourcePolicyContext, request: Request): JsonObject {
  const projectID = clean(new URL(request.url).searchParams.get("project_id"));
  return {
    automations: [],
    global_policy: resolveSourcePolicy({ profile: "custom" }),
    layers: LAYERS,
    profiles: SOURCE_PROFILES.map(profilePolicy),
    project_policy: projectID === "" ? null : projectPolicy(context.database, projectID)
  };
}

function profilePolicy(profile: SourceProfile): JsonObject {
  return { id: profile, policy: resolveSourcePolicy({ profile }) };
}

function projectPolicy(db: RunnerDatabase, projectID: string): JsonObject {
  if (!getProject(db, projectID)) throw new HttpError(404, "project 不存在");
  const settings = getProjectPiSettings(db, projectID);
  const policy = readProjectPiPolicy(db, projectID);
  return {
    default_mode: policy.default_mode,
    issue_policy: {
      auto_create_triage_issue: settings?.auto_triage === 1,
      auto_enqueue: settings?.auto_enqueue === 1
    },
    project_id: projectID
  };
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
