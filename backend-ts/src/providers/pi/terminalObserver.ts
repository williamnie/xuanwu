import { ProviderInterruptedError, type ProviderRunInput } from "../types.ts";
import { resolve } from "node:path";
import { PiRpcTransport, type PiRpcEvent } from "./rpcTransport.ts";
import { normalizedRunEvent } from "../runEvents.ts";
import { objectValue } from "../../util/values.ts";
import { stringValue } from "./providerSettings.ts";

export type PiToolObservation = {
  command: string;
  cwd: string;
  id: string;
  startedAt: number;
};

export function piToolObservation(event: PiRpcEvent, defaultCwd: string): PiToolObservation | undefined {
  const toolName = stringValue(event.toolName).toLowerCase();
  if (toolName !== "bash") return undefined;
  const args = objectValue(event.args);
  const command = stringValue(args.command) || stringValue(args.cmd);
  const id = stringValue(event.toolCallId);
  if (command === "" || id === "") return undefined;
  return {
    command,
    cwd: stringValue(args.cwd) || defaultCwd || ".",
    id,
    startedAt: Date.now()
  };
}

export function piToolOutput(value: unknown): string {
  const result = objectValue(value);
  if (!Array.isArray(result.content)) return stringValue(result.text);
  return result.content.map(objectValue).map((item) => stringValue(item.text)).filter(Boolean).join("\n");
}

export function piToolExitCode(value: unknown, failed: boolean, output: string): number {
  const result = objectValue(value);
  const details = objectValue(result.details);
  if (typeof details.exitCode === "number" && Number.isSafeInteger(details.exitCode)) return details.exitCode;
  const match = output.match(/Command exited with code (\d+)/);
  if (match) return Number(match[1]);
  return failed ? 1 : 0;
}

export type PiTerminalHost = {
  id: "pi-coding-agent";
  timeoutMs?: number;
  lastSessionRef(): string;
  interrupted(): boolean;
  sessionState(transport: PiRpcTransport): Promise<{ sessionRef: string } | undefined>;
  rejectPendingApprovals(reason: string): Promise<void>;
  handlePolicyApprovalRequest(event: PiRpcEvent, transport: PiRpcTransport, sink: ProviderRunInput["onEvent"], input: Pick<ProviderRunInput, "cwd" | "policy">, sessionRef: string, invocationRef: string): Promise<void>;
};

export function waitForPiTerminal(
  host: PiTerminalHost,
    transport: PiRpcTransport,
    sink: ProviderRunInput["onEvent"],
    input: Pick<ProviderRunInput, "cwd" | "projectId" | "issueId" | "prompt" | "policy">,
    initialSessionRef: string,
    invocationRef: string
  ): Promise<{ sessionRef: string }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let failureReason = "";
      let approvalBridgeFailure = "";
      const activeTools = new Map<string, PiToolObservation>();
      const inactivityMs = host.timeoutMs ?? 30 * 60 * 1000;
      let inactivityTimeout: ReturnType<typeof setTimeout> | undefined;
      const sessionForEvent = () => {
        const sessionRef = host.lastSessionRef() || initialSessionRef;
        return sessionRef ? { provider: host.id, sessionId: sessionRef } as const : undefined;
      };
      const armInactivityTimeout = () => {
        if (inactivityTimeout) clearTimeout(inactivityTimeout);
        inactivityTimeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          const error = new Error(`pi rpc agent had no activity for ${inactivityMs}ms`);
          const session = sessionForEvent();
          sink?.({
            error: error.message,
            provider: host.id,
            raw: { method: "pi-coding-agent/inactivity_timeout" },
            runEvent: normalizedRunEvent({
              kind: "error",
              method: "pi-coding-agent/inactivity_timeout",
              outcome: "failed",
              provider: host.id,
              retryable: true,
              session
            }),
            session,
            status: "failed",
            type: "provider.error"
          });
          reject(error);
        }, inactivityMs);
        inactivityTimeout.unref?.();
      };
      const cleanup = () => {
        if (inactivityTimeout) clearTimeout(inactivityTimeout);
        inactivityTimeout = undefined;
        off();
      };
      const rejectTerminal = (error: Error, method: string) => {
        if (!settled) {
          settled = true;
          cleanup();
          void host.rejectPendingApprovals(error.message);
          const session = sessionForEvent();
          sink?.({
            error: error.message,
            provider: host.id,
            raw: { method },
            runEvent: normalizedRunEvent({
              kind: "error",
              method,
              outcome: "failed",
              provider: host.id,
              session
            }),
            session,
            status: "failed",
            type: "provider.error"
          });
          reject(error);
        }
      };
      const off = transport.onEvent((event: PiRpcEvent) => {
        if (!settled) armInactivityTimeout();
        switch (event.type) {
          case "agent_settled":
            if (settled) break;
            if (host.interrupted()) {
              settled = true;
              cleanup();
              reject(new ProviderInterruptedError("pi rpc execution was interrupted by host"));
              break;
            }
            settled = true;
            cleanup();
            void host.sessionState(transport).then((state) => {
              const sessionRef = state?.sessionRef ?? host.lastSessionRef();
              const session = sessionRef ? { provider: host.id, sessionId: sessionRef } as const : undefined;
              if (failureReason) {
                sink?.({
                  error: failureReason,
                  provider: host.id,
                  runEvent: normalizedRunEvent({
                    kind: "error",
                    method: "pi-coding-agent/agent_settled",
                    outcome: "failed",
                    provider: host.id,
                    session
                  }),
                  session,
                  type: "provider.error"
                });
                reject(new Error(failureReason));
                return;
              }
              sink?.({
                provider: host.id,
                runEvent: normalizedRunEvent({
                  kind: "completed",
                  method: "pi-coding-agent/agent_settled",
                  outcome: "succeeded",
                  provider: host.id,
                  session
                }),
                session,
                status: "completed",
                type: "provider.completed"
              });
              resolve({ sessionRef });
            }).catch(() => {
              if (failureReason) reject(new Error(failureReason));
              else resolve({ sessionRef: host.lastSessionRef() });
            });
            break;
          case "error":
          case "exit":
            if (host.interrupted()) {
              if (!settled) {
                settled = true;
                cleanup();
                reject(new ProviderInterruptedError("pi rpc execution was interrupted by host"));
              }
              break;
            }
            rejectTerminal(
              new Error(approvalBridgeFailure || (event.type === "exit" ? "pi rpc exited before agent settled" : String(event.message ?? "pi rpc error"))),
              approvalBridgeFailure ? "pi-coding-agent/approval_bridge_unavailable" : event.type === "exit" ? "pi-coding-agent/process_exit" : "pi-coding-agent/error"
            );
            break;
          case "stderr":
            if (input.policy?.nativeSummary.approvalBridge === true && /Failed to load extension/i.test(String(event.text ?? ""))) {
              approvalBridgeFailure = "approval_bridge_unavailable: Pi failed to load the Xuanwu policy extension";
              void transport.stop().catch(() => undefined);
              rejectTerminal(new Error(approvalBridgeFailure), "pi-coding-agent/approval_bridge_unavailable");
            }
            sink?.({ provider: host.id, type: "provider.error", text: String(event.text ?? "") });
            break;
          case "extension_ui_request":
            void host.handlePolicyApprovalRequest(event, transport, sink, input, initialSessionRef, invocationRef)
              .catch((error) => rejectTerminal(error instanceof Error ? error : new Error(String(error)), "pi-coding-agent/approval_bridge"));
            break;
          case "message_update": {
            const update = objectValue(event.assistantMessageEvent);
            if (update.type === "error") failureReason = String(update.error ?? update.reason ?? "Pi model request failed");
            if (update.type === "text_delta" && typeof update.delta === "string" && update.delta !== "") {
              const session = sessionForEvent();
              sink?.({
                provider: host.id,
                raw: { method: "item/agentMessage/delta" },
                runEvent: normalizedRunEvent({
                  kind: "progress",
                  method: "item/agentMessage/delta",
                  outcome: "running",
                  provider: host.id,
                  session
                }),
                session,
                text: update.delta,
                type: "provider.message"
              });
            }
            break;
          }
          case "tool_execution_start": {
            const observation = piToolObservation(event, input.cwd ?? "");
            if (observation) activeTools.set(observation.id, observation);
            break;
          }
          case "tool_execution_end": {
            const id = stringValue(event.toolCallId);
            const observation = activeTools.get(id);
            activeTools.delete(id);
            if (!observation) break;
            const session = sessionForEvent();
            const failed = event.isError === true;
            const output = piToolOutput(event.result);
            const exitCode = piToolExitCode(event.result, failed, output);
            const durationMs = Math.max(0, Date.now() - observation.startedAt);
            const item = {
              aggregatedOutput: output,
              command: observation.command,
              cwd: observation.cwd,
              durationMs,
              exitCode,
              id: observation.id,
              status: failed ? "failed" : "completed",
              type: "commandExecution"
            };
            sink?.({
              command: observation.command,
              payload: item,
              provider: host.id,
              raw: { method: "item/completed", payload: JSON.stringify({ item }) },
              runEvent: normalizedRunEvent({
                kind: "progress",
                method: "item/completed",
                outcome: "running",
                provider: host.id,
                session
              }),
              session,
              status: item.status,
              text: output,
              type: "tool"
            });
            break;
          }
          case "auto_retry_end":
            if (event.success === false) failureReason = String(event.finalError ?? "Pi model request failed after retries");
            break;
          default:
            break;
        }
      });
      armInactivityTimeout();
    });
  }
