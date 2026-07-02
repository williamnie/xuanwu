import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import { json } from "./errors.ts";
import type { Router } from "./router.ts";

const DEFAULT_RESTART_DELAY_MS = 250;
const PROVIDER_STOP_TIMEOUT_MS = 2_500;
const SUPERVISOR_ENV_KEYS = ["XPC_SERVICE_NAME", "INVOCATION_ID"] as const;

export type SystemRestartContext = {
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  restartDelayMs?: number;
  restartProcess?: () => void;
};

export function registerSystemRestartRoute(router: Router, context: SystemRestartContext): void {
  router.post("/api/system/restart", () => {
    if (!canRestart(context)) {
      return json({ ok: false, message: "当前服务不是 launchd/systemd 托管，无法从 UI 安全重启" }, { status: 501 });
    }
    const delayMs = restartDelayMs(context.restartDelayMs);
    setTimeout(() => { void stopProvidersThenRestart(context); }, delayMs);
    return json({
      ok: true,
      delay_ms: delayMs,
      message: "重启请求已接受，服务会短暂断开并由守护进程拉起",
      restart_scheduled: true
    }, { status: 202 });
  });
}

function canRestart(context: SystemRestartContext): boolean {
  return Boolean(context.restartProcess) || isSupervisorManaged();
}

function isSupervisorManaged(): boolean {
  return SUPERVISOR_ENV_KEYS.some((key) => (Bun.env[key] ?? "").trim() !== "");
}

function restartDelayMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : DEFAULT_RESTART_DELAY_MS;
}

async function stopProvidersThenRestart(context: SystemRestartContext): Promise<void> {
  await stopProviders(context.providers);
  (context.restartProcess ?? (() => process.exit(0)))();
}

async function stopProviders(providers: SystemRestartContext["providers"]): Promise<void> {
  await Promise.all(Object.values(providers ?? {}).map(stopProvider));
}

async function stopProvider(provider: ExecutorProvider | undefined): Promise<void> {
  if (!provider?.stop) return;
  try {
    await withTimeout(provider.stop(), PROVIDER_STOP_TIMEOUT_MS);
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      service: "codex-issue-runner backend-ts",
      error: error instanceof Error ? error.message : String(error)
    }));
  }
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("provider stop timed out before restart")), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
