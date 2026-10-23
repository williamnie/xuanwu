import { DEFAULT_ADDR } from "./paths.ts";
import { cleanString } from "../util/values.ts";

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
    addr: cleanString(env.XUANWU_ADDR) || DEFAULT_ADDR,
    coreAddr: cleanString(env.XUANWU_CORE_ADDR) || DEFAULT_CORE_ADDR,
    proxyTimeoutMs: cleanString(env.XUANWU_PROXY_TIMEOUT_MS) || String(DEFAULT_PROXY_TIMEOUT_MS),
    webDir: cleanString(env.XUANWU_WEB_DIR)
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const separator = arg.indexOf("=");
    const flag = separator > 0 ? arg.slice(0, separator) : arg;
    const key = FLAGS[flag];
    if (!key) throw new Error(`Unknown Web Gateway argument: ${arg}`);
    const value = separator > 0 ? arg.slice(separator + 1) : args[index + 1];
    if (cleanString(value) === "") throw new Error(`Missing value for ${flag}`);
    values[key] = cleanString(value);
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
  const cleanValue = cleanString(value);
  if (/^https?:\/\//i.test(cleanValue)) return cleanValue.replace(/\/+$/, "");
  return `http://${cleanValue.replace(/\/+$/, "")}`;
}

function positiveInteger(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
