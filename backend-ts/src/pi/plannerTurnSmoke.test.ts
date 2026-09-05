import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listIssues } from "../db/repositories/issues.ts";
import { listPiActions, type PiAction } from "../db/repositories/pi.ts";
import { EventBus, type AppEvent } from "../events/bus.ts";
import { finalPiConversationSseData } from "../http/piConversationSse.testSupport.ts";
import { createDefaultRouter } from "../http/server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const FAUX_PROVIDER = "pi-planner-faux";
const FAUX_API = "pi-planner-faux-api";
const TARGET_FILE = "src/components/AccordionPanel.tsx";
const PRD_FILE = "PRD-demo.md";
const tempRoots: string[] = [];

type Fixture = { db: RunnerDatabase; projectCwd: string; router: ReturnType<typeof createDefaultRouter>; bus: EventBus };

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI read-only planner turn smoke", () => {
  test("reads repo context and creates a triage issue without writes, commands, or enqueue", async () => {
    const fixture = await openFixture();
    const faux = registerFauxProvider({ api: FAUX_API, provider: FAUX_PROVIDER });
    const events = fixture.bus.subscribe();
    try {
      faux.setResponses(plannerResponses());
      insertProject(fixture.db, "demo", fixture.projectCwd);
      insertFauxAgent(fixture.db);
      writeFauxModelsConfig(fixture.db);

      const created = await post(fixture.router, "/api/pi/conversations", {
        id: "conv-planner-smoke",
        project_id: "demo",
        pi_agent_id: "pi-faux"
      });
      const message = await post(fixture.router, "/api/pi/conversations/conv-planner-smoke/messages", {
        prompt: "在 demo 项目中帮我实现折叠面板功能"
      });
      const body = await finalPiConversationSseData(message);

      expect(created.status).toBe(201);
      expect(message.status).toBe(201);
      expect(body).toMatchObject({
        conversation_id: "conv-planner-smoke",
        status: "completed",
        text: "已创建折叠面板规划 issue，等待是否现在开始。"
      });
      assertPlannerPhases(fixture.db);
      assertNoForbiddenPlannerToolCalls(await drainEvents(events), fixture.db);
      assertTriageIssueWithContextPack(fixture.db);
      expect(readFileSync(join(fixture.projectCwd, TARGET_FILE), "utf8")).toBe(componentSource());
      expect(existsSync(join(fixture.projectCwd, "blocked.txt"))).toBe(false);
    } finally {
      events.close();
      faux.unregister();
      fixture.db.close();
    }
  });

  test("reads the named PRD before creating a detailed non-enqueued issue DAG", async () => {
    const fixture = await openFixture();
    const faux = registerFauxProvider({ api: FAUX_API, provider: FAUX_PROVIDER });
    const events = fixture.bus.subscribe();
    try {
      faux.setResponses(prdPlannerResponses());
      insertProject(fixture.db, "demo", fixture.projectCwd);
      insertFauxAgent(fixture.db);
      writeFauxModelsConfig(fixture.db);

      await post(fixture.router, "/api/pi/conversations", {
        id: "conv-prd-planner-smoke",
        project_id: "demo",
        pi_agent_id: "pi-faux"
      });
      const message = await post(fixture.router, "/api/pi/conversations/conv-prd-planner-smoke/messages", {
        prompt: "按照 PRD-demo.md 拆分成可执行 Issue，建立好但不要开始，我要先 review。"
      });
      const body = await finalPiConversationSseData(message);
      const issues = listIssues(fixture.db, { projectId: "demo" });
      const actions = listPiActions(fixture.db);

      expect(body).toMatchObject({ status: "completed", text: "已按 PRD 创建 4 个 triage Issue 和依赖 DAG，未 enqueue。" });
      expect(actions.filter((action) => action.action_type === "repo.read_excerpt")).toHaveLength(2);
      expect(actions.find((action) => action.action_type === "issue.create")).toMatchObject({ status: "completed" });
      expect(issues).toHaveLength(4);
      expect(issues.every((issue) => issue.status === "triage")).toBe(true);
      expect(issues.every((issue) => issue.description.includes("## 相关证据") &&
        !issue.description.includes("## 相关证据\n- (none)") &&
        !issue.description.includes("## 做什么\n- (none)"))).toBe(true);
      expect(fixture.db.sqlite.query<{ total: number }, []>(
        "select count(*) as total from work_relations where kind='depends_on'"
      ).get()?.total).toBe(4);
      assertNoForbiddenPlannerToolCalls(await drainEvents(events), fixture.db);
    } finally {
      events.close();
      faux.unregister();
      fixture.db.close();
    }
  });
});

async function openFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-pi-planner-smoke-"));
  tempRoots.push(root);
  const projectCwd = join(root, "project");
  writeFixtureProject(projectCwd);
  const db = await openDatabase({ stateDir: join(root, "state") });
  const bus = new EventBus();
  return { db, projectCwd, bus, router: createDefaultRouter({ bus, database: db }) };
}

function writeFixtureProject(projectCwd: string): void {
  mkdirSync(join(projectCwd, "src", "components"), { recursive: true });
  mkdirSync(join(projectCwd, "src", "pages"), { recursive: true });
  writeFileSync(join(projectCwd, TARGET_FILE), componentSource());
  writeFileSync(join(projectCwd, "src", "pages", "HomePage.tsx"), [
    "import { AccordionPanel } from '../components/AccordionPanel';",
    "export function HomePage() { return <AccordionPanel title=\"FAQ\">Help text</AccordionPanel>; }",
    ""
  ].join("\n"));
  writeFileSync(join(projectCwd, "README.md"), "# Demo\nTarget page uses AccordionPanel.\n");
  writeFileSync(join(projectCwd, PRD_FILE), [
    "# Demo PRD",
    "## MVP",
    "固定领域合同、实现任务 API、接入真实 Provider、完成端到端验收。",
    "## 非目标",
    "本阶段不做计费和团队系统。",
    "## 验收",
    "所有任务必须独立测试并保留真实 Provider smoke。",
    ""
  ].join("\n"));
}

function componentSource(): string {
  return [
    "export function AccordionPanel(props: { title: string; children: React.ReactNode }) {",
    "  return <section><h2>{props.title}</h2><div>{props.children}</div></section>;",
    "}",
    ""
  ].join("\n");
}

function plannerResponses() {
  return [
    fauxAssistantMessage([
      fauxToolCall("project_status", { project_id: "demo" }, { id: "project-map" }),
      fauxToolCall("repo_tree", { path: "src", max_depth: 2 }, { id: "repo-tree" }),
      fauxToolCall("repo_search", { query: "AccordionPanel", path: "src", max_results: 5 }, { id: "repo-search" }),
      fauxToolCall("repo_read_excerpt", { path: TARGET_FILE, start_line: 1, max_lines: 20 }, { id: "repo-read" }),
      fauxToolCall("issue_create_proposal", issueProposalPayload(), { id: "issue-proposal" })
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage("已创建折叠面板规划 issue，等待是否现在开始。")
  ];
}

function prdPlannerResponses() {
  return [
    fauxAssistantMessage([
      fauxToolCall("project_status", { project_id: "demo" }, { id: "project-map" }),
      fauxToolCall("repo_tree", { path: ".", max_depth: 1 }, { id: "repo-tree" }),
      fauxToolCall("repo_read_excerpt", { path: PRD_FILE, start_line: 1, max_lines: 5 }, { id: "prd-read-1" }),
      fauxToolCall("repo_read_excerpt", { path: PRD_FILE, start_line: 6, max_lines: 20 }, { id: "prd-read-2" })
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage([
      fauxToolCall("issue_create_batch_proposal", {
        project_id: "demo",
        rationale: "按 PRD 建立可 review 的 MVP DAG，不启动执行",
        items: [
          prdBatchItem("contract", "固定领域与 API 合同"),
          { ...prdBatchItem("api", "实现异步任务 API"), depends_on_refs: ["contract"] },
          { ...prdBatchItem("provider", "接入真实图片 Provider"), depends_on_refs: ["contract"] },
          { ...prdBatchItem("journey", "完成真实端到端验收"), depends_on_refs: ["api", "provider"] }
        ]
      }, { id: "prd-batch" })
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage("已按 PRD 创建 4 个 triage Issue 和依赖 DAG，未 enqueue。")
  ];
}

function prdBatchItem(ref: string, title: string) {
  return {
    acceptance_criteria: [`${title} 有独立通过标准。`],
    description: `${title}，只覆盖一个主要工程结果。`,
    evidence: [{ source_kind: "doc", path: PRD_FILE, summary: `PRD 要求 ${title}` }],
    proposed_changes: [`实施 ${title}。`],
    ref,
    title,
    validation: [`运行 ${ref} focused test 并保存 Evidence。`]
  };
}

function issueProposalPayload() {
  return {
    title: "实现折叠面板功能",
    description: "用户向 PI 说：帮我实现折叠面板功能",
    project_id: "demo",
    context_pack: {
      intent: "实现现有 AccordionPanel 的折叠/展开交互",
      project: { id: "demo" },
      source: { kind: "im", channel: "fixture", message_id: "msg-planner-smoke" },
      evidence: [{
        source_kind: "code",
        path: TARGET_FILE,
        summary: "AccordionPanel 当前只渲染标题和内容，没有折叠状态。",
        excerpt: "return <section><h2>{props.title}</h2><div>{props.children}</div></section>;"
      }],
      relevant_files: [{ path: TARGET_FILE, reason: "目标组件", symbols: ["AccordionPanel"] }],
      proposed_changes: ["为 AccordionPanel 增加受控或本地折叠状态和按钮 affordance。"],
      acceptance_criteria: ["用户可以展开和收起面板。", "折叠状态有可访问的 aria-expanded 表达。"],
      validation: ["bun test src/components/AccordionPanel.test.tsx"],
      open_questions: ["默认展开还是默认收起？"]
    }
  };
}

function assertPlannerPhases(db: RunnerDatabase): void {
  const actions = listPiActions(db);
  requireCompletedAction(actions, "project.status", "project mapping");
  requireCompletedAction(actions, "repo.tree", "repo search");
  requireCompletedAction(actions, "repo.search", "repo search");
  requireCompletedAction(actions, "repo.read_excerpt", "repo search");
  requireCompletedAction(actions, "issue.create", "proposal");
}

function requireCompletedAction(actions: PiAction[], actionType: string, phase: string): void {
  const action = actions.find((item) => item.action_type === actionType);
  if (!action) throw new Error(`planner smoke failed at ${phase}: missing ${actionType}; ${diagnoseActions(actions)}`);
  if (action.gate_decision !== "execute") {
    throw new Error(`planner smoke failed at action gate for ${actionType}: ${diagnoseActions(actions)}`);
  }
  if (action.status !== "completed") {
    throw new Error(`planner smoke failed at ${phase}: ${actionType} status=${action.status}; ${diagnoseActions(actions)}`);
  }
}

function diagnoseActions(actions: PiAction[]): string {
  return JSON.stringify(actions.map((action) => ({
    action_type: action.action_type,
    gate_decision: action.gate_decision,
    gate_reason: action.gate_reason,
    status: action.status
  })));
}

async function drainEvents(events: ReturnType<EventBus["subscribe"]>): Promise<AppEvent[]> {
  const items: AppEvent[] = [];
  for (let index = 0; index < 80; index += 1) {
    const event = await Promise.race([events.next(), Bun.sleep(10).then(() => undefined)]);
    if (!event) break;
    items.push(event);
  }
  return items;
}

function assertNoForbiddenPlannerToolCalls(events: AppEvent[], db: RunnerDatabase): void {
  const toolNames = toolNamesFromEvents(events);
  const forbidden = toolNames.filter((name) => ["bash", "edit", "write", "issue_enqueue_proposal"].includes(name));
  if (forbidden.length > 0) {
    throw new Error(`planner smoke failed at action gate: forbidden tool calls ${forbidden.join(", ")}; ${diagnoseActions(listPiActions(db))}`);
  }
  expect(listPiActions(db).map((action) => action.action_type)).not.toContain("issue.enqueue");
  expect(listPiActions(db).map((action) => action.action_type)).not.toContain("issue.schedule_enqueue");
}

function toolNamesFromEvents(events: AppEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.agent_event_type !== "tool_execution_start" && event.agent_event_type !== "tool_execution_end") return [];
    const payload = parsePayload(event.payload);
    return typeof payload.tool_name === "string" ? [payload.tool_name] : [];
  });
}

function parsePayload(value: string | undefined): Record<string, unknown> {
  try {
    return JSON.parse(value || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function assertTriageIssueWithContextPack(db: RunnerDatabase): void {
  const issues = listIssues(db, { projectId: "demo" });
  expect(issues).toHaveLength(1);
  const issue = issues[0];
  expect(issue).toMatchObject({ status: "triage", title: "实现折叠面板功能" });
  expect(issue.description).toContain("## 一句话目标");
  expect(issue.description).toContain("## 相关证据");
  expect(issue.description).toContain("## 验收标准");
  expect(issue.description).toContain("## 自动验证");
  expect(issue.description).toContain(TARGET_FILE);
  expect(issue.description).toContain("用户可以展开和收起面板");
  expect(issue.description).toContain("bun test src/components/AccordionPanel.test.tsx");
}

function post(router: ReturnType<typeof createDefaultRouter>, path: string, body: Record<string, unknown>) {
  return router.handle(new Request(`${BASE_URL}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" }
  }));
}

function insertProject(db: RunnerDatabase, id: string, cwd: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, provider_config_json, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, id, cwd, "codex", '{"capabilities":["issue_execution"]}', 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertFauxAgent(db: RunnerDatabase): void {
  db.sqlite.run(
    `update pi_agents set name=?, model_provider=?, model_id=?, thinking_level=?, enabled=1, updated_at=?
     where id='runner-default'`,
    ["PI Faux", FAUX_PROVIDER, "faux-1", "off", "2026-01-01T00:00:00Z"]
  );
}

function writeFauxModelsConfig(db: RunnerDatabase): void {
  const agentDir = join(db.path, "..", "pi-runtime", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      [FAUX_PROVIDER]: {
        api: FAUX_API,
        apiKey: "test",
        baseUrl: "http://localhost:0",
        models: [{ id: "faux-1" }]
      }
    }
  }));
}
