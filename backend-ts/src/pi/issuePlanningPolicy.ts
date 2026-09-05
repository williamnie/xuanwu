import policy from "../../../skills/xuanwu/references/issue-planning.md" with { type: "text" };

// 构建时嵌入同一份规范，发布后的二进制不依赖开发机或全局 skill 路径。
export const ISSUE_PLANNING_POLICY = policy.trim();
