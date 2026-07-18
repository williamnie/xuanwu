import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GOLDEN_JOURNEY_SCENARIOS } from "./goldenJourneyScenarios.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");

describe("Xuanwu Golden Journey scenario runner", () => {
  test("registers exactly six isolated cross-layer scenarios with executable assertions", () => {
    expect(GOLDEN_JOURNEY_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      "GJ-01", "GJ-02", "GJ-03", "GJ-04", "GJ-05", "GJ-06"
    ]);
    for (const scenario of GOLDEN_JOURNEY_SCENARIOS) {
      expect(scenario.fixture_projects).toBeGreaterThanOrEqual(1);
      expect(scenario.backend_tests.length).toBeGreaterThanOrEqual(2);
      expect(scenario.frontend_tests.length).toBeGreaterThanOrEqual(1);
      expect(scenario.api_paths.length).toBeGreaterThanOrEqual(3);
      expect(scenario.frontend_route).toStartWith("#/");
      for (const path of [...scenario.backend_tests, ...scenario.frontend_tests]) {
        expect(existsSync(resolve(REPO_ROOT, path))).toBe(true);
      }
    }
  });

  test("keeps cleanup, artifacts, fail-fast reporting, and ephemeral browser/API smoke in the canonical runner", () => {
    const path = resolve(REPO_ROOT, "scripts/run-golden-journeys.ts");
    const source = readFileSync(path, "utf8");
    expect(source).toContain('join(REPO_ROOT, ".runner", "artifacts", "golden-journeys")');
    expect(source).toContain('stage(stages, "cleanup"');
    expect(source).toContain('"failure-report.json"');
    expect(source).toContain("Stopped at the earliest uncertain stage");
    expect(source).toContain("Bun.serve({ hostname: \"127.0.0.1\", port: 0");
    expect(source).toContain('html.includes(\'id="root"\')');
    expect(source).toContain("source_of_truth");
  });
});
