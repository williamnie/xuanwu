import type { ProviderEvent } from "../types.ts";
import { CodexProcessGroupLifecycle } from "./processLifecycle.ts";

export type JsonRpcParams = Record<string, unknown> | unknown[] | null;

export type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
};

export type CodexJsonRpcProcess = {
  stdin: { write(chunk: string | Uint8Array): unknown; flush?: () => unknown; end?: () => unknown };
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(signal?: string | number): unknown;
  pid?: number;
};

export type CodexJsonRpcProcessFactory = (options: {
  command: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
}) => CodexJsonRpcProcess;

export type ServerRequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown;

export type CodexTransportOptions = {
  idleTtlMs?: number;
  onEvent?: (event: ProviderEvent) => void;
  ownershipFile?: string;
  processFactory?: CodexJsonRpcProcessFactory;
  processLifecycle?: CodexProcessGroupLifecycle;
  onDiagnostic?: (event: ProviderEvent) => void;
  onServerRequest?: ServerRequestHandler;
};

export type CodexProcessLease = {
  bind(sessionID: string, turnID?: string): void;
  release(): void;
};

export const CODEX_APP_SERVER_RPC_TIMEOUT_MS = 90_000;

export const CODEX_APP_SERVER_IDLE_TTL_MS = 15_000;

export const CODEX_PROCESS_ACTIVE_REFRESH_MS = 5_000;

export function codexAppServerRpcTimeoutMs(configuredTimeoutMs: number): number {
  return Math.min(Math.max(1, configuredTimeoutMs), CODEX_APP_SERVER_RPC_TIMEOUT_MS);
}

export function codexIdleTtlMs(configured: number | undefined): number {
  return typeof configured === "number" && Number.isFinite(configured) && configured >= 0
    ? configured
    : CODEX_APP_SERVER_IDLE_TTL_MS;
}
