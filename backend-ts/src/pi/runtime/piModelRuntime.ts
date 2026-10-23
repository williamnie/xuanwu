import { dirname, join, resolve } from "node:path";
import type { CredentialStore } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { RunnerDatabase } from "../../db/database.ts";
import { getPiSupervisor } from "../../db/repositories/pi.ts";
import { effectiveCodexHome } from "../../config/codexServer.ts";
import { createCodexLoginService, type CodexLoginService } from "./codexLoginCredentials.ts";

export type CredentialSource = "stored" | "codex_login";
const contexts = new Map<string, CodexLoginService>();
export function credentialSource(value: unknown): CredentialSource {
  if (value === undefined) return "stored";
  if (value !== "stored" && value !== "codex_login") throw new Error("credential_source must be stored or codex_login");
  return value;
}
export function selectedCredentialSource(db: RunnerDatabase, override?: CredentialSource): CredentialSource {
  return override ?? getPiSupervisor(db)?.credential_source ?? "stored";
}
export function registerCodexLoginService(db: RunnerDatabase, service: CodexLoginService): () => void {
  const key = resolve(dirname(db.path));
  contexts.set(key, service);
  return () => { if (contexts.get(key) === service) contexts.delete(key); };
}
export function codexLoginService(db: RunnerDatabase): CodexLoginService {
  const registered = contexts.get(resolve(dirname(db.path)));
  if (registered) return registered;
  // Explicit runtime registration is required to refresh. Tests/offline tools cannot start Codex.
  const key = {};
  return createCodexLoginService({ role: "worker", binding: () => ({
    home: effectiveCodexHome(), managedHome: effectiveCodexHome(), key, unavailable: "codex_account_unavailable"
  }) });
}
export function piCredentialPaths(db: RunnerDatabase) {
  const agentDir = join(dirname(db.path), "pi-runtime", "agent");
  return { agentDir, authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") };
}

type Sdk = { ModelRuntime: typeof ModelRuntime; readStoredCredential: (id: string, path: string) => unknown };
type Options = Parameters<typeof ModelRuntime.create>[0] & {
  mode?: "assistant" | "stored" | "replay" | "smoke";
  database?: RunnerDatabase;
  source?: CredentialSource;
  replayCredentials?: CredentialStore;
};
/** The only non-test ModelRuntime.create call: identity selection is explicit at every entry. */
export async function createPiModelRuntime(sdk: Sdk, options: Options) {
  const { database, source, mode = "assistant", replayCredentials, ...runtime } = options;
  let credentials: CredentialStore | undefined;
  if (mode === "replay") {
    credentials = database && selectedCredentialSource(database, source) === "codex_login"
      ? codexLoginService(database).readOnlyCredentials : replayCredentials;
    if (!credentials) throw new Error("replay requires read-only credentials");
  } else if (mode === "assistant") {
    if (!database) throw new Error("assistant runtime requires database");
    if (selectedCredentialSource(database, source) === "codex_login") credentials = codexLoginService(database).credentials;
  }
  return sdk.ModelRuntime.create({ ...runtime, ...(credentials ? { credentials } : {}) });
}
