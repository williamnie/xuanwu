import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildConfig } from "../../config/env.ts";
import { probeQoderRuntime, qoderAuthenticationStatus } from "./runtime.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { force: true, recursive: true });
  }
});

describe("Qoder Q1 offline runtime readiness", () => {
  test("reports missing CLI as not-ready without calling Qoder", () => {
    const config = buildConfig({ qoderAuthMode: "pat-env", qoderPat: "fixture-pat" }).providers.qoder!;
    const probe = probeQoderRuntime(config, {
      inspectCli: () => ({ installed: false, reason: "Qoder CLI fixture is missing" })
    });

    expect(probe).toMatchObject({
      installed: false,
      ready: false,
      reason: "Qoder CLI fixture is missing",
      status: {
        auth_configured: true,
        executable_ready: false,
        ready: false,
        platform_profile: {
          cli_version: "",
          protocol_status: "unavailable",
          sdk_ready: true,
          sdk_version: "1.0.20"
        }
      }
    });
  });

  test("reports missing auth as not-ready even with the exact CLI pair", () => {
    const config = buildConfig({ qoderAuthMode: "pat-env" }).providers.qoder!;
    const probe = probeQoderRuntime(config, {
      inspectCli: () => ({ installed: true, version: "1.1.18" })
    });

    expect(probe).toMatchObject({
      installed: true,
      ready: false,
      reason: "QODER_PERSONAL_ACCESS_TOKEN is not configured",
      status: {
        auth_configured: false,
        executable_ready: true,
        ready: false
      }
    });
  });

  test("keeps an incomplete secret-ref config visible as not-ready", () => {
    const config = buildConfig({ qoderAuthMode: "pat-secret-ref" }).providers.qoder!;
    const probe = probeQoderRuntime(config, {
      inspectCli: () => ({ installed: true, version: "1.1.18" })
    });

    expect(probe).toMatchObject({
      installed: true,
      ready: false,
      reason: "Qoder credential secret ref is missing or unresolved",
      status: {
        auth_configured: false,
        auth_mode: "pat-secret-ref",
        auth_source: "secret_ref",
        ready: false
      }
    });
  });

  test("rejects an incompatible CLI version before it can become submittable", () => {
    const config = buildConfig({ qoderAuthMode: "pat-env", qoderPat: "fixture-pat" }).providers.qoder!;
    const probe = probeQoderRuntime(config, {
      inspectCli: () => ({ installed: true, version: "1.1.19", reason: "version mismatch" })
    });

    expect(probe.ready).toBe(false);
    expect(probe.status.platform_profile).toMatchObject({
      cli_version: "1.1.19",
      protocol_status: "unavailable",
      protocol_version: "1.2.0"
    });
  });

  test("recognizes all four auth sources without exposing credential values", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "xuanwu-qoder-auth-"));
    roots.push(configDir);
    const marker = join(configDir, "oauth_creds.json");
    await writeFile(marker, "fixture-login-marker", { mode: 0o600 });
    await chmod(marker, 0o600);

    const patEnv = buildConfig({ qoderAuthMode: "pat-env", qoderPat: "fixture-pat" }).providers.qoder!;
    const patRef = buildConfig({
      qoderAuthMode: "pat-secret-ref", qoderCredential: "fixture-pat", qoderCredentialRef: "secret://qoder/pat"
    }).providers.qoder!;
    const serviceAccount = buildConfig({
      qoderAuthMode: "service-account-secret-ref",
      qoderCredential: "fixture-service-account",
      qoderCredentialRef: "secret://qoder/service-account"
    }).providers.qoder!;
    const local = buildConfig({ qoderAuthMode: "local-cli", qoderConfigDir: configDir }).providers.qoder!;

    expect(qoderAuthenticationStatus(patEnv)).toMatchObject({ configured: true, source: "environment" });
    expect(qoderAuthenticationStatus(patRef)).toMatchObject({ configured: true, source: "secret_ref" });
    expect(qoderAuthenticationStatus(serviceAccount)).toMatchObject({ configured: true, source: "service_account_secret_ref" });
    expect(qoderAuthenticationStatus(local)).toMatchObject({ configured: true, source: "local_cli" });
    for (const status of [patEnv, patRef, serviceAccount, local].map(qoderAuthenticationStatus)) {
      expect(JSON.stringify(status)).not.toContain("fixture-pat");
      expect(JSON.stringify(status)).not.toContain("fixture-service-account");
    }
  });
});
