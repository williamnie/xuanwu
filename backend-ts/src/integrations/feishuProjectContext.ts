/**
 * W1 compatibility exports. Project resolution is provider-neutral; existing
 * Feishu imports keep their names for one release while new channels depend on
 * imProjectContext directly.
 */
export {
  resolveImProjectContext as resolveFeishuProjectContext,
  resolveImProjectContextFromDatabase as resolveFeishuProjectContextFromDatabase
} from "./imProjectContext.ts";
export type {
  ImProjectContextActiveProject as FeishuProjectContextActiveProject,
  ImProjectContextConfidence as FeishuProjectContextConfidence,
  ImProjectContextDatabaseInput as FeishuProjectContextDatabaseInput,
  ImProjectContextInput as FeishuProjectContextInput,
  ImProjectContextIssue as FeishuProjectContextIssue,
  ImProjectContextMessage as FeishuProjectContextMessage,
  ImProjectContextProject as FeishuProjectContextProject,
  ImProjectContextResult as FeishuProjectContextResult,
  ImProjectContextSource as FeishuProjectContextSource,
  ImProjectContextStatus as FeishuProjectContextStatus
} from "./imProjectContext.ts";
