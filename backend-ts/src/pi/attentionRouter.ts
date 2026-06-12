export type PiAttentionDecisionValue =
  "ignore" | "inbox_only" | "propose_issue" | "ask_clarification" | "blocked_by_policy";

export type PiAttentionEvidence = {
  kind: "keyword" | "mention" | "policy" | "project";
  reason: string;
  value: string;
};

export type PiAttentionDecision = {
  decision: PiAttentionDecisionValue;
  evidence: PiAttentionEvidence[];
  needs_project: boolean;
  project_id: string;
  project_source: "chat_mapping" | "explicit_project" | "none" | "user_mapping";
  reason: string;
  should_create_issue_proposal: boolean;
  signals: string[];
};

export type PiAttentionMessage = {
  attachments?: unknown[];
  chat_id?: string;
  mentions?: Array<{ id?: string; name?: string }>;
  message_id?: string;
  sender_id?: string;
  sender_open_id?: string;
  text?: string;
};

export type PiAttentionProject = { id: string; name?: string };
export type PiAttentionProjectMapping = { chatId?: string; projectId: string; userId?: string };
export type PiAttentionPolicy = {
  allowedChatIds?: string[];
  allowedUserIds?: string[];
  projectMappings?: PiAttentionProjectMapping[];
};
export type PiAttentionInput = {
  message: PiAttentionMessage;
  policy?: PiAttentionPolicy;
  projects?: PiAttentionProject[];
};

type SignalMatch = { evidence: PiAttentionEvidence[]; signals: string[] };
type ProjectMatch = { evidence?: PiAttentionEvidence; projectId: string; source: PiAttentionDecision["project_source"] };

const REQUEST_KEYWORDS = [
  { signal: "request_keyword", value: "帮我" },
  { signal: "fix_keyword", value: "修复" },
  { signal: "fix_keyword", value: "fix" },
  { signal: "feature_keyword", value: "实现" },
  { signal: "feature_keyword", value: "implement" },
  { signal: "bug_keyword", value: "报错" },
  { signal: "bug_keyword", value: "error" },
  { signal: "bug_keyword", value: "bug" },
  { signal: "screenshot_keyword", value: "截图" },
  { signal: "screenshot_keyword", value: "screenshot" },
  { signal: "log_keyword", value: "日志" },
  { signal: "log_keyword", value: "log" }
] as const;
const BOT_MENTION_PATTERN = /(?:^|@|\s)(?:pi|bot|机器人)(?:\b|\s|$)/i;

export function decidePiAttention(input: PiAttentionInput): PiAttentionDecision {
  const message = normalizeMessage(input.message);
  const attention = attentionSignals(message, input.policy);
  const task = taskSignals(message);
  const project = resolveProject(message, input.policy, input.projects ?? []);
  const evidence = [...attention.evidence, ...task.evidence, ...(project.evidence ? [project.evidence] : [])];
  const signals = unique([...attention.signals, ...task.signals]);
  return decisionFor({ attention, evidence, project, signals, task });
}

function decisionFor(input: {
  attention: SignalMatch;
  evidence: PiAttentionEvidence[];
  project: ProjectMatch;
  signals: string[];
  task: SignalMatch;
}): PiAttentionDecision {
  if (input.task.signals.length > 0 && input.attention.signals.length === 0) {
    return result("blocked_by_policy", "task_signal_without_trusted_attention", input, false);
  }
  if (input.task.signals.length === 0 && input.attention.signals.length === 0) {
    return result("ignore", "no_attention_signal", {
      ...input,
      evidence: [{ kind: "policy", reason: "no_attention_signal", value: "message_ignored" }],
      signals: []
    }, false);
  }
  if (input.task.signals.length === 0) {
    return result("inbox_only", "trusted_source_without_task_signal", input, false);
  }
  if (input.project.projectId === "") {
    return result("ask_clarification", "needs_project", input, true);
  }
  return result("propose_issue", "task_signal_with_project", input, false);
}

function result(
  decision: PiAttentionDecisionValue,
  reason: string,
  input: { evidence: PiAttentionEvidence[]; project: ProjectMatch; signals: string[] },
  needsProject: boolean
): PiAttentionDecision {
  return {
    decision,
    evidence: input.evidence,
    needs_project: needsProject,
    project_id: input.project.projectId,
    project_source: input.project.source,
    reason,
    should_create_issue_proposal: decision === "propose_issue",
    signals: input.signals
  };
}

function attentionSignals(message: Required<PiAttentionMessage>, policy: PiAttentionPolicy = {}): SignalMatch {
  const matches: SignalMatch = { evidence: [], signals: [] };
  if (botMentioned(message)) {
    addSignal(matches, "bot_mentioned", "mention", "bot_mentioned", mentionValue(message));
  }
  if (includesClean(policy.allowedChatIds, message.chat_id)) {
    addSignal(matches, "allowed_chat", "policy", "allowed_chat", message.chat_id);
  }
  if (matchesAllowedUser(policy.allowedUserIds, message)) {
    addSignal(matches, "allowed_user", "policy", "allowed_user", message.sender_id || message.sender_open_id);
  }
  return matches;
}

function taskSignals(message: Required<PiAttentionMessage>): SignalMatch {
  const matches: SignalMatch = { evidence: [], signals: [] };
  const text = lower(message.text);
  for (const keyword of REQUEST_KEYWORDS) {
    if (text.includes(lower(keyword.value))) {
      addSignal(matches, keyword.signal, "keyword", keyword.signal, keyword.value);
    }
  }
  if (message.attachments.length > 0) {
    addSignal(matches, "attachment_signal", "keyword", "attachment_metadata", String(message.attachments.length));
  }
  return matches;
}

function resolveProject(
  message: Required<PiAttentionMessage>,
  policy: PiAttentionPolicy = {},
  projects: PiAttentionProject[]
): ProjectMatch {
  const chat = policy.projectMappings?.find((item) => clean(item.chatId) === message.chat_id);
  if (chat) return projectMatch(chat.projectId, "chat_mapping");
  const user = policy.projectMappings?.find((item) => userMatches(item.userId, message));
  if (user) return projectMatch(user.projectId, "user_mapping");
  const explicit = projects.find((project) => projectMentioned(message.text, project));
  return explicit ? projectMatch(explicit.id, "explicit_project") : { projectId: "", source: "none" };
}

function projectMatch(projectId: string, source: ProjectMatch["source"]): ProjectMatch {
  const id = clean(projectId);
  return { evidence: { kind: "project", reason: source, value: id }, projectId: id, source };
}

function normalizeMessage(message: PiAttentionMessage): Required<PiAttentionMessage> {
  return {
    attachments: Array.isArray(message.attachments) ? message.attachments : [],
    chat_id: clean(message.chat_id),
    mentions: Array.isArray(message.mentions) ? message.mentions : [],
    message_id: clean(message.message_id),
    sender_id: clean(message.sender_id),
    sender_open_id: clean(message.sender_open_id),
    text: clean(message.text)
  };
}

function addSignal(
  matches: SignalMatch,
  signal: string,
  kind: PiAttentionEvidence["kind"],
  reason: string,
  value: string
): void {
  if (!matches.signals.includes(signal)) matches.signals.push(signal);
  matches.evidence.push({ kind, reason, value });
}

function matchesAllowedUser(allowed: string[] | undefined, message: Required<PiAttentionMessage>): boolean {
  return includesClean(allowed, message.sender_id) || includesClean(allowed, message.sender_open_id);
}

function userMatches(userId: string | undefined, message: Required<PiAttentionMessage>): boolean {
  const id = clean(userId);
  return id !== "" && (id === message.sender_id || id === message.sender_open_id);
}

function projectMentioned(text: string, project: PiAttentionProject): boolean {
  const body = lower(text);
  return [project.id, project.name].map(lower).filter(Boolean).some((value) => body.includes(value));
}

function mentionValue(message: Required<PiAttentionMessage>): string {
  return message.mentions.map((item) => clean(item.name) || clean(item.id)).filter(Boolean).join(",") || "@PI";
}

function botMentioned(message: Required<PiAttentionMessage>): boolean {
  if (BOT_MENTION_PATTERN.test(message.text)) return true;
  return message.mentions.some((item) => BOT_MENTION_PATTERN.test(clean(item.name) || clean(item.id)));
}

function includesClean(values: string[] | undefined, value: string): boolean {
  const needle = clean(value);
  return needle !== "" && Array.isArray(values) && values.map(clean).includes(needle);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function lower(value: unknown): string {
  return clean(value).toLowerCase();
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
