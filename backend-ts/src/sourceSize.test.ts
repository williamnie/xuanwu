import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

// 保留原本略超 300 行的模块；新文件与已拆分模块不再扩大上限。
const retainedLimits: Record<string, number> = {
  "runner/watchAutomationRuntime.ts": 312,
  "workflows/manifest.ts": 330,
  "http/server.ts": 316,
  "db/migrationRehearsal.ts": 307,
  "notifications/unifiedNotificationPipeline.test.ts": 323,
  "domain/attention/legacyAdapters.ts": 306,
  "domain/evidence/contracts.ts": 317,
  "domain/evidence/gitCollector.test.ts": 330,
  "domain/work/issueAdapter.test.ts": 316,
  "domain/automation/consolidationAudit.ts": 327,
  "domain/run/lifecycleStore.ts": 311,
  "events/maintenance/maintenance.test.ts": 306,
  "skills/jev/jevRuntimeSmoke.test.ts": 308,
  "db/repositories/pi.test.ts": 324,
  "http/ingress/feishuProjectSelectionCallbackApi.test.ts": 301,
  "http/pi/piApi.test.ts": 314,
  "http/pi/piActionProposalExecution.ts": 321,
  "http/pi/piSupervisorResumeIdempotency.test.ts": 326,
  "http/work/handoffApi.ts": 312,
  "pi/runtime/codexLoginCredentials.test.ts": 310,
  "pi/actions/actionEngine.ts": 319,
  "pi/actions/authorizationDecision.test.ts": 319,
  "pi/supervisor/providerErrorParser.test.ts": 304,
  "pi/supervisor/issueSupervisorActions.ts": 311,
  "pi/reports/reports.ts": 310,
  "integrations/feishu/feishuReceiver.ts": 309,
  "providers/core/registry.test.ts": 308,
  "providers/core/registry.ts": 308,
  "providers/claude/herdrProvider.ts": 312,
  "providers/codex/events.ts": 322,
  "providers/pi/rpcTransport.ts": 317
};

test("backend modules stay within their line budget", () => {
  const root = new URL("./", import.meta.url);
  const oversized = readdirSync(root, { recursive: true })
    .filter((file): file is string => typeof file === "string" && /\.(?:ts|js|mjs|cjs)$/.test(file))
    .flatMap((file) => {
      const source = readFileSync(new URL(file, root), "utf8");
      const lines = source.replace(/\n$/, "").split("\n").length;
      const limit = retainedLimits[file] ?? 300;
      return lines > limit ? [`${file}: ${lines} > ${limit}`] : [];
    });
  expect(oversized).toEqual([]);
});
