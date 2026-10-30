import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const issueRuns = read("../../db/repositories/issueRuns.ts");
const providerRuntime = [
  "", ".model", ".execution", ".events", ".outcomes", ".policy", ".persistence", ".publication", ".errors"
].map(suffix => read(`../../runner/providerRuntime${suffix}.ts`)).join("\n");
const productionMaterializers = [
  "../../db/repositories/issueQueue.ts",
  "../review/humanReview.ts",
  "../review/humanReviewModel.ts",
  "../review/humanReviewProjection.ts",
  "../review/humanReviewResume.ts",
  ...["", ".model", ".apply", ".outcomes", ".continuation", ".prompts", ".retry", ".progress", ".audit"]
    .map(suffix => `../../runner/piAcceptanceApplication${suffix}.ts`),
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
