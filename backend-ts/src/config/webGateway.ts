import { DEFAULT_ADDR } from "./paths.ts";

export const DEFAULT_CORE_ADDR = "127.0.0.1:3009";
export const DEFAULT_PROXY_TIMEOUT_MS = 30_000;

export type WebGatewayConfig = {
  addr: string;
  coreAddr: string;
  proxyTimeoutMs: number;
  webDir: string;
};

type Env = Record<string, string | undefined>;
type WebConfigKey = "addr" | "coreAddr" | "proxyTimeoutMs" | "webDir";

const FLAGS: Record<string, WebConfigKey> = {
  "--addr": "addr",
  "--core-addr": "coreAddr",
  "--proxy-timeout-ms": "proxyTimeoutMs",
  "--web-dir": "webDir"
};

export function loadWebGatewayConfig(args: string[], env: Env = Bun.env): WebGatewayConfig {
  const values: Record<WebConfigKey, string> = {
    addr: clean(env.CODEX_RUNNER_ADDR) || DEFAULT_ADDR,
    coreAddr: clean(env.CODEX_RUNNER_CORE_ADDR) || DEFAULT_CORE_ADDR,
    proxyTimeoutMs: clean(env.CODEX_RUNNER_PROXY_TIMEOUT_MS) || String(DEFAULT_PROXY_TIMEOUT_MS),
    webDir: clean(env.CODEX_RUNNER_WEB_DIR)
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const separator = arg.indexOf("=");
    const flag = separator > 0 ? arg.slice(0, separator) : arg;
    const key = FLAGS[flag];
    if (!key) throw new Error(`Unknown Web Gateway argument: ${arg}`);
    const value = separator > 0 ? arg.slice(separator + 1) : args[index + 1];
    if (clean(value) === "") throw new Error(`Missing value for ${flag}`);
    values[key] = clean(value);
    if (separator <= 0) index += 1;
  }
  return {
    addr: values.addr,
    coreAddr: normalizeCoreAddr(values.coreAddr),
    proxyTimeoutMs: positiveInteger(values.proxyTimeoutMs, DEFAULT_PROXY_TIMEOUT_MS),
    webDir: values.webDir
  };
}

function normalizeCoreAddr(value: string): string {
  const cleanValue = clean(value);
  if (/^https?:\/\//i.test(cleanValue)) return cleanValue.replace(/\/+$/, "");
  return `http://${cleanValue.replace(/\/+$/, "")}`;
}

function positiveInteger(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}
