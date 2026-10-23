/**
 * W1 compatibility exports. Project resolution is provider-neutral; existing
 * Feishu imports keep their names for one release while new channels depend on
 * imProjectContext directly.
 */
export {
  resolveImProjectContext as resolveFeishuProjectContext,
  resolveImProjectContextFromDatabase as resolveFeishuProjectContextFromDatabase
} from "./imProjectContext.ts";
export type { ImProjectContextResult as FeishuProjectContextResult } from "./imProjectContext.ts";
