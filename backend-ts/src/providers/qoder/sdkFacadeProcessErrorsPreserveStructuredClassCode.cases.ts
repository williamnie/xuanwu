import { describe, expect, test } from "bun:test";
import type { Options, Query, SDKMessage, SDKResultMessage, SDKSystemInitMessage } from "@qoder-ai/qoder-agent-sdk";
import { buildConfig } from "../../config/env.ts";
import { createQoderSdkFacade, QoderExecutionError } from "./sdkFacade.ts";
import { QODER_EXECUTION_POLICY_CAPABILITIES, qoderExecutionPolicyAdapter } from "./executionPolicy.ts";
import { resolveExecutionPolicy } from "../core/policyResolution.ts";
import type { ExecutionPolicyRequest } from "../core/policyContracts.ts";

import { init, result, FakeQuery, config, runOptions, resolvedPolicy } from "./sdkFacadeTestFixtures.ts";

export function registerProcessErrorsPreserveStructuredClassCode() {
test("process errors preserve structured class/code/exit/signal and timeout is retryable", async () => {
    const processFacade = createQoderSdkFacade(config(1_000), {
      queryFactory: ({ options }) => {
        const stream = new FakeQuery(options);
        stream.push(init(options.sessionId ?? ""));
        const error = Object.assign(new Error("qodercli crashed"), {
          code: "QODER_CLI_PROCESS_ERROR",
          exitCode: 17,
          signal: "SIGTERM"
        });
        stream.fail(error);
        return stream.query;
      }
    });
    const processFailure = await processFacade.run("go", runOptions("inv-process", "session-process")).catch((error) => error);
    expect(processFailure).toBeInstanceOf(QoderExecutionError);
    expect((processFailure as QoderExecutionError).details).toMatchObject({
      category: "process",
      code: "QODER_CLI_PROCESS_ERROR",
      errorClass: "Error",
      exitCode: 17,
      retryable: false,
      signal: "SIGTERM"
    });

    const timeoutFacade = createQoderSdkFacade(config(5), {
      queryFactory: ({ options }) => {
        const stream = new FakeQuery(options);
        stream.push(init(options.sessionId ?? ""));
        return stream.query;
      }
    });
    const timeoutFailure = await timeoutFacade.run("go", runOptions("inv-timeout", "session-timeout")).catch((error) => error);
    expect(timeoutFailure).toBeInstanceOf(QoderExecutionError);
    expect((timeoutFailure as QoderExecutionError).details).toMatchObject({ category: "timeout", retryable: true });
    expect(timeoutFacade.activeCount()).toBe(0);
  });

test("full unattended passes Qoder double bypass and rejects an observed downgrade", async () => {
    let captured: Options | undefined;
    const policy = resolvedPolicy({ access: "unrestricted-host", approval: "unattended" });
    const facade = createQoderSdkFacade(config(1_000), {
      queryFactory: ({ options }) => {
        captured = options;
        const stream = new FakeQuery(options);
        stream.push(init(options.sessionId ?? "", "dontAsk"));
        stream.end();
        return stream.query;
      }
    });

    const failure = await facade.run("go", { ...runOptions("inv-policy", "session-policy"), policy }).catch((error) => error);
    expect(captured).toMatchObject({
      allowDangerouslySkipPermissions: true,
      permissionMode: "bypassPermissions"
    });
    expect(failure).toBeInstanceOf(QoderExecutionError);
    expect((failure as QoderExecutionError).details).toMatchObject({ code: "provider_policy_downgraded", retryable: false });
  });
}
