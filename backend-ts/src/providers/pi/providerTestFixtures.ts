import { describe, expect, test } from "bun:test";
import { asProviderId, type ProviderEvent } from "../types.ts";
import { PiRpcTransport, piRpcChildEnv, type PiRpcCommand, type PiRpcEvent } from "./rpcTransport.ts";
import { PiExecutorProvider } from "./provider.ts";
import { piFactory, piManifest } from "./factory.ts";
import { createProviderRegistry } from "../core/registry.ts";
import { PI_EXECUTION_POLICY_CAPABILITIES, piExecutionPolicyAdapter } from "./executionPolicy.ts";
import { resolveExecutionPolicy } from "../core/policyResolution.ts";
import type { ExecutionPolicyRequest } from "../core/policyContracts.ts";
import xuanwuPolicyExtension from "./xuanwuPolicyExtension.ts";

export class FakePiTransport extends PiRpcTransport {
  readonly sent: PiRpcCommand[] = [];
  readonly emitted: PiRpcEvent[] = [];
  readonly sessionRefs: string[] = [];
  readonly toolSets: string[][] = [];
  readonly extensionSets: string[][] = [];
  readonly extensionResponses: Array<{ id: string; response: { cancelled?: boolean; confirmed?: boolean; value?: string } }> = [];
  hangAbort = false;
  started = false;

  constructor() {
    super("fake-pi");
  }

  override async start(): Promise<void> {
    this.started = true;
  }

  override async startForSession(sessionRef = "", tools: readonly string[] = [], extensions: readonly string[] = []): Promise<void> {
    this.sessionRefs.push(sessionRef);
    this.toolSets.push([...tools]);
    this.extensionSets.push([...extensions]);
    this.started = true;
  }

  override async stop(): Promise<void> {
    this.started = false;
  }

  override get running(): boolean {
    return this.started;
  }

  override async send(command: PiRpcCommand): Promise<unknown> {
    this.sent.push(command);
    if (command.type === "abort" && this.hangAbort) return await new Promise(() => {});
    if (command.type === "get_state") return { sessionId: "pi-session-1", thinkingLevel: "medium", isStreaming: false, isCompacting: false, steeringMode: "all", followUpMode: "all", autoCompactionEnabled: true, messageCount: 1, pendingMessageCount: 0 };
    if (command.type === "get_available_models") return [{ id: "glm-5.2", display_name: "GLM 5.2" }];
    return {};
  }

  override async respondExtensionUI(id: string, response: { cancelled?: boolean; confirmed?: boolean; value?: string }): Promise<void> {
    this.extensionResponses.push({ id, response });
  }

  pushEvent(event: PiRpcEvent): void {
    this.emitted.push(event);
    this.emitEvent(event);
  }
}

export function piPolicy(input: Omit<ExecutionPolicyRequest, "contract">) {
  return resolveExecutionPolicy({ contract: "xw.execution-policy.v1", ...input }, {
    cwd: "/tmp",
    invocationRef: "pi-invocation",
    projectId: "p",
    providerId: "pi-coding-agent",
    providerVersion: "0.83.0",
    source: "local-user",
    transport: "rpc"
  }, PI_EXECUTION_POLICY_CAPABILITIES, piExecutionPolicyAdapter);
}

export async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("fixture condition was not reached");
}
