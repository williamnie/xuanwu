import type { ExecutorProvider, ProviderRunInput, ProviderRunResult } from "../providers/types.ts";

export type RunnerIssueExecutionInput = Omit<ProviderRunInput, "onEvent"> & {
  onLog?: ProviderRunInput["onEvent"];
};

export async function runIssueWithProvider(
  provider: Pick<ExecutorProvider, "capabilities" | "run">,
  input: RunnerIssueExecutionInput
): Promise<ProviderRunResult> {
  if (!provider.capabilities.includes("issue_execution")) {
    throw new Error('executor provider missing capability "issue_execution"');
  }
  return await provider.run({ ...input, onEvent: input.onLog });
}
