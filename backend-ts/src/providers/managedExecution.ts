export const RUNNER_MANAGED_EXECUTION_ENV = "CODEX_RUNNER_MANAGED_EXECUTION";

export function managedExecutionEnvironment(
  environment: Record<string, string | undefined>
): Record<string, string | undefined> {
  return {
    ...environment,
    [RUNNER_MANAGED_EXECUTION_ENV]: "1"
  };
}
