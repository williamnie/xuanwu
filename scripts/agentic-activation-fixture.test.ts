import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFixture,
  inspectFixture,
  resetFixture,
  rollbackFixtureConfig,
  runScenario
} from "./agentic-activation-fixture.ts";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("agentic activation fixture", () => {
  test("creates, inspects, restores and resets three triage-only inputs", async () => {
    const fake = fakeClient();
    const state = temporaryDirectory();
    const first = await createFixture(fake.client, 1, state);

    expect(Object.keys(first.issue_ids).sort()).toEqual(["needs_user", "retryable_failure", "success"]);
    expect(first.issues.every((item) => item.status === "triage" && item.event_ids.length === 1)).toBeTrue();
    expect((await rollbackFixtureConfig(fake.client, first, false)).result).toBe("dry_run");
    expect((await rollbackFixtureConfig(fake.client, first, true)).result).toBe("restored");
    expect((await inspectFixture(fake.client, first)).issues.every((item) => item.status === "triage")).toBeTrue();

    expect(runScenario("success", state)).toMatchObject({ exit_code: 0, external_writes: 0 });
    expect(runScenario("retryable_failure", state)).toMatchObject({ attempt: 1, exit_code: 75, retryable: true });
    expect(runScenario("retryable_failure", state)).toMatchObject({ attempt: 2, exit_code: 0, retryable: false });
    expect(runScenario("needs_user", state)).toMatchObject({
      exit_code: 78,
      external_writes: 0,
      request: { requires_user: true }
    });
    expect(readFileSync(join(state, "retryable_failure.attempt"), "utf8")).toBe("2\n");

    const reset = await resetFixture(fake.client, first);
    expect(reset).toMatchObject({ residual_issue_count: 0, residual_run_count: 0 });
    expect(fake.issues.size).toBe(0);

    const second = await createFixture(fake.client, 2, state);
    expect(Object.values(second.issue_ids).every((id) => !Object.values(first.issue_ids).includes(id))).toBeTrue();
  });
});

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "agentic-activation-fixture-"));
  roots.push(path);
  return path;
}

function fakeClient() {
  let nextID = 100;
  const issues = new Map<number, Record<string, any>>();
  const client = {
    async request(path: string, init: RequestInit = {}) {
      const method = init.method ?? "GET";
      if (path === "/api/issues" && method === "POST") {
        const body = JSON.parse(String(init.body));
        const id = nextID++;
        const issue = { ...body, id };
        issues.set(id, issue);
        return { body: issue, status: 201 };
      }
      const match = path.match(/^\/api\/issues\/(\d+)(?:\/(events|runs))?$/);
      if (!match) return { body: { message: "not found" }, status: 404 };
      const id = Number(match[1]);
      const suffix = match[2] ?? "";
      const issue = issues.get(id);
      if (!issue) return { body: { message: "not found" }, status: 404 };
      if (suffix === "events") return { body: [{ id: id * 10, type: "issue.created" }], status: 200 };
      if (suffix === "runs") return { body: [], status: 200 };
      if (method === "DELETE") {
        issues.delete(id);
        return { body: null, status: 204 };
      }
      if (method === "PATCH") {
        Object.assign(issue, JSON.parse(String(init.body)));
        return { body: issue, status: 200 };
      }
      return { body: issue, status: 200 };
    }
  };
  return { client, issues };
}
