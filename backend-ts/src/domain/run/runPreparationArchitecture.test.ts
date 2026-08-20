import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const issueRuns = read("../../db/repositories/issueRuns.ts");
const providerRuntime = read("../../runner/providerRuntime.ts");
const productionMaterializers = [
  "../../db/repositories/issueQueue.ts",
  "../review/humanReview.ts",
  "../../runner/piAcceptanceApplication.ts",
  "../../runner/automationWorkRunExecutor.ts"
].map(read).join("\n");

test("Run materialization keeps external observation out of DB repositories", () => {
  expect(issueRuns).not.toContain("gitWorkspaceObservation");
  expect(issueRuns).not.toContain("Bun.spawn");
  expect(issueRuns).not.toContain("spawnSync");
  expect(productionMaterializers).toContain("insertIssueRunRecord");
  expect(productionMaterializers).not.toContain("createIssueRun(");
});

test("Provider runtime validates an explicit canonical current Run without importing a materializer", () => {
  expect(providerRuntime).toContain("mustGetCurrentOpenIssueRun");
  expect(providerRuntime).toContain("input.issueRunId");
  expect(providerRuntime).not.toContain("insertIssueRunRecord");
  expect(providerRuntime).not.toContain("ensureOpenIssueRun");
});

function read(path: string): string { return readFileSync(new URL(path, import.meta.url), "utf8"); }
