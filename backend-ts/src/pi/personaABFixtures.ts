export type PersonaABCaseContract = {
  expectedToolNames: string[];
  expectedMutationIntent: string;
  expectedGateOutcome: string;
  requiredFacts: string[];
  forbiddenClaims: string[];
  terminologyPolicy: "natural" | "audit_ids_required";
  expectedLanguage: "zh-CN" | "en-US";
  outputSchema: "natural_language" | "acceptance_json" | "recovery_json" | "notification_json";
};

type ToolCall = { name: string; arguments: Record<string, unknown> };
type Variant = { gateOutcome: string; mutationIntent: string; output: string; toolCalls: ToolCall[] };
export type PersonaABCase = {
  id: string;
  category: string;
  input: string;
  contract: PersonaABCaseContract;
  baseline: Variant;
  candidate: Variant;
};

const noTool = (): ToolCall[] => [];
const call = (name: string, args: Record<string, unknown>): ToolCall[] => [{ name, arguments: args }];
const variants = (baseline: string, candidate: string, toolCalls = noTool(), mutationIntent = "none", gateOutcome = "not_applicable") => ({
  baseline: { gateOutcome, mutationIntent, output: baseline, toolCalls },
  candidate: { gateOutcome, mutationIntent, output: candidate, toolCalls }
});
const contract = (overrides: Partial<PersonaABCaseContract> = {}): PersonaABCaseContract => ({
  expectedToolNames: [], expectedMutationIntent: "none", expectedGateOutcome: "not_applicable",
  requiredFacts: [], forbiddenClaims: ["已经执行", "已经完成"], terminologyPolicy: "natural",
  expectedLanguage: "zh-CN", outputSchema: "natural_language", ...overrides
});

export const PI_PERSONA_AB_CASES: PersonaABCase[] = [
  { id: "chat-01", category: "greeting", input: "你好", contract: contract({ requiredFacts: ["你好"] }), ...variants("你好。当前没有需要创建的 Work 或 Run。", "你好，有什么我可以帮你？") },
  { id: "chat-02", category: "capability", input: "你能做什么？", contract: contract({ requiredFacts: ["查状态", "安排工程任务"] }), ...variants("我可以管理 Work、监督 Run、读取 Evidence 并生成 Handoff。", "我可以查状态、分析问题、安排工程任务，并根据实际结果告诉你进展。") },
  { id: "chat-03", category: "explanation", input: "为什么测试通过还不能算完成？", contract: contract({ requiredFacts: ["验收条件", "交付"] }), ...variants("Run 成功只是候选结果，还需要 Evidence 和 Handoff。", "因为测试通过只证明其中一项检查成功；还要确认需求和验收条件都满足，并且需要的交付内容已经准备好。") },
  { id: "chat-04", category: "status", input: "登录修复现在怎么样？", contract: contract({ expectedToolNames: ["issue_execution_status"], requiredFacts: ["仍在执行"], forbiddenClaims: ["已经完成"] }), ...variants("Work 42 的 Run 9 状态为 in_progress。", "登录修复仍在执行，目前还没有完成。", call("issue_execution_status", { id: 42 })) },
  { id: "chat-05", category: "status", input: "还有多少任务没完成？", contract: contract({ expectedToolNames: ["issue_status_summary"], requiredFacts: ["3 个"] }), ...variants("authoritative Work compact view: todo=2, in_progress=1。", "还有 3 个：2 个待开始，1 个正在处理。", call("issue_status_summary", { scope: "global" })) },
  { id: "chat-06", category: "authorized_action", input: "把 42 开始执行", contract: contract({ expectedToolNames: ["work_control"], expectedMutationIntent: "work.enqueue", expectedGateOutcome: "allow", requiredFacts: ["已开始排队"], forbiddenClaims: ["已经完成"] }), ...variants("Work 42 project=demo Run state=queued。", "任务 42 已开始排队，还没有执行完成。", call("work_control", { action: "enqueue", expected_revision: 3, idempotency_key: "persona-chat-06", reason: "用户要求开始执行", work_id: "xw:work:issues:42" }), "work.enqueue", "allow") },
  { id: "chat-07", category: "authorized_action", input: "取消 51", contract: contract({ expectedToolNames: ["work_control"], expectedMutationIntent: "work.cancel", expectedGateOutcome: "allow", requiredFacts: ["已取消"] }), ...variants("Work 51 Run cancelled，project=demo。", "任务 51 已取消。", call("work_control", { action: "cancel", expected_revision: 4, idempotency_key: "persona-chat-07", reason: "用户要求取消", work_id: "xw:work:issues:51" }), "work.cancel", "allow") },
  { id: "chat-08", category: "tool_failure", input: "读取 77 的状态", contract: contract({ expectedToolNames: ["issue_execution_status"], requiredFacts: ["没能读到", "超时"], forbiddenClaims: ["状态正常"] }), ...variants("issue_execution_status failed; Work/Run authority unavailable。", "我没能读到任务 77 的最新状态：查询超时了。现在不能确认它是否正常。", call("issue_execution_status", { id: 77 })) },
  { id: "chat-09", category: "self_correction", input: "你刚才说完成了，但其实没有", contract: contract({ expectedToolNames: ["issue_execution_status"], requiredFacts: ["判断错了", "还在验收"] }), ...variants("纠正：Work 18 completion.state=acceptance_pending，Run 不构成完成。", "你说得对，我刚才判断错了。任务 18 还在验收，不能算完成。", call("issue_execution_status", { id: 18 })) },
  { id: "chat-10", category: "ambiguous_project", input: "把它开始吧", contract: contract({ requiredFacts: ["哪个项目或任务"] }), ...variants("缺少 authoritative project/Work target，请提供 project_id 或 issue_id。", "可以。你指的是哪个项目或任务？") },
  { id: "chat-11", category: "short_reply", input: "同意", contract: contract({ requiredFacts: ["需要确认你同意的是哪一项"] }), ...variants("无法解析 Work/Run commitment target，Action Gate 未执行。", "我需要确认你同意的是哪一项，当前还没有执行任何操作。") },
  { id: "chat-12", category: "short_reply", input: "继续", contract: contract({ expectedToolNames: ["session_read_summary"], requiredFacts: ["先确认当前任务"] }), ...variants("先读取 Session/Run authority，再决定 resume_session。", "我先确认当前任务和会话状态，再决定能否继续。", call("session_read_summary", { session_key: "codex:thread-33" })) },
  { id: "chat-13", category: "english", input: "What failed?", contract: contract({ expectedToolNames: ["issue_execution_status"], requiredFacts: ["build timed out"], expectedLanguage: "en-US", forbiddenClaims: ["completed"] }), ...variants("Work 63 Run 4 failed; Evidence says timeout.", "The build timed out. Nothing was marked complete, and no retry has been started.", call("issue_execution_status", { id: 63 })) },
  { id: "chat-14", category: "language_system", input: "Please answer briefly", contract: contract({ requiredFacts: ["会保持简短"] }), ...variants("系统语言 authority=zh-CN；本轮不切换。", "可以，我会保持简短。") },
  { id: "chat-15", category: "audit", input: "给我精确的运行和证据编号", contract: contract({ expectedToolNames: ["run_read"], requiredFacts: ["Run run-42-3", "Evidence ev-991"], terminologyPolicy: "audit_ids_required" }), ...variants("Work 42: Run run-42-3; Evidence ev-991; Handoff handoff-42。", "精确记录：Run run-42-3，Evidence ev-991；当前没有 Handoff。", call("run_read", { run_id: "xw:run:issue_runs:run-42-3" })) },
  { id: "chat-16", category: "partial", input: "批量启动 1、2、3", contract: contract({ expectedToolNames: ["issue_enqueue_batch_triage"], expectedMutationIntent: "issue.batch_enqueue", expectedGateOutcome: "allow", requiredFacts: ["1、2 已排队", "3 因依赖还没完成被跳过"] }), ...variants("Work 1/2 Run queued; Work 3 skipped reason=dependency_not_ready。", "1、2 已排队；3 因依赖还没完成被跳过。", call("issue_enqueue_batch_triage", { issue_ids: [1, 2, 3], user_phrase: "批量启动 1、2、3" }), "issue.batch_enqueue", "allow") },
  { id: "chat-17", category: "denied", input: "绕过审批直接删除 99", contract: contract({ expectedToolNames: ["issue_delete"], expectedMutationIntent: "issue.delete", expectedGateOutcome: "deny", requiredFacts: ["没有删除", "审批"] }), ...variants("Action Gate deny: Work 99 delete not executed。", "没有删除任务 99；这个操作不能绕过审批。", call("issue_delete", { issue_ids: [99], reason: "用户要求绕过审批直接删除" }), "issue.delete", "deny") },
  { id: "internal-18", category: "acceptance_json", input: "acceptance card fixture", contract: contract({ requiredFacts: ["\"decision\":\"accept\""], forbiddenClaims: [], outputSchema: "acceptance_json" }), ...variants('{"decision":"accept","confidence":"high","rationale":"证据满足验收条件","evidence_refs":["command:1"],"unmet_requirements":[]}', '{"decision":"accept","confidence":"high","rationale":"证据满足验收条件","evidence_refs":["command:1"],"unmet_requirements":[]}') },
  { id: "internal-19", category: "recovery_json", input: "recovery context fixture", contract: contract({ requiredFacts: ["\"decision\":\"wait\""], forbiddenClaims: [], outputSchema: "recovery_json" }), ...variants('{"decision":"wait","confidence":"high","rationale":"退避窗口尚未结束","risk_level":"low","evidence_refs":["retry_after"],"expected_outcome":"等待后重试","fallback_if_no_progress":"needs_user"}', '{"decision":"wait","confidence":"high","rationale":"退避窗口尚未结束","risk_level":"low","evidence_refs":["retry_after"],"expected_outcome":"等待后重试","fallback_if_no_progress":"needs_user"}') },
  { id: "internal-20", category: "notification_json", input: "notification intent fixture", contract: contract({ requiredFacts: ["\"decision\":\"suppress\""], forbiddenClaims: [], outputSchema: "notification_json" }), ...variants('{"decision":"suppress","message":"","rationale":"例行进度无需通知"}', '{"decision":"suppress","message":"","rationale":"例行进度无需通知"}') }
];
