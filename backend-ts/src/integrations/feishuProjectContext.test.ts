import { describe, expect, test } from "bun:test";
import { afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { setFeishuConversationActiveProject } from "../db/repositories/feishuConversationState.ts";
import {
  resolveFeishuProjectContext,
  resolveFeishuProjectContextFromDatabase
} from "./feishuProjectContext.ts";

const PROJECTS = [
  { id: "xuanwu", name: "Xuanwu" },
  { id: "demo", name: "Demo Project" }
];
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Feishu PI project context resolver", () => {
  test("resolves a project from an explicit issue reference", () => {
    const result = resolveFeishuProjectContext({
      issues: [{ id: 386, project_id: "xuanwu" }],
      projects: PROJECTS,
      text: "开始 #386"
    });

    expect(result).toMatchObject({
      confidence: "high",
      projectId: "xuanwu",
      reason: "issue_ref_project",
      source: "issue_ref",
      status: "resolved"
    });
  });

  test("resolves a bare issue id when Chinese wording clearly marks it as an issue reference", () => {
    const result = resolveFeishuProjectContext({
      issues: [{ id: 762, project_id: "xuanwu" }],
      projects: PROJECTS,
      text: "那就是762中的修复没修复好，内存仍然超了"
    });

    expect(result).toMatchObject({
      projectId: "xuanwu",
      reason: "issue_ref_project",
      source: "issue_ref",
      status: "resolved"
    });
  });

  test("resolves a project from explicit project id or name text before mapping fallback", () => {
    const result = resolveFeishuProjectContext({
      mappings: [{ chatId: "oc_group", projectId: "demo" }],
      message: { chatId: "oc_group" },
      projects: PROJECTS,
      text: "切到 xuanwu"
    });

    expect(result).toMatchObject({
      confidence: "high",
      projectId: "xuanwu",
      reason: "explicit_project_text",
      source: "explicit_project",
      status: "resolved"
    });
  });

  test("does not resolve generic issue wording as the xuanwu project", () => {
    const result = resolveFeishuProjectContext({
      projects: PROJECTS,
      text: "开始所有issue"
    });

    expect(result).toMatchObject({
      confidence: "none",
      projectId: "",
      reason: "no_project_context",
      source: "none",
      status: "missing"
    });
  });

  test("does not treat conversation active project as IM project context", () => {
    const result = resolveFeishuProjectContext({
      activeProject: {
        active_project_id: "xuanwu",
        active_project_source: "user_switch"
      },
      projects: PROJECTS,
      text: "开始做吧"
    });

    expect(result).toMatchObject({
      confidence: "none",
      projectId: "",
      reason: "no_project_context",
      source: "none",
      status: "missing"
    });
  });

  test("returns missing without active project, issue, project, or mapping clues", () => {
    const result = resolveFeishuProjectContext({
      projects: PROJECTS,
      text: "开始做吧"
    });

    expect(result).toMatchObject({
      confidence: "none",
      projectId: "",
      reason: "no_project_context",
      source: "none",
      status: "missing"
    });
  });

  test("uses a current-source Feishu channel mapping as a one-shot project target", () => {
    const result = resolveFeishuProjectContext({
      mappings: [{ chatId: "oc_group", projectId: "demo" }],
      message: { chatId: "oc_group" },
      projects: PROJECTS,
      text: "开始做吧"
    });

    expect(result).toMatchObject({
      confidence: "medium",
      projectId: "demo",
      reason: "source_mapping_project",
      source: "mapping_default",
      status: "resolved"
    });
  });

  test("keeps source mappings scoped to the current chat or sender and reports conflicts", () => {
    const missing = resolveFeishuProjectContext({
      mappings: [{ chatId: "oc_group", projectId: "demo" }],
      message: { chatId: "oc_other", senderOpenId: "ou_other" },
      projects: PROJECTS,
      text: "开始做吧"
    });
    const ambiguous = resolveFeishuProjectContext({
      mappings: [
        { chatId: "oc_group", projectId: "demo" },
        { projectId: "xuanwu", userId: "ou_user" }
      ],
      message: { chatId: "oc_group", senderOpenId: "ou_user" },
      projects: PROJECTS,
      text: "开始做吧"
    });

    expect(missing.status).toBe("missing");
    expect(ambiguous).toMatchObject({
      candidates: ["demo", "xuanwu"],
      projectId: "",
      reason: "ambiguous_source_mapping",
      source: "mapping_default",
      status: "ambiguous"
    });
  });

  test("returns ambiguous when project text matches multiple projects", () => {
    const result = resolveFeishuProjectContext({
      projects: [
        { id: "runner-api", name: "Runner" },
        { id: "runner-web", name: "Runner" }
      ],
      text: "切到 Runner"
    });

    expect(result).toMatchObject({
      confidence: "low",
      projectId: "",
      reason: "ambiguous_explicit_project",
      source: "explicit_project",
      status: "ambiguous"
    });
    expect(result.candidates).toEqual(["runner-api", "runner-web"]);
  });

  test("loads issues, projects, active state, and fallback mapping from database inputs", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "xuanwu", "Xuanwu");
      insertProject(db, "demo", "Demo Project");
      insertIssue(db, 386, "xuanwu");
      setFeishuConversationActiveProject(db, {
        activeConversationId: "feishu-chat-oc_group-20260613",
        activeProjectId: "demo",
        scopeKey: "feishu-chat-oc_group-20260613",
        source: "user_switch"
      }, new Date("2026-06-13T03:00:00Z"));

      expect(resolveFeishuProjectContextFromDatabase(db, {
        mappings: [{ chatId: "oc_group", projectId: "demo" }],
        message: { chatId: "oc_group" },
        scopeKey: "feishu-chat-oc_group-20260613",
        text: "开始 #386"
      })).toMatchObject({
        projectId: "xuanwu",
        reason: "issue_ref_project",
        source: "issue_ref",
        status: "resolved"
      });
      expect(resolveFeishuProjectContextFromDatabase(db, {
        mappings: [{ chatId: "oc_group", projectId: "demo" }],
        message: { chatId: "oc_group" },
        scopeKey: "feishu-chat-oc_group-20260613",
        text: "开始做吧"
      })).toMatchObject({
        projectId: "demo",
        reason: "source_mapping_project",
        source: "mapping_default",
        status: "resolved"
      });
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-feishu-project-context-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase, id: string, name: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [id, name, `/tmp/${id}`, "2026-06-13T00:00:00Z", "2026-06-13T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, id: number, projectID: string): void {
  db.sqlite.run(
    `insert into issues (id, project_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)`,
    [id, projectID, `Issue ${id}`, "todo", "2026-06-13T00:00:00Z", "2026-06-13T00:00:00Z"]
  );
}
