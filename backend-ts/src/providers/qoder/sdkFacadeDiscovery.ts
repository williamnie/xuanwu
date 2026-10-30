import type { SDKMessage } from "@qoder-ai/qoder-agent-sdk";
import type { ResolvedExecutionPolicy } from "../core/policyContracts.ts";
import { cleanString } from "../../util/values.ts";
import { qoderError } from "./sdkFacadeUsage.ts";

export function qoderModelDiscoveryStep<T>(operation: Promise<T>, deadline: number): Promise<T> {
  const remainingMs = Math.max(1, deadline - Date.now());
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Qoder model discovery timed out")), remainingMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export function assertObservedPermissionMode(
  message: SDKMessage,
  policy: ResolvedExecutionPolicy | undefined,
  sessionId: string
): void {
  if (!policy || message.type !== "system" || message.subtype !== "init") return;
  const expected = cleanString(policy.nativeSummary.permissionMode);
  const observed = cleanString((message as unknown as Record<string, unknown>).permissionMode);
  if (expected === "" || observed === "" || expected === observed) return;
  throw qoderError(
    "configuration",
    `provider_policy_downgraded: Qoder initialized permission mode ${observed} instead of ${expected}`,
    { code: "provider_policy_downgraded", retryable: false, sessionId }
  );
}
