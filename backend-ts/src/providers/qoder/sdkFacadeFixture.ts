import type { ModelPolicyProvider, SDKMessage } from "@qoder-ai/qoder-agent-sdk";
import { qoderResultFailure } from "./events.ts";
import { cleanString } from "../../util/values.ts";
import { QoderTerminal, QoderSdkFacade, QoderRunOptions, QoderExecutionError } from "./sdkFacadeModel.ts";
import { qoderMessageTerminal } from "./sdkFacade.ts";
import { qoderError, qoderUsageProjection } from "./sdkFacadeUsage.ts";

export function createFakeQoderSdkFacade(
  messages: Array<SDKMessage | "throw">,
  options: { terminal?: QoderTerminal; sessionId?: string } = {}
): { facade: QoderSdkFacade; interrupted: { keys: string[] }; calls: QoderRunOptions[] } {
  const interrupted = { keys: [] as string[] };
  const calls: QoderRunOptions[] = [];
  const active = new Set<string>();
  const facade: QoderSdkFacade = {
    available: true,
    async run(_prompt, runOptions, onMessage) {
      calls.push({ ...runOptions });
      active.add(runOptions.invocationKey);
      let sessionId = options.sessionId ?? (cleanString(runOptions.resume) || cleanString(runOptions.sessionId) || "qoder-session-1");
      let result: Extract<SDKMessage, { type: "result" }> | undefined;
      let initSeen = false;
      let resultCount = 0;
      try {
        for (const message of messages) {
          if (message === "throw") throw new Error("sdk failure");
          if (cleanString(message.session_id)) sessionId = cleanString(message.session_id);
          if (message.type === "result") {
            resultCount += 1;
            result = message;
          } else {
            if (message.type === "system" && message.subtype === "init") initSeen = true;
            onMessage?.(message, { interrupted: interrupted.keys.includes(runOptions.invocationKey) });
          }
        }
        if (resultCount > 1) throw qoderError("protocol", `Qoder query produced ${resultCount} result messages`, { sessionId });
        if (result && !initSeen) throw qoderError("protocol", "Qoder query produced a result before system/init", { sessionId });
        const usage = result ? await qoderUsageProjection(result, [], undefined) : undefined;
        if (result) onMessage?.(result, { interrupted: interrupted.keys.includes(runOptions.invocationKey), usage });
        const terminal = interrupted.keys.includes(runOptions.invocationKey)
          ? "interrupted"
          : result ? qoderMessageTerminal(result) : options.terminal;
        if (!terminal) throw qoderError("protocol", "Qoder query ended without an authoritative result", { sessionId });
        if (terminal === "failed" && result) throw new QoderExecutionError(qoderResultFailure(result));
        return {
          invocationRef: runOptions.invocationKey,
          messageRef: result ? cleanString(result.uuid) : "",
          sessionId,
          terminal,
          usage
        };
      } finally {
        active.delete(runOptions.invocationKey);
      }
    },
    async interrupt(invocationKey) {
      if (!active.has(invocationKey)) throw new Error(`Qoder invocation ${invocationKey} is not active`);
      interrupted.keys.push(invocationKey);
    },
    activeCount: () => active.size,
    async listModels() { throw new Error("fake Qoder model discovery is not configured"); },
    processLeases: () => [],
    async close() { active.clear(); }
  };
  return { facade, interrupted, calls };
}

export function qoderModelPolicy(modelValue: string, effortValue: string | undefined): ModelPolicyProvider | undefined {
  const effort = cleanString(effortValue);
  if (!effort) return undefined;
  const model = cleanString(modelValue);
  if (!model) throw qoderError("policy_input", "Qoder reasoning effort requires an explicitly selected model");
  return ({ availableModels }) => {
    const selected = availableModels.find((item) => item.value === model || item.modelId === model || item.model === model);
    if (!selected) throw qoderError("policy_input", `Qoder model ${model} is not in the current account model list`);
    const efforts = Array.isArray(selected.efforts) ? selected.efforts.map(cleanString).filter(Boolean) : [];
    if (!efforts.includes(effort)) {
      throw qoderError("policy_input", `Qoder model ${model} does not support reasoning effort ${effort}`);
    }
    return { model, parameters: { reasoningEffort: effort } };
  };
}
