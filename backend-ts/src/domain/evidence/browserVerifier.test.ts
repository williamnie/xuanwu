import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_SNAPSHOT_ENV } from "../../pi/browserToolProvider.ts";
import { validateEvidence, type EvidenceArtifactRef } from "./contracts.ts";
import {
  BROWSER_EVIDENCE_SCENARIO_VERSION,
  FileSystemBrowserEvidenceArtifactStore,
  createBrowserEvidenceVerifier,
  evaluateBrowserArtifactFreshness,
  type BrowserCheckpointCapture,
  type BrowserEvidenceArtifactBundle,
  type BrowserEvidenceArtifactStore,
  type BrowserEvidenceArtifactWrite,
  type BrowserEvidenceScenario,
  type BrowserScenarioDriver
} from "./browserVerifier.ts";

const NOW = "2026-07-16T10:20:00.000Z";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { force: true, recursive: true });
  }
});

describe("Browser/Visual Evidence verifier", () => {
  test("runs a local-page smoke through the existing browser snapshot integration and associates a screenshot", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response("<!doctype html><title>Runner</title><h1 id='status'>Runner Ready</h1>", {
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }
    });
    const root = await temporaryRoot("browser-evidence-local-");
    const stateDir = join(root, "state");
    try {
      const response = await fetch(server.url);
      expect(await response.text()).toContain("Runner Ready");
      const pageURL = server.url.toString();
      const snapshot = {
        active_page_id: "local-page",
        authorized: true,
        generated_at: NOW,
        pages: [{
          id: "local-page",
          url: pageURL,
          title: "Runner",
          text: "Runner Ready",
          dom_summary: [{ count: 1, selector: "#status", text: "Runner Ready", visible_count: 1 }],
          screenshot: {
            captured_at: NOW,
            height: 720,
            image_ref: "fixture://local-page.png",
            mime_type: "image/png",
            width: 1280
          }
        }]
      };
      const verifier = createBrowserEvidenceVerifier({
        artifact_store: new FileSystemBrowserEvidenceArtifactStore(stateDir),
        env: { [BROWSER_SNAPSHOT_ENV]: JSON.stringify(snapshot) }
      });
      const evidence = await verifier.verify({
        context: evidenceContext("local-smoke"),
        scenario: scenario({
          checkpoints: [{
            assertions: [
              { expected: pageURL, kind: "url", operator: "equals" },
              { kind: "dom", selector: "#status", state: "visible", text: { expected: "Runner Ready", operator: "contains" } }
            ],
            id: "home",
            screenshot: "required",
            url: pageURL
          }]
        })
      });

      expect(evidence.status).toBe("passed");
      expect(evidence.decisive_output.facts).toMatchObject({
        assertion_count: 3,
        console_available: false,
        failed_assertion_count: 0,
        network_available: false,
        outcome: "passed",
        screenshot_artifact_count: 1,
        screenshot_count: 1
      });
      expect(validateEvidence(evidence)).toMatchObject({ ok: true });
      expect(evidence.artifact_refs).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "report", ref: expect.stringMatching(/^uploads\/artifacts\/evidence-browser\//) }),
        expect.objectContaining({ kind: "screenshot", ref: "fixture://local-page.png" })
      ]));
      const report = evidence.artifact_refs.find((artifact) => artifact.kind === "report")!;
      const reportPath = join(stateDir, report.ref);
      expect(JSON.parse(await readFile(reportPath, "utf8"))).toMatchObject({
        expires_at: "2026-07-16T11:20:00.000Z",
        outcome: "passed",
        scenario: { contract_version: BROWSER_EVIDENCE_SCENARIO_VERSION, id: "browser-smoke" }
      });
      expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
      expect(evaluateBrowserArtifactFreshness(evidence, "2026-07-16T11:19:59.999Z")).toMatchObject({ current: true, reason: "current" });
      expect(evaluateBrowserArtifactFreshness(evidence, "2026-07-16T11:20:00.000Z")).toMatchObject({ current: false, reason: "expired" });
    } finally {
      server.stop(true);
    }
  });

  test("records browser unavailability as blocked/inconclusive instead of passing", async () => {
    const store = new MemoryArtifactStore();
    const verifier = createBrowserEvidenceVerifier({ artifact_store: store, env: {} });
    const evidence = await verifier.verify({
      context: evidenceContext("unavailable"),
      scenario: scenario()
    });

    expect(evidence.status).toBe("blocked");
    expect(evidence.decisive_output.facts).toMatchObject({
      completed_checkpoint_count: 0,
      inconclusive_count: 1,
      inconclusive_reason: "browser_unavailable",
      outcome: "inconclusive",
      passed_assertion_count: 0
    });
    expect(evidence.decisive_output.summary).toContain("inconclusive");
    expect(store.writes).toHaveLength(1);
    expect(JSON.parse(store.writes[0].content)).toMatchObject({
      captures: [{ reason_code: "browser_unavailable", status: "inconclusive" }],
      outcome: "inconclusive"
    });
  });

  test("fails deterministic console/network policy and stores screenshot bytes with redacted summaries", async () => {
    const root = await temporaryRoot("browser-evidence-failure-");
    const stateDir = join(root, "state");
    const driver = fixtureDriver({
      checkpoint_id: "home",
      console: {
        available: true,
        entries: [{ level: "error", message: "AUTH_TOKEN=super-secret", source: "app.js" }],
        error_count: 1,
        total_count: 1,
        truncated: false,
        warning_count: 0
      },
      dom: [{ count: 1, selector: "#status", texts: ["Runner Ready"], visible_count: 1 }],
      dom_truncated: false,
      final_url: "http://127.0.0.1:3008/issues?token=super-secret",
      network: {
        available: true,
        entries: [
          { method: "GET", status: 200, url: "http://127.0.0.1:3008/api/issues" },
          { method: "GET", status: 503, url: "http://127.0.0.1:3008/api/health?api_key=super-secret" }
        ],
        failed_request_count: 0,
        http_error_count: 1,
        max_status: 503,
        total_count: 2,
        truncated: false
      },
      observed_at: NOW,
      screenshots: [{
        bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        captured_at: NOW,
        height: 720,
        media_type: "image/png",
        width: 1280
      }],
      status: "completed"
    });
    const verifier = createBrowserEvidenceVerifier({
      artifact_store: new FileSystemBrowserEvidenceArtifactStore(stateDir),
      driver
    });
    const evidence = await verifier.verify({
      context: evidenceContext("console-network"),
      scenario: scenario({
        checkpoints: [{
          assertions: [
            { expected: "http://127.0.0.1:3008", kind: "url", operator: "origin_equals" },
            { kind: "dom", selector: "#status", state: "visible", text: { expected: "Runner Ready", operator: "contains" } }
          ],
          id: "home",
          screenshot: "required",
          url: "http://127.0.0.1:3008/issues"
        }],
        console: { fail_on_levels: ["error"], required: true },
        network: { fail_on_request_failure: true, fail_on_status_at_least: 500, required: true }
      })
    });

    expect(evidence.status).toBe("failed");
    expect(evidence.decisive_output.facts).toMatchObject({
      console_available: true,
      console_error_count: 1,
      failed_assertion_count: 2,
      network_available: true,
      network_http_error_count: 1,
      outcome: "failed",
      screenshot_artifact_count: 1
    });
    const screenshot = evidence.artifact_refs.find((artifact) => artifact.kind === "screenshot")!;
    expect(screenshot.ref).toMatch(/\.png$/);
    expect(screenshot.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await stat(join(stateDir, screenshot.ref))).mode & 0o777).toBe(0o600);
    const report = evidence.artifact_refs.find((artifact) => artifact.kind === "report")!;
    const reportText = await readFile(join(stateDir, report.ref), "utf8");
    expect(reportText).not.toContain("super-secret");
    expect(reportText).toContain("[redacted");
  });

  test("keeps missing required summaries and truncated DOM absence inconclusive", async () => {
    const verifier = createBrowserEvidenceVerifier({
      artifact_store: new MemoryArtifactStore(),
      driver: fixtureDriver({
        checkpoint_id: "home",
        console: unavailableConsole(),
        dom: [],
        dom_truncated: true,
        final_url: "http://127.0.0.1:3008/issues",
        network: unavailableNetwork(),
        observed_at: NOW,
        screenshots: [],
        status: "completed"
      })
    });
    const evidence = await verifier.verify({
      context: evidenceContext("partial"),
      scenario: scenario({
        checkpoints: [{
          assertions: [
            { expected: "http://127.0.0.1:3008/issues", kind: "url", operator: "equals" },
            { kind: "dom", selector: "#status", state: "visible" }
          ],
          id: "home",
          screenshot: "optional",
          url: "http://127.0.0.1:3008/issues"
        }],
        console: { required: true },
        network: { required: true }
      })
    });

    expect(evidence.status).toBe("blocked");
    expect(evidence.decisive_output.facts).toMatchObject({
      failed_assertion_count: 0,
      inconclusive_count: 3,
      inconclusive_reason: "dom_observation_truncated",
      outcome: "inconclusive"
    });
  });

  test("rejects an invalid scenario before invoking the browser driver", async () => {
    let calls = 0;
    const driver: BrowserScenarioDriver = {
      permission: "read",
      provider_id: "fixture-browser",
      async capture() {
        calls += 1;
        throw new Error("must not run");
      }
    };
    const verifier = createBrowserEvidenceVerifier({ artifact_store: new MemoryArtifactStore(), driver });
    await expect(verifier.verify({
      context: evidenceContext("invalid"),
      scenario: scenario({ artifact_ttl_seconds: 31 * 24 * 60 * 60 })
    })).rejects.toThrow("artifact_ttl_seconds");
    expect(calls).toBe(0);
  });
});

class MemoryArtifactStore implements BrowserEvidenceArtifactStore {
  readonly writes: BrowserEvidenceArtifactWrite[] = [];

  writeBrowserEvidence(input: BrowserEvidenceArtifactWrite): BrowserEvidenceArtifactBundle {
    this.writes.push(input);
    const screenshots: EvidenceArtifactRef[] = input.screenshots.map((screenshot, index) => ({
      kind: "screenshot",
      media_type: screenshot.media_type,
      ref: screenshot.image_ref ?? `memory://screenshot-${index}`,
      ...(screenshot.bytes ? { sha256: createHash("sha256").update(input.screenshots[index].bytes!).digest("hex") } : {})
    }));
    return {
      report: {
        kind: "report",
        media_type: "application/json",
        ref: `memory://report/${input.report_sha256}`,
        sha256: input.report_sha256
      },
      screenshots
    };
  }
}

function scenario(overrides: Partial<BrowserEvidenceScenario> = {}): BrowserEvidenceScenario {
  return {
    artifact_ttl_seconds: 3600,
    checkpoints: [{
      assertions: [
        { expected: "http://127.0.0.1:3008/issues", kind: "url", operator: "equals" },
        { kind: "dom", selector: "#status", state: "visible", text: { expected: "Runner Ready", operator: "contains" } }
      ],
      id: "home",
      screenshot: "required",
      url: "http://127.0.0.1:3008/issues"
    }],
    contract_version: BROWSER_EVIDENCE_SCENARIO_VERSION,
    id: "browser-smoke",
    name: "Browser smoke",
    timeout_ms: 1000,
    ...overrides
  };
}

function evidenceContext(suffix: string) {
  return {
    audit_event_ref: `xw:audit:browser:${suffix}`,
    collected_at: NOW,
    evidence_id: `xw:evidence:issue_events:667-${suffix}` as const,
    producer: { id: "runner:verification", kind: "runner" as const },
    source_ref: `browser-session:${suffix}`,
    work_id: "xw:work:issues:667" as const
  };
}

function fixtureDriver(capture: BrowserCheckpointCapture): BrowserScenarioDriver {
  return {
    permission: "read",
    provider_id: "fixture-browser",
    async capture(input) {
      return { ...capture, checkpoint_id: input.checkpoint.id };
    }
  };
}

function unavailableConsole() {
  return { available: false, entries: [], error_count: 0, total_count: 0, truncated: false, warning_count: 0 } as const;
}

function unavailableNetwork() {
  return { available: false, entries: [], failed_request_count: 0, http_error_count: 0, max_status: null, total_count: 0, truncated: false } as const;
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}
