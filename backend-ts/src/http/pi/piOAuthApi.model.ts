import { type CredentialSource } from "../../pi/runtime/piModelRuntime.ts";
import type { OAuthAuthInfo, OAuthCredentials, OAuthPrompt } from "@earendil-works/pi-ai";
import type { RunnerDatabase } from "../../db/database.ts";
import { type PiOAuthPhase } from "./piOAuthDiagnostics.ts";

export type PiOAuthLoginCallbacks = {
  onAuth: (info: OAuthAuthInfo) => void;
  onProgress?: (message: string) => void;
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
};

export type PiOpenAICodexOAuthLogin = (
  callbacks: PiOAuthLoginCallbacks,
  signal?: AbortSignal
) => Promise<OAuthCredentials>;

export type PiOpenAICodexModelDiscovery = (database: RunnerDatabase, signal?: AbortSignal, source?: CredentialSource) => Promise<string[]>;

export type PiOAuthContext = {
  database: RunnerDatabase;
  piOpenAICodexOAuthLogin?: PiOpenAICodexOAuthLogin;
  piOAuthLoginTimeoutMs?: number;
};

export type LoginAbortReason = "logout" | "restarted" | "timeout";

export type LoginState = {
  attemptId: string;
  abortController: AbortController;
  abortReason?: LoginAbortReason;
  authUrl?: string;
  completion?: Promise<void>;
  error?: string;
  instructions?: string;
  message?: string;
  phase: PiOAuthPhase;
  startedAt: string;
  status: "pending" | "authenticated" | "error";
  timeout?: ReturnType<typeof setTimeout>;
};
