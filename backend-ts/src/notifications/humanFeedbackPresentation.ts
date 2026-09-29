import type { HumanFeedback } from "../domain/review/humanFeedback.ts";
import { redactSensitiveText } from "../util/redact.ts";

export function humanFeedbackNotificationText(feedback: HumanFeedback | null): string {
  if (!feedback) return "";
  const labels = { received: "已收到，等待 PI 处理", executing: "执行中", completed: "完成（不代表已上线）", needs_input: "需补充", failed: "处理失败，等待 PI 处理", cancelled: "已取消" };
  return [
    `反馈：${labels[feedback.status]} · 请求 ${feedback.review_request_id} · 版本 ${feedback.review_revision}`,
    feedback.question ? `原问题：${feedback.question}` : "",
    feedback.run ? `续跑：第 ${feedback.run.attempt} 次 · ${feedback.run.id}` : "尚未记录反馈后的新 Run。",
    feedback.next_question ? `待补充：${feedback.next_question}` : "",
    "可继续在当前 IM 对话反馈；页面可核对证据与处理进度。"
  ].filter(Boolean).map(line => redactSensitiveText(line).slice(0, 600)).join("\n");
}
