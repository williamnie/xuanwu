import { getPiConversation, updatePiConversation } from "../../db/repositories/pi.ts";
import { cleanString } from "../../util/values.ts";
import { isContextOverflow, resolveImContextRollover } from "./piConversationRollover.ts";
import type { PiConversationContext, PiConversationPromptInput } from "./piConversationApi.model.ts";
import { createConversationWithRuntime, optionalConversationProject } from "./piConversationApi.createConversationWithRuntime.ts";
import { resetConversationProjectRuntime, sendPiConversationMessage } from "./piConversationApi.piConversationTurnStreamResponse.ts";

export async function runPiConversationPrompt(
  context: PiConversationContext,
  input: PiConversationPromptInput
) {
  const createChild = (body: Record<string, unknown>) => createConversationWithRuntime(context, body);
  let effective = await resolveImContextRollover(context, input, createChild);
  try {
    return await dispatchPiConversationPrompt(context, effective);
  } catch (error) {
    if (!effective.channelContextProjection || !isContextOverflow(error)) throw error;
    effective = await resolveImContextRollover(context, effective, createChild, "provider_context_overflow");
    return await dispatchPiConversationPrompt(context, effective);
  }
}

export async function dispatchPiConversationPrompt(
  context: PiConversationContext,
  input: PiConversationPromptInput
) {
  const id = cleanString(input.conversationId) || crypto.randomUUID();
  const projectID = cleanString(input.projectId);
  const existing = getPiConversation(context.database, id);
  if (!existing) {
    await createConversationWithRuntime(context, {
      id,
      project_id: projectID,
      title: cleanString(input.title) || "Feishu"
    });
  } else if (input.clearProjectId && projectID === "" && existing.project_id !== "") {
    await resetConversationProjectRuntime(context, existing);
  } else if (projectID !== "" && existing.project_id !== projectID) {
    optionalConversationProject(context.database, projectID);
    updatePiConversation(context.database, existing.id, { project_id: projectID });
  }
  return sendPiConversationMessage(context, id, {
    intent: input.intent,
    language: input.language,
    prompt: input.prompt,
    target_project_id: input.targetProjectId || projectID,
    target_project_source: input.targetProjectSource || (projectID === "" ? undefined : "request_project")
  }, {
    channelContext: input.channelContext,
    channelContextProjection: input.channelContextProjection,
    continuationContext: input.continuationContext,
    targetIssueId: input.targetIssueId
  });
}
