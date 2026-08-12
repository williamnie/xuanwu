import type {
  ExecutorCapability,
  ExecutorProvider,
  InterruptInput,
  ProviderRecoveryInput,
  ProviderRunInput,
  ProviderRunResult,
  ProviderRuntimeStatus,
  SessionCreateInput,
  SessionCreateResult,
  SessionRef
} from "../types.ts";
import { ProviderInterruptedError } from "../types.ts";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import { projectQoderMessage, qoderFailureEvent, qoderInterruptedEvent } from "./events.ts";
import {
  createQoderSdkFacade,
  QoderExecutionError,
  type QoderQueryResult,
  type QoderRunOptions,
  type QoderSdkFacade
} from "./sdkFacade.ts";
import { probeQoderRuntime, type QoderRuntimeProbe } from "./runtime.ts";

const SYSTEM_PROMPT = "You are executing a Xuanwu-managed Issue. Follow the Issue prompt and report only verified outcomes.";

export type QoderExecutorProviderOptions = {
  facade?: QoderSdkFacade;
  invocationIdFactory?: () => string;
  readiness?: QoderRuntimeProbe;
  sessionIdFactory?: () => string;
};

type ActiveInvocation = {
  aliases: Set<string>;
  invocationRef: string;
  interrupted: boolean;
  messageRef: string;
  sessionRef: string;
  terminalProjected: boolean;
};

export class QoderExecutorProvider implements ExecutorProvider {
  readonly id = "qoder" as const;
  readonly capabilities: readonly ExecutorCapability[] = ["issue_execution", "sessions", "resume_session", "interrupt"];
  readonly interruptScope = "session" as const;
  private readonly facade: QoderSdkFacade;
  private readonly active = new Map<string, ActiveInvocation>();

  constructor(
    private readonly config: ProviderRuntimeConfig,
    private readonly options: QoderExecutorProviderOptions = {}
  ) {
    this.facade = options.facade ?? createQoderSdkFacade(config);
  }

  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    const sessionId = clean(this.options.sessionIdFactory?.()) || crypto.randomUUID();
    return await this.execute(input, { sessionId });
  }

  async recover(input: ProviderRecoveryInput): Promise<ProviderRunResult> {
    const sessionId = required(input.session.sessionId, "Qoder recovery session id");
    return await this.execute(input, { resume: sessionId }, sessionId);
  }

  async createSession(input: SessionCreateInput): Promise<SessionCreateResult> {
    const result = await this.execute({
      issueId: 0,
      projectId: input.projectId ?? "",
      cwd: input.cwd,
      prompt: input.prompt ?? "",
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      approvalPolicy: input.approvalPolicy,
      sandbox: input.sandbox
    }, { sessionId: clean(this.options.sessionIdFactory?.()) || crypto.randomUUID() });
    const session = requiredSession(result);
    return {
      id: session.sessionId,
      provider: this.id,
      provider_session_id: session.sessionId,
      provider_turn_id: session.turnId,
      thread_id: session.sessionId,
      turn_id: session.turnId
    };
  }

  async interrupt(input: InterruptInput): Promise<void> {
    const active = this.lookup(input.session);
    if (!active) throw new Error(`Qoder session ${input.session.sessionId} is not active`);
    active.interrupted = true;
    await this.facade.interrupt(active.invocationRef);
  }

  runtimeStatus(): ProviderRuntimeStatus {
    const status = { ...(this.options.readiness ?? probeQoderRuntime(this.config)).status };
    status.active_sessions = this.facade.activeCount();
    return status;
  }

  processLeases() {
    return this.facade.processLeases();
  }

  async stop(): Promise<void> {
    await this.facade.close();
    this.active.clear();
  }

  private async execute(
    input: ProviderRunInput,
    sessionOptions: Pick<QoderRunOptions, "resume" | "sessionId">,
    resumeAlias = ""
  ): Promise<ProviderRunResult> {
    const invocationRef = clean(this.options.invocationIdFactory?.()) || `qoder-inv-${crypto.randomUUID()}`;
    const active: ActiveInvocation = {
      aliases: new Set(),
      interrupted: false,
      invocationRef,
      messageRef: "",
      sessionRef: clean(resumeAlias) || clean(sessionOptions.sessionId),
      terminalProjected: false
    };
    this.track(active, invocationRef);
    if (active.sessionRef) this.track(active, active.sessionRef);
    const options: QoderRunOptions = {
      ...sessionOptions,
      approvalPolicy: input.approvalPolicy,
      cwd: input.cwd,
      invocationKey: invocationRef,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      sandbox: input.sandbox,
      systemPrompt: SYSTEM_PROMPT
    };
    try {
      const outcome = await this.facade.run(input.prompt, options, (message, context) => {
        const event = projectQoderMessage(message, {
          interrupted: context.interrupted || active.interrupted,
          invocationRef
        });
        const sessionRef = clean(event.session?.sessionId);
        if (sessionRef) {
          if (active.sessionRef && active.sessionRef !== sessionRef) {
            throw new Error(`Qoder invocation ${invocationRef} returned mismatched session ${sessionRef}`);
          }
          active.sessionRef = sessionRef;
          this.track(active, sessionRef);
        }
        const messageRef = clean(event.session?.turnId);
        if (messageRef) {
          active.messageRef = messageRef;
          this.track(active, messageRef);
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
        if (!active.terminalProjected) input.onEvent?.(qoderFailureEvent(error.details, invocationRef));
        throw error;
      }
      const wrapped = new QoderExecutionError({
        category: "sdk",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
        sessionId: active.sessionRef
      });
      input.onEvent?.(qoderFailureEvent(wrapped.details, invocationRef));
      throw wrapped;
    } finally {
      this.untrack(active);
    }
  }

  private track(active: ActiveInvocation, alias: string): void {
    const key = clean(alias);
    if (!key || active.aliases.has(key)) return;
    const existing = this.active.get(key);
    if (existing && existing !== active) throw new Error(`Qoder active query alias ${key} is already in use`);
    this.active.set(key, active);
    active.aliases.add(key);
  }

  private untrack(active: ActiveInvocation): void {
    for (const alias of active.aliases) {
      if (this.active.get(alias) === active) this.active.delete(alias);
    }
    active.aliases.clear();
  }

  private lookup(session: SessionRef): ActiveInvocation | undefined {
    return this.active.get(clean(session.sessionId)) ??
      (session.turnId ? this.active.get(clean(session.turnId)) : undefined);
  }
}

function qoderRunResult(outcome: QoderQueryResult): ProviderRunResult {
  const sessionId = required(outcome.sessionId, "Qoder result session id");
  const messageRef = required(outcome.messageRef, "Qoder result message ref");
  return {
    runId: required(outcome.invocationRef, "Qoder invocation ref"),
    session: { provider: "qoder", sessionId, turnId: messageRef }
  };
}

function requiredSession(result: ProviderRunResult): SessionRef {
  if (!result.session) throw new Error("Qoder execution completed without a session ref");
  return result.session;
}

function required(value: unknown, label: string): string {
  const text = clean(value);
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
