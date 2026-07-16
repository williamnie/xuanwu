import { describe, expect, test } from "bun:test";
import type { RunnerDatabase } from "../database.ts";
import { listRuns } from "./runs.ts";

describe("Run list repository", () => {
  test("scopes lifecycle lookups to the indexed issue before inspecting event JSON", () => {
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
    expect(queries[0]?.match(/event\.issue_id=run\.issue_id/g)).toHaveLength(3);
  });
});
