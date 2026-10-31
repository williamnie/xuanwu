import { redactSensitiveText } from "../util/redact.ts";

/**
 * Bun 默认在未处理的 Promise 拒绝时退出进程；Core 的后台任务漏接一次写锁冲突就会整站中断。
 * 这里只记日志兜底，调用处仍应自行 catch。
 */
export function installUnhandledRejectionLogger(target: Pick<NodeJS.Process, "on"> = process): void {
  target.on("unhandledRejection", (reason: unknown) => {
    console.error(JSON.stringify({
      event: "core.unhandled_rejection",
      error_name: reason instanceof Error ? reason.name : typeof reason,
      error: redactSensitiveText(reason instanceof Error ? reason.message : String(reason))
    }));
  });
}
