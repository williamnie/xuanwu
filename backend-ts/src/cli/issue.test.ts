import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./command.ts";

const tempRoots: string[] = [];

beforeEach(() => {
  tempRoots.length = 0;
});

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun issue CLI", () => {
  test("creates issue and enqueues it when --run is set", async () => {
    const bodyFile = await tempIssueFile("修复 Bun CLI\n\n保持最小改动。");
    const requests: string[] = [];
    const fetcher = fetchStub(async (request) => {
      expect(request.headers.get("x-codex-client")).toBe("codex-issue-runner-cli");
      requests.push(`${request.method} ${new URL(request.url).pathname}`);
      if (new URL(request.url).pathname === "/api/issues") {
        expect(request.method).toBe("POST");
        expect(await request.json()).toMatchObject({
          description: "修复 Bun CLI\n\n保持最小改动。",
          priority: 2,
          project_id: "demo",
          source_session_id: "thread-env",
          status: "triage",
          title: "创建 CLI"
        });
        return jsonResponse(issueBody({ id: 42, status: "triage", title: "创建 CLI" }), 201);
      }
      expect(request.method).toBe("POST");
      expect(request.url).toBe("http://127.0.0.1:3008/api/issues/42/enqueue");
      return jsonResponse(issueBody({ id: 42, status: "todo", title: "创建 CLI" }));
    });
    const { code, stdout, stderr } = await run([
      "issue", "create", "--project", "demo", "--title", "创建 CLI", "--body-file", bodyFile,
      "--priority", "2", "--run", "--json"
    ], { env: envMap({ CODEX_THREAD_ID: "thread-env" }), fetcher });

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(requests).toEqual(["POST /api/issues", "POST /api/issues/42/enqueue"]);
    expect(JSON.parse(stdout)).toMatchObject({ id: 42, status: "todo" });
  });

  test("updates issue final status and clears non-failed error", async () => {
    const fetcher = fetchStub(async (request) => {
      expect(request.method).toBe("PATCH");
      expect(request.url).toBe("http://127.0.0.1:3008/api/issues/7");
      expect(await request.json()).toEqual({ status: "done", error: "" });
      return jsonResponse(issueBody({ id: 7, status: "done", title: "完成任务" }));
    });
    const { code, stdout, stderr } = await run([
      "issue", "update", "--id", "7", "--status", "done", "--json"
    ], { fetcher });

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ id: 7, status: "done" });
    expect(stderr).toBe("");
  });

  test("keeps failed error, reads logs, and posts verification review", async () => {
    const fetcher = fetchStub(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/issues/7") {
        expect(await request.json()).toEqual({ status: "failed", error: "npm test failed" });
        return jsonResponse(issueBody({ id: 7, status: "failed", title: "失败任务", error: "npm test failed" }));
      }
      if (path === "/api/issues/7/events") {
        return jsonResponse([{ id: 1, issue_id: 7, type: "issue.comment", payload: '{"body":"token=hidden"}', created_at: "2026-01-01T00:00:00Z" }]);
      }
      if (path === "/api/issues/8/verification") {
        expect(await request.json()).toEqual({
          action: "request_changes",
          comment: "补 smoke",
          review_request_id: "review-8",
          review_revision: 2
        });
        return jsonResponse(issueBody({ id: 8, status: "in_progress", title: "待验证" }));
      }
      if (path === "/api/issues/8" && request.method === "GET") {
        return jsonResponse({
          ...issueBody({ id: 8, status: "pending_verification", title: "待验证" }),
          verification: {
            owner: "human",
            request: { id: "review-8", revision: 2, status: "open" }
          }
        });
      }
      throw new Error(`unexpected request: ${request.method} ${path}`);
    });

    const failed = await run(["issue", "update", "--id", "7", "--status", "failed", "--error", "npm test failed"], { fetcher });
    const logs = await run(["issue", "logs", "--id", "7"], { fetcher });
    const review = await run(["issue", "request-changes", "--id", "8", "--comment", "补 smoke", "--json"], { fetcher });

    expect(failed.code).toBe(0);
    expect(failed.stdout).toBe("#7 [failed] demo - 失败任务\n");
    expect(logs.code).toBe(0);
    expect(logs.stdout).toContain("token=[redacted]");
    expect(logs.stdout).not.toContain("hidden");
    expect(review.code).toBe(0);
    expect(JSON.parse(review.stdout)).toMatchObject({ id: 8, status: "in_progress" });
  });

  test("supports issue status retry and cancel actions", async () => {
    const fetcher = fetchStub((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/issues/9") return jsonResponse(issueBody({ id: 9, status: "todo", title: "查状态" }));
      if (path === "/api/issues/9/retry") return jsonResponse(issueBody({ id: 9, status: "todo", title: "查状态" }));
      if (path === "/api/issues/9/cancel") return jsonResponse(issueBody({ id: 9, status: "cancelled", title: "查状态" }));
      throw new Error(`unexpected request: ${request.method} ${path}`);
    });

    const status = await run(["issue", "status", "--id", "9"], { fetcher });
    const retry = await run(["issue", "retry", "--id", "9", "--json"], { fetcher });
    const cancel = await run(["issue", "cancel", "--id", "9", "--json"], { fetcher });

    expect(status.stdout).toBe("#9 [todo] demo - 查状态\n");
    expect(JSON.parse(retry.stdout)).toMatchObject({ status: "todo" });
    expect(JSON.parse(cancel.stdout)).toMatchObject({ status: "cancelled" });
  });

  test("deletes issue with DELETE request and returns deletion summary", async () => {
    const fetcher = fetchStub((request) => {
      expect(request.method).toBe("DELETE");
      expect(request.url).toBe("http://127.0.0.1:3008/api/issues/9");
      return new Response(null, { status: 204 });
    });

    const deleted = await run(["issue", "delete", "--id", "9", "--json"], { fetcher });

    expect(deleted.code).toBe(0);
    expect(deleted.stderr).toBe("");
    expect(JSON.parse(deleted.stdout)).toEqual({ deleted: true, id: 9 });
  });

  test("rejects unknown issue subcommands without falling into serve mode", async () => {
    const { code, stderr } = await run(["issue", "missing"], { fetcher: fetchStub() });

    expect(code).toBe(1);
    expect(stderr).toContain("unknown issue command: missing");
  });
});

async function run(args: string[], options: {
  env?: (key: string) => string | undefined;
  fetcher?: typeof fetch;
} = {}): Promise<{ code: number; stderr: string; stdout: string }> {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const code = await runCli(args, stdout, stderr, { env: options.env ?? envMap({}), fetch: options.fetcher ?? fetchStub() });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

function fetchStub(handler: (request: Request) => Response | Promise<Response> = () => jsonResponse({ ok: true })): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    return await handler(request);
  }) as typeof fetch;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status
  });
}

function envMap(values: Record<string, string>): (key: string) => string | undefined {
  return (key) => values[key];
}

function issueBody(overrides: Partial<IssueBody> = {}): IssueBody {
  return {
    id: overrides.id ?? 1,
    project_id: overrides.project_id ?? "demo",
    status: overrides.status ?? "triage",
    title: overrides.title ?? "Issue",
    ...(overrides.error !== undefined ? { error: overrides.error } : {})
  };
}

type IssueBody = {
  error?: string;
  id: number;
  project_id: string;
  status: string;
  title: string;
};

async function tempIssueFile(content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-cli-issue-"));
  tempRoots.push(root);
  const path = join(root, "issue.md");
  await writeFile(path, content);
  return path;
}

class MemoryWriter {
  text = "";

  write(chunk: Uint8Array | string): boolean {
    this.text += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }
}
