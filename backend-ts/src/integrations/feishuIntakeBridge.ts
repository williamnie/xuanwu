import type { RunnerDatabase } from "../db/database.ts";
import { getExternalEvent, listExternalEvents } from "../db/repositories/externalEvents.ts";
import {
  routeInboxItemToDomainSkill,
  routeRawEventToIntake,
  type DomainRouteResult,
  type EventRouterSourcePolicy,
  type IntakeRouteResult
} from "../pi/eventRouter.ts";
import type { LlmIntakeModel, LlmIntakeOptions } from "../pi/llmIntake.ts";
import type { FeishuIngestResult } from "./feishuIngest.ts";

export type FeishuGenericIntakeOptions = {
  database: RunnerDatabase;
  domainSkillID?: string;
  ingest: FeishuIngestResult;
  maxEvents?: number;
  model?: LlmIntakeModel;
  now?: Date;
  policy?: EventRouterSourcePolicy;
  skillId?: string;
};

export type FeishuGenericIntakeResult = {
  domain_routes: DomainRouteResult[];
  intake_route?: IntakeRouteResult;
  reason: string;
  status: "routed" | "skipped";
};

export async function routeFeishuMessageToGenericIntake(
  options: FeishuGenericIntakeOptions
): Promise<FeishuGenericIntakeResult> {
  if (!options.model) return skipped("no_intake_model");
  const event = getExternalEvent(options.database, options.ingest.event_id);
  if (!event) return skipped("external_event_missing");
  if (event.source !== "feishu") return skipped("not_feishu_source");
  const route = await routeRawEventToIntake(
    options.database,
    event,
    listExternalEvents(options.database, { limit: options.maxEvents ?? 100, source: "feishu" }),
    options.model,
    intakeOptions(options)
  );
  if (route.status !== "routed" || !route.result) {
    return { domain_routes: [], intake_route: route, reason: route.reason, status: "skipped" };
  }
  const domainRoutes = route.result.created_items.map((item) => routeInboxItemToDomainSkill(
    options.database,
    item,
    {
      policy: feishuPolicy(options.policy),
      project: { project_confirmed: event.project_id !== "", project_id: event.project_id },
      skillID: options.domainSkillID
    }
  ));
  return { domain_routes: domainRoutes, intake_route: route, reason: "generic_intake_routed", status: "routed" };
}

function intakeOptions(options: FeishuGenericIntakeOptions): LlmIntakeOptions & {
  maxEvents?: number;
  policy: EventRouterSourcePolicy;
} {
  return {
    maxEvents: options.maxEvents,
    now: options.now,
    policy: feishuPolicy(options.policy),
    skillId: options.skillId
  };
}

function feishuPolicy(input: EventRouterSourcePolicy | undefined): EventRouterSourcePolicy {
  return { profile: "company_chat", ...input };
}

function skipped(reason: string): FeishuGenericIntakeResult {
  return { domain_routes: [], reason, status: "skipped" };
}
