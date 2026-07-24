export type PiAttentionDecisionValue =
  "ignore" | "inbox_only" | "propose_issue" | "ask_clarification" | "blocked_by_policy";

export type PiAttentionEvidence = {
  kind: "mention" | "policy";
  reason: string;
  value: string;
};

export type PiAttentionDecision = {
  decision: PiAttentionDecisionValue;
  evidence: PiAttentionEvidence[];
  needs_project: boolean;
  project_id: string;
  project_source: "none";
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

const BOT_MENTION_PATTERN = /(?:^|@|\s)(?:pi|bot|机器人)(?:\b|\s|$)/i;

/**
 * This boundary decides only whether an authenticated channel message may reach PI.
 * It deliberately does not classify task intent, infer a project, or select an action.
 */
export function decidePiAttention(input: PiAttentionInput): PiAttentionDecision {
  const message = normalizeMessage(input.message);
  const evidence: PiAttentionEvidence[] = [];
  const signals: string[] = [];
  if (botMentioned(message)) {
    signals.push("bot_mentioned");
    evidence.push({ kind: "mention", reason: "bot_mentioned", value: mentionValue(message) });
  }
  if (includesClean(input.policy?.allowedChatIds, message.chat_id)) {
    signals.push("allowed_chat");
    evidence.push({ kind: "policy", reason: "allowed_chat", value: message.chat_id });
  }
  if (matchesAllowedUser(input.policy?.allowedUserIds, message)) {
    signals.push("allowed_user");
    evidence.push({
      kind: "policy",
      reason: "allowed_user",
      value: message.sender_id || message.sender_open_id
    });
  }
  const trusted = signals.length > 0;
  return {
    decision: trusted ? "inbox_only" : "ignore",
    evidence: trusted
      ? evidence
      : [{ kind: "policy", reason: "no_trusted_attention", value: "message_ignored" }],
    needs_project: false,
    project_id: "",
    project_source: "none",
    reason: trusted ? "trusted_message_forwarded_to_pi" : "no_trusted_attention",
    should_create_issue_proposal: false,
    signals: [...new Set(signals)]
  };
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

function matchesAllowedUser(allowed: string[] | undefined, message: Required<PiAttentionMessage>): boolean {
  return includesClean(allowed, message.sender_id) || includesClean(allowed, message.sender_open_id);
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

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
