import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../database.ts";
import { listRuns } from "./runs.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Run list repository", () => {
  test("uses bounded attempt and lifecycle rollups instead of per-Run correlated scans", async () => {
    const queries: string[] = [];
    const db = {
      sqlite: {
        query(sql: string) {
          queries.push(sql);
          return { all: () => [] };
        }
      }
    } as unknown as RunnerDatabase;

    expect(listRuns(db, { limit: 50, offset: 0 })).toEqual([]);
    expect(queries).toHaveLength(1);
    const sql = queries[0] ?? "";
    expect(sql).toContain("candidate_runs as materialized");
    expect(sql).toContain("attempt_stats as materialized");
    expect(sql).toContain("selected_runs as materialized");
    expect(sql).toContain("lifecycle_rollup as materialized");
    expect(sql.match(/event\.issue_id=run\.issue_id/g)).toHaveLength(1);
    expect(sql).not.toMatch(/select count\(\*\) from run_attempts child/);
    expect(sql).not.toMatch(/latest\.sequence=\(select max/);

    const root = await mkdtemp(join(tmpdir(), "codex-runner-runs-plan-"));
    tempRoots.push(root);
    const fixture = await openDatabase({ stateDir: join(root, "state") });
    try {
      const plan = fixture.sqlite.query<{ detail: string }, [number, number]>(
        `explain query plan ${sql}`
      ).all(50, 0).map((row) => row.detail);
      expect(plan).toContain("MATERIALIZE selected_runs");
      expect(plan).toContain("MATERIALIZE attempt_stats");
      expect(plan.some((detail) => detail.includes("SEARCH event USING INDEX idx_issue_events_issue_type"))).toBe(true);
      expect(plan.some((detail) => detail.includes("CORRELATED SCALAR SUBQUERY"))).toBe(false);
    } finally {
      fixture.close();
    }
  });
});
