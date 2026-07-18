import { registerAutomationRoutes } from "./automationApi.ts";
import { registerCommandCenterRoutes } from "./commandCenterApi.ts";
import { registerEventSummaryRoutes } from "./eventSummariesApi.ts";
import { registerEvidenceRoutes } from "./evidenceApi.ts";
import { registerFrontendCompatRoutes } from "./frontendCompatApi.ts";
import { registerHandoffRoutes } from "./handoffApi.ts";
import { registerPiRoutes } from "./piApi.ts";
import { registerPiSupervisorRoutes } from "./piSupervisorApi.ts";
import { registerCoreReadRoutes } from "./readApiRoutes.ts";
import { registerRunRoutes } from "./runApi.ts";
import { registerSessionRoutes } from "./sessionApi.ts";
import { registerUsageRoutes } from "./usageApi.ts";
import { registerWorkRoutes } from "./workApi.ts";
import type { ReadApiContext } from "./readApiContext.ts";
import type { Router } from "./router.ts";

type RouteResponsibility = "domain" | "legacy-compatibility" | "projection";
type ReadApiRouteRegistration = {
  id: string;
  register: (router: Router, context: ReadApiContext) => void;
  responsibility: RouteResponsibility;
};

export const READ_API_ROUTE_REGISTRY = [
  { id: "automations", register: registerAutomationRoutes, responsibility: "domain" },
  { id: "command-center", register: registerCommandCenterRoutes, responsibility: "projection" },
  { id: "evidence", register: registerEvidenceRoutes, responsibility: "domain" },
  { id: "event-summaries", register: registerEventSummaryRoutes, responsibility: "projection" },
  { id: "core-read", register: registerCoreReadRoutes, responsibility: "domain" },
  { id: "pi-supervisor", register: registerPiSupervisorRoutes, responsibility: "domain" },
  { id: "pi", register: registerPiRoutes, responsibility: "domain" },
  { id: "runs", register: registerRunRoutes, responsibility: "domain" },
  { id: "sessions", register: registerSessionRoutes, responsibility: "domain" },
  { id: "work", register: registerWorkRoutes, responsibility: "domain" },
  { id: "frontend-compat", register: registerFrontendCompatRoutes, responsibility: "legacy-compatibility" },
  { id: "handoffs", register: registerHandoffRoutes, responsibility: "domain" },
  { id: "usage", register: registerUsageRoutes, responsibility: "projection" }
] as const satisfies readonly ReadApiRouteRegistration[];

export function registerReadApiRoutes(router: Router, context: ReadApiContext): void {
  for (const entry of READ_API_ROUTE_REGISTRY) entry.register(router, context);
}

export type { ReadApiContext } from "./readApiContext.ts";
