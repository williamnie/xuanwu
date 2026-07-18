import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  parseSupervisorWorkflowEvalSuiteJSON,
  SUPERVISOR_WORKFLOW_EVAL_SCORERS
} from "./supervisorWorkflowContracts.ts";
import { renderSupervisorWorkflowEvalMarkdown, runSupervisorWorkflowEvaluation } from "./supervisorWorkflowEval.ts";
import { runSupervisorWorkflowEvalCLI } from "./runSupervisorWorkflowEval.ts";

const FIXTURE = resolve(import.meta.dir, "../../../docs/fixtures/evals/supervisor-workflow-eval-v1.json");
const ADR = resolve(import.meta.dir, "../../../docs/architecture/xuanwu/0065-supervisor-workflow-evaluation-harness.md");
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Supervisor and Workflow Evaluation Harness", () => {
  test("replays all fixed fixtures and model variants through canonical scorers", () => {
    const suite = fixtureSuite();
    const report = runSupervisorWorkflowEvaluation(suite);

    expect(report).toMatchObject({
      cases: 12,
      generated_at: suite.evaluation_time,
      regression: {
        baseline_variant_id: "fixture-baseline",
        comparisons: [{ candidate_variant_id: "fixture-candidate", passed: true, score_regression: 0 }]
      },
      status: "passed",
      suite_id: "supervisor-workflow-core-v1"
    });
    expect(report.variants).toHaveLength(2);
    expect(report.variants.every((variant) => variant.score === 1 && variant.passed)).toBe(true);
    expect(report.variants[1].total_tokens).toBeLessThan(report.variants[0].total_tokens);
    for (const variant of report.variants) {
      expect(Object.keys(variant.required_scorer_scores).sort()).toEqual([...SUPERVISOR_WORKFLOW_EVAL_SCORERS].sort());
      expect(Object.values(variant.required_scorer_scores).every((score) => score === 1)).toBe(true);
    }
  });

  test("fails closed on malformed variant observations and threshold regressions", () => {
    const parsed = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, any>;
    delete parsed.cases[0].observations["fixture-candidate"];
    expect(() => parseSupervisorWorkflowEvalSuiteJSON(JSON.stringify(parsed)))
      .toThrow("intent-answer is missing observation for fixture-candidate");

    const suite = fixtureSuite();
    suite.cases[0].observations["fixture-candidate"]!.token_usage = {
      estimated_cost_usd: 0.009,
      input_tokens: 1400,
      output_tokens: 600,
      total_tokens: 2000
    };
    const report = runSupervisorWorkflowEvaluation(suite);
    expect(report.status).toBe("failed");
    expect(report.regression.comparisons[0]).toMatchObject({ passed: false });
  });

  test("writes deterministic JSON and Markdown reports for local or CI collection", async () => {
    const output = await mkdtemp(join(tmpdir(), "xw-eval-report-"));
    tempRoots.push(output);
    const writes: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await runSupervisorWorkflowEvalCLI(["--suite", FIXTURE, "--output-dir", output])).toBe(0);
    } finally {
      process.stdout.write = originalWrite;
    }

    const jsonPath = join(output, "supervisor-workflow-eval-report.json");
    const markdownPath = join(output, "supervisor-workflow-eval-report.md");
    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(markdownPath)).toBe(true);
    expect(JSON.parse(await readFile(jsonPath, "utf8"))).toEqual(runSupervisorWorkflowEvaluation(fixtureSuite()));
    expect(await readFile(markdownPath, "utf8")).toBe(renderSupervisorWorkflowEvalMarkdown(runSupervisorWorkflowEvaluation(fixtureSuite())));
    expect(writes.join("")).toContain("Status: **PASSED**");
  });

  test("documents authority, offline operation, rollback, and deletion gates", () => {
    const adr = readFileSync(ADR, "utf8");
    for (const phrase of [
      "xw.supervisor-workflow-eval-suite.v1",
      "只读评测投影",
      "双写：0",
      "双读：0",
      "回滚",
      "最终删除门禁",
      "不调用真实外部服务",
      "commandExecution"
    ]) expect(adr).toContain(phrase);
  });
});

function fixtureSuite() {
  return parseSupervisorWorkflowEvalSuiteJSON(readFileSync(FIXTURE, "utf8"));
}
