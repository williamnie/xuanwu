export type GoldenJourneyScenario = {
  api_paths: string[];
  backend_tests: string[];
  fixture_projects: number;
  frontend_route: string;
  frontend_tests: string[];
  id: `GJ-0${1 | 2 | 3 | 4 | 5 | 6}`;
  name: string;
};

export const GOLDEN_JOURNEY_SCENARIOS: readonly GoldenJourneyScenario[] = [
  {
    api_paths: ["/api/issues", "/api/evidence", "/api/handoffs"],
    backend_tests: [
      "backend-ts/src/http/piIssueProposalFlow.test.ts",
      "backend-ts/src/http/piVerifierWorkflowApi.test.ts",
      "backend-ts/src/http/issueVerificationApi.test.ts"
    ],
    fixture_projects: 1,
    frontend_route: "#/issues",
    frontend_tests: [
      "frontend/src/pages/issueVerificationGate.test.js",
      "frontend/src/pages/IssueDetail.structure.test.js"
    ],
    id: "GJ-01",
    name: "一句话交付"
  },
  {
    api_paths: ["/api/issues", "/api/issues/{issue_id}/supervisor", "/api/command-center/summary?sections=attention"],
    backend_tests: [
      "backend-ts/src/pi/issue-supervisor-recovery.test.ts",
      "backend-ts/src/http/piSupervisorResumeIdempotency.test.ts"
    ],
    fixture_projects: 1,
    frontend_route: "#/issues",
    frontend_tests: ["frontend/src/pages/issue-supervisor-panel.test.js"],
    id: "GJ-02",
    name: "失败恢复"
  },
  {
    api_paths: ["/api/projects", "/api/issues", "/api/works"],
    backend_tests: [
      "backend-ts/src/pi/runnerBatchTriageScope.test.ts",
      "backend-ts/src/runner/projectLoop.test.ts",
      "backend-ts/src/db/repositories/pi/runGroupLifecycle.test.ts"
    ],
    fixture_projects: 2,
    frontend_route: "#/projects",
    frontend_tests: [
      "frontend/src/pages/sessions/projectOrder.test.js",
      "frontend/src/pages/projectHold.test.js"
    ],
    id: "GJ-03",
    name: "跨项目批量"
  },
  {
    api_paths: ["/api/issues", "/api/pi/actions", "/api/sync-outbox?source=feishu"],
    backend_tests: [
      "backend-ts/src/integrations/feishuAgentBridgePiFirst.test.ts",
      "backend-ts/src/integrations/feishuApprovalRequests.test.ts",
      "backend-ts/src/http/piActionsAuditApi.test.ts"
    ],
    fixture_projects: 1,
    frontend_route: "#/command-center",
    frontend_tests: ["frontend/src/pages/command-center/attentionModel.test.js"],
    id: "GJ-04",
    name: "远程控制"
  },
  {
    api_paths: ["/api/automations", "/api/pi/guardian/notification-intents", "/api/command-center/summary?sections=attention"],
    backend_tests: [
      "backend-ts/src/pi/heartbeatOrchestrator.test.ts",
      "backend-ts/src/runner/piAutoManageSchedulerWatchdog.test.ts",
      "backend-ts/src/pi/heartbeatConcurrency.test.ts"
    ],
    fixture_projects: 1,
    frontend_route: "#/automations",
    frontend_tests: [
      "frontend/src/pages/command-center/attentionModel.test.js",
      "frontend/src/pages/projectHold.test.js"
    ],
    id: "GJ-05",
    name: "常驻巡检"
  },
  {
    api_paths: ["/api/evidence", "/api/handoffs", "/api/notifications"],
    backend_tests: [
      "backend-ts/src/http/issueVerificationApi.test.ts",
      "backend-ts/src/http/piVerifierWorkflowApi.test.ts",
      "backend-ts/src/cli/issue.test.ts",
      "backend-ts/src/http/handoffApi.test.ts"
    ],
    fixture_projects: 1,
    frontend_route: "#/handoffs",
    frontend_tests: [
      "frontend/src/pages/issueVerificationGate.test.js",
      "frontend/src/pages/IssueDetail.structure.test.js",
      "frontend/src/pages/handoffPageModel.test.js"
    ],
    id: "GJ-06",
    name: "发布交付"
  }
] as const;
