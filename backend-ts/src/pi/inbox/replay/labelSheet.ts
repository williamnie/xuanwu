import type { SourceEventLine } from "../sourceEvent.ts";
import type { ReplaySegment } from "./segments.ts";

/**
 * Human labelling sheet for the replay gold set (ADR-XW-0098 TD-1 §10.2).
 * Rendered as Markdown the user edits in any editor; parsed back strictly.
 */
export const TRIAGE_CONCLUSIONS = ["ignore", "remember", "reply_draft", "todo", "reminder", "triage_issue"] as const;
export type TriageConclusion = typeof TRIAGE_CONCLUSIONS[number];

export type SegmentLabel = {
  segment_id: string;
  conclusion: TriageConclusion;
  /** Expected project name; empty when not project-related. */
  project: string;
  /** Optional free text, e.g. an ignore reason: self_handled / chitchat / notice / unrelated. */
  note: string;
  event_ids: string[];
};

export type ParsedSheet = {
  labels: SegmentLabel[];
  unlabeled: string[];
  errors: Array<{ segment_id: string; message: string }>;
};

const ALIASES: Record<string, TriageConclusion> = {
  ignore: "ignore", "忽略": "ignore", i: "ignore",
  remember: "remember", "记住": "remember", m: "remember",
  reply_draft: "reply_draft", reply: "reply_draft", "回复": "reply_draft", r: "reply_draft",
  todo: "todo", "待办": "todo", t: "todo",
  reminder: "reminder", "提醒": "reminder", n: "reminder",
  triage_issue: "triage_issue", issue: "triage_issue", s: "triage_issue"
};

const MARKER = /^<!-- segment: ([a-f0-9]+-\d+) -->$/;

export function renderLabelSheet(
  segments: ReplaySegment[],
  options: { timeZone?: string; existing?: Map<string, SegmentLabel> } = {}
): string {
  const timeZone = options.timeZone ?? "Asia/Shanghai";
  const header = [
    "# 分拣标注",
    "",
    "每段填一个**结论**（这段别人发来的消息，你希望玄武怎么处理）。",
    "",
    "| 结论 | 可以写 | 含义 |",
    "| --- | --- | --- |",
    "| ignore | 忽略 / i | 不用管（闲聊、通知、和你无关、你已经亲自处理了） |",
    "| remember | 记住 / m | 只需要记下一件事（谁负责什么、约好的时间） |",
    "| reply_draft | 回复 / r | 需要回复对方，玄武应该起草 |",
    "| todo | 待办 / t | 你自己要去做的事 |",
    "| reminder | 提醒 / n | 到某个时间提醒你 |",
    "| triage_issue | issue / s | 要交给玄武做的工程活 |",
    "",
    "**项目**：只有 issue（或与某项目明显相关）时填项目名，其余留空。**备注**：可选，比如忽略的原因（self_handled / chitchat / notice）。",
    "标「我」的是你本人发的，只作上下文，不用标注。",
    ""
  ];
  const blocks = segments.map((segment, index) => {
    const label = options.existing?.get(segment.id);
    return [
      "---",
      "",
      `## S${String(index + 1).padStart(3, "0")} · ${segment.chat_label || segment.chat_key} · ${localTime(segment.started_at, timeZone)}`,
      `<!-- segment: ${segment.id} -->`,
      "",
      ...(segment.context_before.length > 0
        ? ["上文：", "", ...segment.context_before.map((event) => `> ${line(event, timeZone)}`), ""]
        : []),
      "本段：",
      "",
      ...segment.messages.map((event) => `- ${line(event, timeZone)}`),
      "",
      `结论：${label?.conclusion ?? ""}`,
      `项目：${label?.project ?? ""}`,
      `备注：${label?.note ?? ""}`,
      ""
    ].join("\n");
  });
  return [...header, ...blocks].join("\n");
}

export function parseLabelSheet(markdown: string, segments: ReplaySegment[]): ParsedSheet {
  const byID = new Map(segments.map((segment) => [segment.id, segment]));
  const labels: SegmentLabel[] = [];
  const errors: ParsedSheet["errors"] = [];
  let current: { id: string; conclusion: string; project: string; note: string } | null = null;
  const flush = () => {
    if (!current) return;
    const segment = byID.get(current.id);
    const raw = current.conclusion.trim();
    if (!segment) errors.push({ segment_id: current.id, message: "segment not found in events" });
    else if (raw !== "") {
      const conclusion = ALIASES[raw.toLowerCase()];
      if (!conclusion) errors.push({ segment_id: current.id, message: `unknown conclusion: ${raw}` });
      else labels.push({
        conclusion,
        event_ids: segment.event_ids,
        note: current.note.trim(),
        project: current.project.trim(),
        segment_id: current.id
      });
    }
    current = null;
  };
  for (const rawLine of markdown.split("\n")) {
    const lineText = rawLine.trim();
    const marker = MARKER.exec(lineText);
    if (marker) {
      flush();
      current = { conclusion: "", id: marker[1]!, note: "", project: "" };
      continue;
    }
    if (!current) continue;
    const field = /^(结论|项目|备注)[：:](.*)$/.exec(lineText);
    if (!field) continue;
    if (field[1] === "结论") current.conclusion = field[2]!;
    else if (field[1] === "项目") current.project = field[2]!;
    else current.note = field[2]!;
  }
  flush();
  const labeled = new Set(labels.map((label) => label.segment_id));
  const unlabeled = segments.map((segment) => segment.id).filter((id) => !labeled.has(id) && !errors.some((e) => e.segment_id === id));
  return { errors, labels, unlabeled };
}

function line(event: SourceEventLine, timeZone: string): string {
  const who = event.is_self ? "我" : event.sender.name;
  const body = event.text.replace(/\s*\n\s*/g, " ⏎ ");
  return `[${clock(event.occurred_at, timeZone)}] ${who}：${body}`;
}

function clock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", hour12: false, minute: "2-digit", timeZone }).format(new Date(iso));
}

function localTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit", hour: "2-digit", hour12: false, minute: "2-digit", month: "2-digit", timeZone
  }).format(new Date(iso));
}
