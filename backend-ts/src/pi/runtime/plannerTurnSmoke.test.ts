import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { type RunnerDatabase } from "../../db/database.ts";
import { listIssues } from "../../db/repositories/issues.ts";
import { listPiActions } from "../../db/repositories/pi.ts";
import { EventBus, type AppEvent } from "../../events/bus.ts";
import { finalPiConversationSseData } from "../../http/pi/piConversationSse.testSupport.ts";
import { createDefaultRouter } from "../../http/server.ts";
import { apiClient, insertProject, useTestDatabase } from "../../testing/harness.ts";
import { useFauxPi, type FauxPi } from "../../testing/fauxPi.ts";

const openFixtureDatabase = useTestDatabase("xuanwu-pi-planner-smoke-");
const fauxPi = useFauxPi("pi-planner");
const TARGET_FILE = "src/components/AccordionPanel.tsx";
const PRD_FILE = "PRD-demo.md";
const COMPONENT_SOURCE = [
  "export function AccordionPanel(props: { title: string; children: React.ReactNode }) {",
  "  return <section><h2>{props.title}</h2><div>{props.children}</div></section>;",
  "}",
  ""
].join("\n");
const PROJECT_FILES: Record<string, string> = {
  [TARGET_FILE]: COMPONENT_SOURCE,
  "src/pages/HomePage.tsx": [
    "import { AccordionPanel } from '../components/AccordionPanel';",
    "export function HomePage() { return <AccordionPanel title=\"FAQ\">Help text</AccordionPanel>; }",
    ""
  ].join("\n"),
  "README.md": "# Demo\nTarget page uses AccordionPanel.\n",
  [PRD_FILE]: [
    "# Demo PRD",
    "## MVP",
    "固定领域合同、实现任务 API、接入真实 Provider、完成端到端验收。",
    "## 非目标",
    "本阶段不做计费和团队系统。",
    "## 验收",
    "所有任务必须独立测试并保留真实 Provider smoke。",
    ""
  ].join("\n")
};

describe("PI read-only planner turn smoke", () => {
  test("reads repo context and creates a triage issue without writes, commands, or enqueue", async () => {
    const { db, faux, projectCwd, plan } = await openFixture();
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("project_status", { project_id: "demo" }, { id: "project-map" }),
        fauxToolCall("repo_tree", { path: "src", max_depth: 2 }, { id: "repo-tree" }),
        fauxToolCall("repo_search", { query: "AccordionPanel", path: "src", max_results: 5 }, { id: "repo-search" }),
        fauxToolCall("repo_read_excerpt", { path: TARGET_FILE, start_line: 1, max_lines: 20 }, { id: "repo-read" }),
        fauxToolCall("issue_create_proposal", ACCORDION_PROPOSAL, { id: "issue-proposal" })
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("已创建折叠面板规划 issue，等待是否现在开始。")
    ]);

    expect(await plan("conv-planner-smoke", "在 demo 项目中帮我实现折叠面板功能")).toMatchObject({
      conversation_id: "conv-planner-smoke",
      status: "completed",
      text: "已创建折叠面板规划 issue，等待是否现在开始。"
    });
    const actions = listPiActions(db);
    for (const action_type of ["project.status", "repo.tree", "repo.search", "repo.read_excerpt", "issue.create"]) {
      expect(actions).toContainEqual(expect.objectContaining({ action_type, gate_decision: "execute", status: "completed" }));
    }
    const issues = listIssues(db, { projectId: "demo" });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ status: "triage", title: "实现折叠面板功能" });
    for (const fragment of [
      "## 一句话目标", "## 相关证据", "## 验收标准", "## 自动验证", TARGET_FILE, "用户可以展开和收起面板",
      "bun test src/components/AccordionPanel.test.tsx"
    ]) expect(issues[0]?.description).toContain(fragment);
    expect(readFileSync(join(projectCwd, TARGET_FILE), "utf8")).toBe(COMPONENT_SOURCE);
    expect(existsSync(join(projectCwd, "blocked.txt"))).toBe(false);
  });

  test("reads the named PRD before creating a detailed non-enqueued issue DAG", async () => {
    const { db, faux, plan } = await openFixture();
    faux.setResponses([
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
    ]);

    const body = await plan("conv-prd-planner-smoke", "按照 PRD-demo.md 拆分成可执行 Issue，建立好但不要开始，我要先 review。");
    const issues = listIssues(db, { projectId: "demo" });
    const actions = listPiActions(db);

    expect(body).toMatchObject({ status: "completed", text: "已按 PRD 创建 4 个 triage Issue 和依赖 DAG，未 enqueue。" });
    expect(actions.filter((action) => action.action_type === "repo.read_excerpt")).toHaveLength(2);
    expect(actions.find((action) => action.action_type === "issue.create")).toMatchObject({ status: "completed" });
    expect(issues).toHaveLength(4);
    expect(issues.every((issue) => issue.status === "triage")).toBe(true);
    expect(issues.every((issue) => issue.description.includes("## 相关证据") &&
      !issue.description.includes("## 相关证据\n- (none)") &&
      !issue.description.includes("## 做什么\n- (none)"))).toBe(true);
    expect(db.sqlite.query<{ total: number }, []>(
      "select count(*) as total from work_relations where kind='depends_on'"
    ).get()?.total).toBe(4);
  });
});

/**
 * A demo project checked out on disk and a router whose PI runs on a faux model. `plan` sends one prompt and,
 * after the turn, asserts no write/command/enqueue tool ran.
 */
async function openFixture(): Promise<{
  db: RunnerDatabase;
  faux: FauxPi;
  projectCwd: string;
  plan: (conversationId: string, prompt: string) => Promise<Record<string, unknown>>;
}> {
  const db = await openFixtureDatabase();
  const projectCwd = join(db.path, "..", "..", "project");
  for (const [path, content] of Object.entries(PROJECT_FILES)) {
    mkdirSync(dirname(join(projectCwd, path)), { recursive: true });
    writeFileSync(join(projectCwd, path), content);
  }
  insertProject(db, "demo", { cwd: projectCwd, provider_config_json: '{"capabilities":["issue_execution"]}', sort_order: 1 });
  const faux = fauxPi(db);
  const bus = new EventBus();
  const api = apiClient(createDefaultRouter({ bus, database: db }));
  const plan = async (conversationId: string, prompt: string) => {
    const events = bus.subscribe();
    try {
      expect((await api.post("/api/pi/conversations", { id: conversationId, project_id: "demo", pi_agent_id: "pi-faux" })).status).toBe(201);
      const message = await api.raw(`/api/pi/conversations/${conversationId}/messages`, {
        body: JSON.stringify({ prompt }), headers: { "content-type": "application/json" }, method: "POST"
      });
      expect(message.status).toBe(201);
      const body = await finalPiConversationSseData(message);
      const toolNames = (await drainEvents(events)).flatMap(toolNameOf);
      expect(toolNames.filter((name) => ["bash", "edit", "write", "issue_enqueue_proposal"].includes(name))).toEqual([]);
      const actionTypes = listPiActions(db).map((action) => action.action_type);
      expect(actionTypes).not.toContain("issue.enqueue");
      expect(actionTypes).not.toContain("issue.schedule_enqueue");
      return body;
    } finally {
      events.close();
    }
  };
  return { db, faux, projectCwd, plan };
}

const ACCORDION_PROPOSAL = {
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

async function drainEvents(events: ReturnType<EventBus["subscribe"]>): Promise<AppEvent[]> {
  const items: AppEvent[] = [];
  for (let index = 0; index < 80; index += 1) {
    const event = await Promise.race([events.next(), Bun.sleep(10).then(() => undefined)]);
    if (!event) break;
    items.push(event);
  }
  return items;
}

function toolNameOf(event: AppEvent): string[] {
  if (event.agent_event_type !== "tool_execution_start" && event.agent_event_type !== "tool_execution_end") return [];
  try {
    const name = (JSON.parse(event.payload || "{}") as Record<string, unknown>).tool_name;
    return typeof name === "string" ? [name] : [];
  } catch {
    return [];
  }
}
