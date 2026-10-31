import { createImConversationCoordinator } from "../im/imConversationCoordinator.ts";
import { type ImConversationRoute } from "../im/imConversationRouting.ts";
import { type ImProjectContextResult } from "../im/imProjectContext.ts";
import type { Options, BridgeInput, RunResult } from "./telegramAgentBridge.model.ts";
import { acknowledge, linked, REPLY_TYPE, prepare, sendSelection, sendReply } from "./telegramAgentBridge.sendSelection.ts";
import { runConversation, sendStandaloneText, resolveProjectSelection } from "./telegramAgentBridge.runConversation.ts";

export function createTelegramAgentBridge(options: Options) {
  const coordinator = createImConversationCoordinator<BridgeInput, {
    projectContext: ImProjectContextResult;
    route: ImConversationRoute;
  }, RunResult>({
    acknowledge: (input) => acknowledge(options, input),
    alreadyHandled: (input) => linked(options.database, input, REPLY_TYPE, "agent_reply"),
    dedupeKey: (input) => input.normalized.envelope.audit.idempotency_key,
    policy: (input) => input.normalized.attention.decision === "ignore" ? "ignored_by_attention" : "",
    prepare: (input) => prepare(options, input),
    reply: (input, run) => run.kind === "selection"
      ? sendSelection(options, input, run)
      : sendReply(options, input, run.text, run),
    run: (input, prepared) => runConversation(options, input, prepared.route, prepared.projectContext),
    text: (run) => run.text
  });
  return {
    handle: (input: BridgeInput) => coordinator.handle(input),
    presentInteractionResult: (input: { callbackId: string; chatId: string; text: string; threadId: string }) =>
      sendStandaloneText(options, input.chatId, input.text, `${input.callbackId}:result`, input.threadId),
    resolveProjectSelection: (input: {
      callbackId: string; chatId: string; messageId: string; projectId: string; selectionId: string; threadId: string; userId: string;
    }) => resolveProjectSelection(options, input)
  };
}
