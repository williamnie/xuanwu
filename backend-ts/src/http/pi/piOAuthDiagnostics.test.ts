import { describe, expect, test } from "bun:test";
import { diagnosePiOAuthFailure } from "./piOAuthDiagnostics.ts";

describe("PI OAuth failure diagnostics", () => {
  test("extracts token exchange status and a known provider code without logging the response", () => {
    const error = new Error('OpenAI Codex token exchange failed (400): {"error":{"code":"invalid_grant","message":"code=private-code access_token=private-token"}}');
    expect(diagnosePiOAuthFailure(error, "provider_login")).toEqual({
      phase: "token_exchange", category: "provider_http", http_status: 400, provider_code: "invalid_grant"
    });
  });

  test("retains nested network causes without serializing credentials, URLs, or stacks", () => {
    const cause = Object.assign(new Error("https://proxy-user:proxy-password@example.test/?code=private-code"), { code: "ECONNRESET" });
    const error = Object.assign(new Error("fetch failed Bearer private-token", { cause }), {
      credential: { access: "private-access", refresh: "private-refresh" }
    });
    expect(diagnosePiOAuthFailure(error, "provider_login")).toEqual({
      phase: "provider_login", category: "network", system_code: "ECONNRESET"
    });
  });

  test("distinguishes storage and post-login synchronization failures", () => {
    const cause = Object.assign(new Error("permission denied at /private/auth.json"), { code: "EACCES" });
    expect(diagnosePiOAuthFailure(new Error("Credential store modify failed for openai-codex", { cause }), "provider_login"))
      .toEqual({ phase: "credential_storage", category: "credential_storage", system_code: "EACCES" });
    expect(diagnosePiOAuthFailure(new Error("Credential login committed for openai-codex, but local synchronization failed"), "provider_login"))
      .toEqual({ phase: "runtime_sync", category: "runtime_sync" });
  });

  test("does not echo arbitrary error fields or unsupported provider codes", () => {
    const error = Object.assign(new Error('OpenAI Codex token exchange failed (403): {"error":{"code":"private-token"}}'), { code: "private-secret" });
    expect(diagnosePiOAuthFailure(error, "provider_login"))
      .toEqual({ phase: "token_exchange", category: "provider_http", http_status: 403 });
    const cyclic = new Error("private-token");
    cyclic.cause = cyclic;
    expect(diagnosePiOAuthFailure(cyclic, "initializing_runtime"))
      .toEqual({ phase: "initializing_runtime", category: "unknown" });
  });

  test("identifies malformed token responses without including their fields", () => {
    expect(diagnosePiOAuthFailure(new Error('OpenAI Codex token exchange response missing fields: {"access_token":"secret"}'), "provider_login"))
      .toEqual({ phase: "token_exchange", category: "invalid_token_response" });
  });
});
