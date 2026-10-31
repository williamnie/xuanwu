import type { ProviderRunInput, ProviderRunResult } from "../types.ts";
import { ProviderInterruptedError } from "../types.ts";
import { projectQoderMessage, qoderFailureEvent, qoderInterruptedEvent } from "./events.ts";
import { QoderExecutionError, type QoderRunOptions, type QoderSdkFacade } from "./sdkFacade.ts";
import { QoderPermissionBroker } from "./permissionBroker.ts";
import { cleanString } from "../../util/values.ts";
import { type QoderExecutorProviderOptions, type ActiveInvocation, qoderRunResult } from "./providerModel.ts";

export const SYSTEM_PROMPT = "You are executing a Xuanwu-managed Issue. Follow the Issue prompt and report only verified outcomes.";

export type QoderInvocationHost = {
  options: QoderExecutorProviderOptions;
  facade: QoderSdkFacade;
  permissionBroker: QoderPermissionBroker;
  track(active: ActiveInvocation, alias: string): void;
  untrack(active: ActiveInvocation): void;
};

export async function executeQoderInvocation(
  host: QoderInvocationHost,
    input: ProviderRunInput,
    sessionOptions: Pick<QoderRunOptions, "resume" | "sessionId">,
    resumeAlias = ""
  ): Promise<ProviderRunResult> {
    const invocationRef = cleanString(host.options.invocationIdFactory?.()) || `qoder-inv-${crypto.randomUUID()}`;
    const active: ActiveInvocation = {
      aliases: new Set(),
      interrupted: false,
      invocationRef,
      messageRef: "",
      sessionObserved: false,
      sessionRef: cleanString(resumeAlias) || cleanString(sessionOptions.sessionId),
      terminalProjected: false
    };
    host.track(active, invocationRef);
    if (active.sessionRef) host.track(active, active.sessionRef);
    const options: QoderRunOptions = {
      ...sessionOptions,
      approvalPolicy: input.approvalPolicy,
      canUseTool: host.permissionBroker.callback({
        approvalPolicy: input.approvalPolicy,
        cwd: input.cwd,
        invocationRef,
        onEvent: input.onEvent,
        policy: input.policy,
        sandbox: input.sandbox,
        session: () => active.sessionRef
          ? { provider: "qoder", sessionId: active.sessionRef, ...(active.messageRef ? { turnId: active.messageRef } : {}) }
          : undefined
      }),
      cwd: input.cwd,
      invocationKey: invocationRef,
      model: input.model,
      policy: input.policy,
      reasoningEffort: input.reasoningEffort,
      sandbox: input.sandbox,
      systemPrompt: SYSTEM_PROMPT
    };
    try {
      const outcome = await host.facade.run(input.prompt, options, (message, context) => {
        const event = projectQoderMessage(message, {
          interrupted: context.interrupted || active.interrupted,
          invocationRef,
          resume: cleanString(sessionOptions.resume) !== "",
          usage: context.usage
        });
        const sessionRef = cleanString(event.session?.sessionId);
        if (sessionRef) {
          active.sessionObserved = true;
          if (active.sessionRef && active.sessionRef !== sessionRef) {
            throw new Error(`Qoder invocation ${invocationRef} returned mismatched session ${sessionRef}`);
          }
          active.sessionRef = sessionRef;
          host.track(active, sessionRef);
        }
        const messageRef = cleanString(event.session?.turnId);
        if (messageRef) {
          active.messageRef = messageRef;
          host.track(active, messageRef);
        }
        if (event.runEvent?.terminal) active.terminalProjected = true;
        input.onEvent?.(event);
      });
      if (outcome.terminal === "interrupted" || outcome.terminal === "cancelled") {
        if (!active.terminalProjected) {
          input.onEvent?.(qoderInterruptedEvent(invocationRef, outcome.sessionId || active.sessionRef, outcome.messageRef));
        }
        throw new ProviderInterruptedError("Qoder query interrupted");
      }
      return qoderRunResult(outcome);
    } catch (error) {
      if (error instanceof ProviderInterruptedError) throw error;
      if (error instanceof QoderExecutionError && error.details.code === "interrupted") {
        input.onEvent?.(qoderInterruptedEvent(invocationRef, active.sessionRef, active.messageRef));
        throw new ProviderInterruptedError(error.message);
      }
      if (error instanceof QoderExecutionError) {
        // result error 已由 message adapter 投影；SDK/process/no-result failure 需在此补 terminal。
        if (!active.terminalProjected) {
          input.onEvent?.(qoderFailureEvent({
            ...error.details,
            sessionId: active.sessionObserved ? error.details.sessionId : ""
          }, invocationRef));
        }
        throw error;
      }
      const wrapped = new QoderExecutionError({
        category: "sdk",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
        sessionId: active.sessionObserved ? active.sessionRef : ""
      });
      input.onEvent?.(qoderFailureEvent(wrapped.details, invocationRef));
      throw wrapped;
    } finally {
      host.untrack(active);
    }
  }
