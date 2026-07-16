import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { DomainActor } from "../../xuanwu/coreDomainContracts.ts";
import { callBrowserTool } from "../../pi/browserToolCall.ts";
import {
  BROWSER_READ_PAGE_CONTEXT_TOOL_NAME,
  BROWSER_READONLY_PROVIDER_ID
} from "../../pi/browserToolProvider.ts";
import {
  EVIDENCE_SCHEMA_VERSION,
  redactEvidenceRecord,
  redactEvidenceText,
  validateEvidence,
  type EvidenceArtifactRef,
  type EvidenceID,
  type EvidenceRecord,
  type RunAttemptID,
  type RunID,
  type WorkID
} from "./contracts.ts";

export const BROWSER_EVIDENCE_SCENARIO_VERSION = "xw.browser-evidence-scenario.v1" as const;

export type BrowserUrlAssertion = {
  expected: string;
  kind: "url";
  label?: string;
  operator: "equals" | "origin_equals" | "pathname_equals" | "starts_with";
};

export type BrowserDomAssertion = {
  count?: { operator: "at_least" | "at_most" | "equals"; value: number };
  kind: "dom";
  label?: string;
  selector: string;
  state?: "attached" | "detached" | "hidden" | "visible";
  text?: { expected: string; operator: "contains" | "equals" };
};

export type BrowserEvidenceAssertion = BrowserUrlAssertion | BrowserDomAssertion;

export type BrowserEvidenceCheckpoint = {
  assertions: readonly BrowserEvidenceAssertion[];
  id: string;
  page_id?: string;
  screenshot?: "disabled" | "optional" | "required";
  url?: string;
};

export type BrowserEvidenceScenario = {
  artifact_ttl_seconds: number;
  checkpoints: readonly BrowserEvidenceCheckpoint[];
  console?: {
    fail_on_levels?: ReadonlyArray<"error" | "warning">;
    required?: boolean;
  };
  contract_version: typeof BROWSER_EVIDENCE_SCENARIO_VERSION;
  id: string;
  name: string;
  network?: {
    fail_on_request_failure?: boolean;
    fail_on_status_at_least?: number;
    required?: boolean;
  };
  timeout_ms?: number;
};

export type BrowserDomObservation = {
  count: number;
  selector: string;
  texts: readonly string[];
  visible_count: number;
};

export type BrowserConsoleSummary = {
  available: boolean;
  entries: ReadonlyArray<{ level: "error" | "info" | "log" | "warning"; message: string; source?: string }>;
  error_count: number;
  total_count: number;
  truncated: boolean;
  warning_count: number;
};

export type BrowserNetworkSummary = {
  available: boolean;
  entries: ReadonlyArray<{ method: string; status?: number; url: string; failure?: string }>;
  failed_request_count: number;
  http_error_count: number;
  max_status: number | null;
  total_count: number;
  truncated: boolean;
};

export type BrowserScreenshotObservation = {
  bytes?: Uint8Array;
  captured_at: string;
  height: number;
  image_ref?: string;
  media_type: "image/jpeg" | "image/png" | "image/webp";
  width: number;
};

export type BrowserCheckpointObservation = {
  checkpoint_id: string;
  console: BrowserConsoleSummary;
  dom: readonly BrowserDomObservation[];
  dom_truncated: boolean;
  final_url: string;
  network: BrowserNetworkSummary;
  observed_at: string;
  screenshots: readonly BrowserScreenshotObservation[];
  status: "completed";
};

export type BrowserInconclusiveObservation = {
  checkpoint_id: string;
  message: string;
  observed_at: string;
  reason_code: string;
  status: "inconclusive";
};

export type BrowserCheckpointCapture = BrowserCheckpointObservation | BrowserInconclusiveObservation;

export interface BrowserScenarioDriver {
  capture(input: {
    checkpoint: BrowserEvidenceCheckpoint;
    scenario_id: string;
    timeout_ms: number;
  }): Promise<BrowserCheckpointCapture>;
  permission: "read";
  provider_id: string;
}

export type BrowserEvidenceContext = {
  attempt_id?: RunAttemptID;
  audit_event_ref: string;
  collected_at?: string;
  evidence_id: EvidenceID;
  producer: DomainActor;
  run_id?: RunID;
  source_ref: string;
  work_id: WorkID;
};

export type VerifyBrowserEvidenceInput = {
  artifact_refs?: readonly EvidenceArtifactRef[];
  context: BrowserEvidenceContext;
  scenario: BrowserEvidenceScenario;
};

export type BrowserEvidenceArtifactWrite = {
  audit_event_ref: string;
  content: string;
  evidence_id: EvidenceID;
  expires_at: string;
  report_sha256: string;
  screenshots: readonly BrowserScreenshotObservation[];
  source_ref: string;
};

export type BrowserEvidenceArtifactBundle = {
  report: EvidenceArtifactRef;
  screenshots: readonly EvidenceArtifactRef[];
};

export interface BrowserEvidenceArtifactStore {
  writeBrowserEvidence(
    input: BrowserEvidenceArtifactWrite
  ): Promise<BrowserEvidenceArtifactBundle> | BrowserEvidenceArtifactBundle;
}

export interface BrowserEvidenceVerifier {
  verify(input: VerifyBrowserEvidenceInput): Promise<EvidenceRecord>;
}

export type BrowserEvidenceVerifierOptions = {
  artifact_store: BrowserEvidenceArtifactStore;
  driver?: BrowserScenarioDriver;
  env?: Record<string, string | undefined>;
};

type AssertionResult = {
  checkpoint_id: string;
  id: string;
  kind: "console" | "dom" | "network" | "screenshot" | "url";
  message: string;
  passed: boolean;
};

type InconclusiveReason = { checkpoint_id: string; message: string; reason_code: string };

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 30_000;
const MIN_ARTIFACT_TTL_SECONDS = 60;
const MAX_ARTIFACT_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_CHECKPOINTS = 16;
const MAX_ASSERTIONS = 64;
const MAX_SUMMARY_ENTRIES = 200;
const MAX_SCREENSHOTS = 16;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const MAX_REPORT_BYTES = 1024 * 1024;
const BROWSER_ARTIFACT_ROOT = "uploads/artifacts/evidence-browser";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SENSITIVE_NAME_PATTERN = /(?:authorization|cookie|credential|password|secret|token|api[_-]?key|access[_-]?key)/i;

export function createBrowserToolScenarioDriver(
  env?: Record<string, string | undefined>
): BrowserScenarioDriver {
  return {
    permission: "read",
    provider_id: BROWSER_READONLY_PROVIDER_ID,
    async capture({ checkpoint }) {
      const startedAt = new Date().toISOString();
      const result = await callBrowserTool({
        env,
        input: {
          include_dom_summary: true,
          include_image_ref: checkpoint.screenshot !== "disabled",
          include_screenshot: checkpoint.screenshot !== "disabled",
          include_text: false,
          max_dom_items: 200,
          ...(checkpoint.page_id ? { page_id: checkpoint.page_id } : {}),
          ...(checkpoint.url ? { url: checkpoint.url } : {})
        },
        invocationID: randomUUID(),
        toolName: BROWSER_READ_PAGE_CONTEXT_TOOL_NAME
      });
      if (result.status !== "succeeded") {
        return {
          checkpoint_id: checkpoint.id,
          message: redactEvidenceText(result.error?.message ?? "Browser observation did not complete"),
          observed_at: result.ended_at || startedAt,
          reason_code: result.error?.code ?? "browser_observation_failed",
          status: "inconclusive"
        };
      }
      return browserToolObservation(checkpoint, result.output, result.ended_at || startedAt);
    }
  };
}

export function createBrowserEvidenceVerifier(options: BrowserEvidenceVerifierOptions): BrowserEvidenceVerifier {
  if (!options.artifact_store) throw new Error("Browser Evidence artifact store is required");
  const driver = options.driver ?? createBrowserToolScenarioDriver(options.env);
  if (driver.permission !== "read") throw new Error("Browser Evidence verifier requires a read-only browser driver");
  if (cleanBoundedText(driver.provider_id, 256) !== driver.provider_id) {
    throw new Error("Browser Evidence driver provider_id is invalid");
  }

  return {
    async verify(input) {
      const scenario = validateScenario(input.scenario);
      const timeoutMs = scenario.timeout_ms ?? DEFAULT_TIMEOUT_MS;
      const captures: BrowserCheckpointCapture[] = [];
      for (const checkpoint of scenario.checkpoints) {
        captures.push(await captureWithTimeout(driver, checkpoint, scenario.id, timeoutMs));
      }

      captures.forEach(validateCapture);
      const observations = captures.filter((capture): capture is BrowserCheckpointObservation => capture.status === "completed");
      const inconclusive: InconclusiveReason[] = captures
        .filter((capture): capture is BrowserInconclusiveObservation => capture.status === "inconclusive")
        .map(({ checkpoint_id, message, reason_code }) => ({ checkpoint_id, message, reason_code }));
      const results: AssertionResult[] = [];
      for (const observation of observations) {
        const checkpoint = scenario.checkpoints.find((item) => item.id === observation.checkpoint_id)!;
        const evaluated = evaluateCheckpoint(checkpoint, observation, scenario);
        results.push(...evaluated.results);
        inconclusive.push(...evaluated.inconclusive);
      }

      const failedCount = results.filter((result) => !result.passed).length;
      const status: EvidenceRecord["status"] = failedCount > 0
        ? "failed"
        : inconclusive.length > 0
          ? "blocked"
          : "passed";
      const outcome = status === "blocked" ? "inconclusive" : status;
      const observedAt = normalizedTimestamp(input.context.collected_at ?? new Date().toISOString(), "Evidence collected_at");
      const expiresAt = new Date(Date.parse(observedAt) + scenario.artifact_ttl_seconds * 1000).toISOString();
      const screenshots = observations.flatMap((observation) => observation.screenshots);
      const reportContent = browserReport({
        audit_event_ref: input.context.audit_event_ref,
        captures,
        evidence_id: input.context.evidence_id,
        expires_at: expiresAt,
        inconclusive,
        outcome,
        results,
        scenario,
        source_ref: input.context.source_ref
      });
      const reportSha256 = createHash("sha256").update(reportContent).digest("hex");
      const bundle = await options.artifact_store.writeBrowserEvidence({
        audit_event_ref: input.context.audit_event_ref,
        content: reportContent,
        evidence_id: input.context.evidence_id,
        expires_at: expiresAt,
        report_sha256: reportSha256,
        screenshots,
        source_ref: input.context.source_ref
      });
      if (bundle.report.sha256 !== reportSha256) {
        throw new Error("Browser Evidence report checksum does not match the verified report");
      }
      validateArtifactBundle(bundle, screenshots);

      const passedCount = results.length - failedCount;
      const consoleSummary = aggregateConsole(observations);
      const networkSummary = aggregateNetwork(observations);
      const firstFailure = results.find((result) => !result.passed);
      const firstInconclusive = inconclusive[0];
      const evidence: EvidenceRecord = {
        schema_version: EVIDENCE_SCHEMA_VERSION,
        id: input.context.evidence_id,
        work_id: input.context.work_id,
        ...(input.context.run_id ? { run_id: input.context.run_id } : {}),
        ...(input.context.attempt_id ? { attempt_id: input.context.attempt_id } : {}),
        revision: 0,
        kind: "browser",
        status,
        created_at: observedAt,
        observed_at: observedAt,
        updated_at: observedAt,
        completed_at: observedAt,
        decisive_output: {
          summary: outcomeSummary(scenario, status, results, inconclusive),
          ...((firstFailure?.message ?? firstInconclusive?.message)
            ? { excerpt: boundedText(redactEvidenceText(firstFailure?.message ?? firstInconclusive!.message), 4096) }
            : {}),
          facts: {
            artifact_expires_at: expiresAt,
            artifact_ttl_seconds: scenario.artifact_ttl_seconds,
            assertion_count: results.length,
            browser_provider_id: driver.provider_id,
            checkpoint_count: scenario.checkpoints.length,
            completed_checkpoint_count: observations.length,
            console_available: consoleSummary.available,
            console_error_count: consoleSummary.error_count,
            console_total_count: consoleSummary.total_count,
            failed_assertion_count: failedCount,
            final_url: observations[0] ? redactEvidenceText(observations[0].final_url) : null,
            inconclusive_count: inconclusive.length,
            inconclusive_reason: firstInconclusive?.reason_code ?? null,
            network_available: networkSummary.available,
            network_failed_request_count: networkSummary.failed_request_count,
            network_http_error_count: networkSummary.http_error_count,
            network_total_count: networkSummary.total_count,
            outcome,
            passed_assertion_count: passedCount,
            report_sha256: reportSha256,
            scenario_contract_version: BROWSER_EVIDENCE_SCENARIO_VERSION,
            scenario_id: scenario.id,
            screenshot_artifact_count: bundle.screenshots.length,
            screenshot_count: screenshots.length
          }
        },
        artifact_refs: uniqueArtifactRefs([
          ...(input.artifact_refs ?? []),
          bundle.report,
          ...bundle.screenshots
        ]),
        provenance: {
          assertion_origin: "system_observation",
          source_kind: "browser_session",
          source_ref: input.context.source_ref,
          audit_event_ref: input.context.audit_event_ref,
          producer: input.context.producer
        },
        redaction: {
          status: "not_required",
          policy_ref: "evidence-browser-redaction:v1",
          redacted_paths: []
        }
      };
      const redacted = redactEvidenceRecord(evidence, "evidence-browser-redaction:v1");
      const validation = validateEvidence(redacted);
      if (!validation.ok) throw new Error(`Browser verifier produced invalid Evidence: ${validation.errors.join("; ")}`);
      return redacted;
    }
  };
}

export function evaluateBrowserArtifactFreshness(
  evidence: EvidenceRecord,
  at: string
): { current: boolean; expires_at: string | null; reason: string } {
  normalizedTimestamp(at, "Browser artifact freshness timestamp");
  if (evidence.kind !== "browser") return { current: false, expires_at: null, reason: "not_browser_evidence" };
  const expiresAt = evidence.decisive_output.facts.artifact_expires_at;
  if (typeof expiresAt !== "string") return { current: false, expires_at: null, reason: "missing_expiry" };
  normalizedTimestamp(expiresAt, "Browser artifact expires_at");
  if (evidence.artifact_refs.length === 0) return { current: false, expires_at: expiresAt, reason: "missing_artifacts" };
  return Date.parse(at) < Date.parse(expiresAt)
    ? { current: true, expires_at: expiresAt, reason: "current" }
    : { current: false, expires_at: expiresAt, reason: "expired" };
}

export class FileSystemBrowserEvidenceArtifactStore implements BrowserEvidenceArtifactStore {
  constructor(private readonly stateDir: string) {
    if (stateDir.trim() === "") throw new Error("Browser Evidence artifact state directory is required");
  }

  writeBrowserEvidence(input: BrowserEvidenceArtifactWrite): BrowserEvidenceArtifactBundle {
    const reportBytes = Buffer.from(input.content);
    const reportSha256 = createHash("sha256").update(reportBytes).digest("hex");
    if (reportSha256 !== input.report_sha256) throw new Error("Browser Evidence report content does not match its digest");
    if (reportBytes.byteLength > MAX_REPORT_BYTES) throw new Error(`Browser Evidence report exceeds ${MAX_REPORT_BYTES} bytes`);
    normalizedTimestamp(input.expires_at, "Browser Evidence artifact expires_at");
    const bundleRef = `${BROWSER_ARTIFACT_ROOT}/${reportSha256.slice(0, 2)}/${reportSha256}`;
    const bundlePath = this.artifactPath(bundleRef);
    const reportRef = `${bundleRef}/report.json`;
    const screenshotRefs = input.screenshots.map((screenshot, index) =>
      screenshotArtifactRef(bundleRef, screenshot, index)
    );
    if (!existsSync(bundlePath)) {
      mkdirSync(dirname(bundlePath), { recursive: true, mode: 0o700 });
      const temporary = `${bundlePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        mkdirSync(temporary, { mode: 0o700 });
        writeFileSync(resolve(temporary, "report.json"), reportBytes, { flag: "wx", mode: 0o600 });
        input.screenshots.forEach((screenshot, index) => {
          if (!screenshot.bytes) return;
          const ref = screenshotRefs[index];
          writeFileSync(resolve(temporary, ref.ref.slice(bundleRef.length + 1)), screenshot.bytes, { flag: "wx", mode: 0o600 });
        });
        renameSync(temporary, bundlePath);
      } finally {
        rmSync(temporary, { force: true, recursive: true });
      }
    } else {
      const existing = readFileSync(this.artifactPath(reportRef));
      if (createHash("sha256").update(existing).digest("hex") !== reportSha256) {
        throw new Error("Existing Browser Evidence report does not match its content-addressed ref");
      }
    }
    return {
      report: {
        kind: "report",
        label: `Browser Evidence scenario report; expires ${input.expires_at}`,
        media_type: "application/json",
        ref: reportRef,
        sha256: reportSha256
      },
      screenshots: screenshotRefs
    };
  }

  private artifactPath(ref: string): string {
    if (!new RegExp(`^${BROWSER_ARTIFACT_ROOT}/[a-f0-9]{2}/[a-f0-9]{64}(?:/(?:report\\.json|[0-9]+-[a-f0-9]{64}\\.(?:png|jpg|webp)))?$`).test(ref)) {
      throw new Error("invalid Browser Evidence artifact ref");
    }
    const root = resolve(this.stateDir, BROWSER_ARTIFACT_ROOT);
    const path = resolve(this.stateDir, ref);
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      throw new Error("Browser Evidence artifact ref escapes state directory");
    }
    return path;
  }
}

async function captureWithTimeout(
  driver: BrowserScenarioDriver,
  checkpoint: BrowserEvidenceCheckpoint,
  scenarioID: string,
  timeoutMs: number
): Promise<BrowserCheckpointCapture> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      driver.capture({ checkpoint, scenario_id: scenarioID, timeout_ms: timeoutMs }),
      new Promise<BrowserInconclusiveObservation>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout({
          checkpoint_id: checkpoint.id,
          message: `Browser checkpoint exceeded ${timeoutMs}ms`,
          observed_at: new Date().toISOString(),
          reason_code: "browser_timeout",
          status: "inconclusive"
        }), timeoutMs);
      })
    ]);
  } catch (error) {
    return {
      checkpoint_id: checkpoint.id,
      message: redactEvidenceText(error instanceof Error ? error.message : "Browser driver failed"),
      observed_at: new Date().toISOString(),
      reason_code: "browser_driver_error",
      status: "inconclusive"
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function browserToolObservation(
  checkpoint: BrowserEvidenceCheckpoint,
  output: unknown,
  observedAt: string
): BrowserCheckpointObservation {
  const page = recordValue(recordValue(output).page);
  const screenshot = recordValue(page.screenshot);
  const dom = mergeDomObservations(Array.isArray(page.dom_summary)
    ? page.dom_summary.map(domSummaryItem).filter((item): item is BrowserDomObservation => item !== null)
    : []);
  const screenshots: BrowserScreenshotObservation[] = [];
  const imageRef = cleanText(screenshot.image_ref);
  if (imageRef !== "") {
    screenshots.push({
      captured_at: validTimestampOr(cleanText(screenshot.captured_at), observedAt),
      height: positiveInteger(screenshot.height),
      image_ref: imageRef,
      media_type: screenshotMediaType(screenshot.mime_type),
      width: positiveInteger(screenshot.width)
    });
  }
  return {
    checkpoint_id: checkpoint.id,
    console: unavailableConsoleSummary(),
    dom,
    dom_truncated: page.dom_truncated === true,
    final_url: cleanText(page.url),
    network: unavailableNetworkSummary(),
    observed_at: observedAt,
    screenshots,
    status: "completed"
  };
}

function domSummaryItem(value: unknown): BrowserDomObservation | null {
  let item = recordValue(value);
  if (typeof value === "string") {
    try { item = recordValue(JSON.parse(value)); } catch { return null; }
  }
  const selector = cleanText(item.selector);
  if (selector === "") return null;
  const count = nonNegativeInteger(item.count, 1);
  const visibleCount = nonNegativeInteger(item.visible_count, item.visible === false ? 0 : count);
  const texts = Array.isArray(item.texts)
    ? item.texts.map(cleanText).filter(Boolean)
    : cleanText(item.text) === "" ? [] : [cleanText(item.text)];
  return { count, selector, texts, visible_count: Math.min(count, visibleCount) };
}

function mergeDomObservations(items: readonly BrowserDomObservation[]): BrowserDomObservation[] {
  const merged = new Map<string, BrowserDomObservation>();
  for (const item of items) {
    const current = merged.get(item.selector);
    merged.set(item.selector, current ? {
      count: current.count + item.count,
      selector: item.selector,
      texts: [...current.texts, ...item.texts].slice(0, 32),
      visible_count: current.visible_count + item.visible_count
    } : { ...item, texts: [...item.texts] });
  }
  return [...merged.values()];
}

function evaluateCheckpoint(
  checkpoint: BrowserEvidenceCheckpoint,
  observation: BrowserCheckpointObservation,
  scenario: BrowserEvidenceScenario
): { inconclusive: InconclusiveReason[]; results: AssertionResult[] } {
  const results: AssertionResult[] = [];
  const inconclusive: InconclusiveReason[] = [];
  checkpoint.assertions.forEach((assertion, index) => {
    if (assertion.kind === "url") {
      results.push(evaluateUrlAssertion(checkpoint.id, assertion, observation.final_url, index));
      return;
    }
    const dom = observation.dom.find((item) => item.selector === assertion.selector);
    if (!dom && observation.dom_truncated) {
      inconclusive.push({
        checkpoint_id: checkpoint.id,
        message: `DOM summary was truncated before selector ${assertion.selector} could be proven`,
        reason_code: "dom_observation_truncated"
      });
      return;
    }
    results.push(evaluateDomAssertion(checkpoint.id, assertion, dom ?? {
      count: 0,
      selector: assertion.selector,
      texts: [],
      visible_count: 0
    }, index));
  });

  const screenshotMode = checkpoint.screenshot ?? "optional";
  if (screenshotMode !== "disabled") {
    const passed = observation.screenshots.length > 0;
    if (screenshotMode === "required" || passed) {
      results.push({
        checkpoint_id: checkpoint.id,
        id: `${checkpoint.id}:screenshot`,
        kind: "screenshot",
        message: passed ? "Screenshot is associated with the checkpoint" : "Required screenshot is missing",
        passed
      });
    }
  }

  evaluateConsole(checkpoint.id, observation.console, scenario.console, results, inconclusive);
  evaluateNetwork(checkpoint.id, observation.network, scenario.network, results, inconclusive);
  return { inconclusive, results };
}

function evaluateUrlAssertion(
  checkpointID: string,
  assertion: BrowserUrlAssertion,
  finalUrl: string,
  index: number
): AssertionResult {
  let passed = false;
  try {
    const actual = new URL(finalUrl);
    if (assertion.operator === "equals") passed = actual.toString() === new URL(assertion.expected).toString();
    if (assertion.operator === "starts_with") passed = actual.toString().startsWith(assertion.expected);
    if (assertion.operator === "origin_equals") passed = actual.origin === new URL(assertion.expected).origin;
    if (assertion.operator === "pathname_equals") passed = actual.pathname === assertion.expected;
  } catch {
    passed = false;
  }
  return {
    checkpoint_id: checkpointID,
    id: assertionID(checkpointID, assertion.label, "url", index),
    kind: "url",
    message: passed
      ? `URL assertion ${assertion.operator} passed`
      : redactEvidenceText(`URL assertion ${assertion.operator} expected ${assertion.expected} but observed ${finalUrl || "[missing]"}`),
    passed
  };
}

function evaluateDomAssertion(
  checkpointID: string,
  assertion: BrowserDomAssertion,
  observation: BrowserDomObservation,
  index: number
): AssertionResult {
  const state = assertion.state ?? "visible";
  const statePassed = state === "attached" ? observation.count > 0
    : state === "detached" ? observation.count === 0
      : state === "hidden" ? observation.count > 0 && observation.visible_count === 0
        : observation.visible_count > 0;
  const countPassed = !assertion.count || assertion.count.operator === "equals"
    ? !assertion.count || observation.count === assertion.count.value
    : assertion.count.operator === "at_least"
      ? observation.count >= assertion.count.value
      : observation.count <= assertion.count.value;
  const textPassed = !assertion.text || observation.texts.some((text) =>
    assertion.text!.operator === "equals" ? text === assertion.text!.expected : text.includes(assertion.text!.expected)
  );
  const passed = statePassed && countPassed && textPassed;
  return {
    checkpoint_id: checkpointID,
    id: assertionID(checkpointID, assertion.label, "dom", index),
    kind: "dom",
    message: passed
      ? `DOM assertion passed for ${assertion.selector}`
      : redactEvidenceText(
        `DOM assertion failed for ${assertion.selector}: state=${state}, count=${observation.count}, visible=${observation.visible_count}`
      ),
    passed
  };
}

function evaluateConsole(
  checkpointID: string,
  summary: BrowserConsoleSummary,
  policy: BrowserEvidenceScenario["console"],
  results: AssertionResult[],
  inconclusive: InconclusiveReason[]
): void {
  if (!summary.available) {
    if (policy?.required || (policy?.fail_on_levels?.length ?? 0) > 0) inconclusive.push({
      checkpoint_id: checkpointID,
      message: "Browser console summary is unavailable",
      reason_code: "console_summary_unavailable"
    });
    return;
  }
  const levels = policy?.fail_on_levels ?? [];
  if (levels.length === 0) return;
  const failures = (levels.includes("error") ? summary.error_count : 0) +
    (levels.includes("warning") ? summary.warning_count : 0);
  results.push({
    checkpoint_id: checkpointID,
    id: `${checkpointID}:console`,
    kind: "console",
    message: failures === 0 ? "Console summary satisfied policy" : `Console summary contains ${failures} denied entries`,
    passed: failures === 0
  });
}

function evaluateNetwork(
  checkpointID: string,
  summary: BrowserNetworkSummary,
  policy: BrowserEvidenceScenario["network"],
  results: AssertionResult[],
  inconclusive: InconclusiveReason[]
): void {
  if (!summary.available) {
    if (policy?.required || policy?.fail_on_request_failure === true || policy?.fail_on_status_at_least !== undefined) inconclusive.push({
      checkpoint_id: checkpointID,
      message: "Browser network summary is unavailable",
      reason_code: "network_summary_unavailable"
    });
    return;
  }
  const failedRequestDenied = policy?.fail_on_request_failure === true && summary.failed_request_count > 0;
  const statusDenied = policy?.fail_on_status_at_least !== undefined &&
    summary.max_status !== null && summary.max_status >= policy.fail_on_status_at_least;
  if (policy?.fail_on_request_failure !== true && policy?.fail_on_status_at_least === undefined) return;
  results.push({
    checkpoint_id: checkpointID,
    id: `${checkpointID}:network`,
    kind: "network",
    message: failedRequestDenied || statusDenied
      ? `Network summary violates policy: failed_requests=${summary.failed_request_count}, max_status=${summary.max_status ?? "none"}`
      : "Network summary satisfied policy",
    passed: !failedRequestDenied && !statusDenied
  });
}

function validateScenario(input: BrowserEvidenceScenario): BrowserEvidenceScenario {
  if (!input || typeof input !== "object") throw new Error("Browser Evidence scenario is required");
  if (input.contract_version !== BROWSER_EVIDENCE_SCENARIO_VERSION) throw new Error("Unsupported Browser Evidence scenario contract");
  if (!ID_PATTERN.test(input.id)) throw new Error("Browser Evidence scenario id is invalid");
  if (cleanBoundedText(input.name, 256) !== input.name) throw new Error("Browser Evidence scenario name is invalid");
  boundedInteger(input.artifact_ttl_seconds, MIN_ARTIFACT_TTL_SECONDS, MAX_ARTIFACT_TTL_SECONDS, "artifact_ttl_seconds");
  if (!Array.isArray(input.checkpoints) || input.checkpoints.length === 0 || input.checkpoints.length > MAX_CHECKPOINTS) {
    throw new Error(`Browser Evidence scenario requires between 1 and ${MAX_CHECKPOINTS} checkpoints`);
  }
  const checkpointIDs = new Set<string>();
  let assertionCount = 0;
  input.checkpoints.forEach((checkpoint, checkpointIndex) => {
    if (!ID_PATTERN.test(checkpoint.id) || checkpointIDs.has(checkpoint.id)) throw new Error(`Browser checkpoint ${checkpointIndex} id is invalid or duplicated`);
    checkpointIDs.add(checkpoint.id);
    if (checkpoint.page_id !== undefined && cleanBoundedText(checkpoint.page_id, 512) !== checkpoint.page_id) throw new Error(`Browser checkpoint ${checkpoint.id} page_id is invalid`);
    if (checkpoint.url !== undefined) normalizedHttpUrl(checkpoint.url, `Browser checkpoint ${checkpoint.id} url`);
    if (!Array.isArray(checkpoint.assertions) || checkpoint.assertions.length === 0) throw new Error(`Browser checkpoint ${checkpoint.id} requires assertions`);
    assertionCount += checkpoint.assertions.length;
    checkpoint.assertions.forEach((assertion: BrowserEvidenceAssertion, index: number) =>
      validateAssertion(assertion, checkpoint.id, index)
    );
    if (checkpoint.screenshot !== undefined && !["disabled", "optional", "required"].includes(checkpoint.screenshot)) throw new Error(`Browser checkpoint ${checkpoint.id} screenshot mode is invalid`);
  });
  if (assertionCount > MAX_ASSERTIONS) throw new Error(`Browser Evidence scenario exceeds ${MAX_ASSERTIONS} assertions`);
  boundedInteger(input.timeout_ms ?? DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS, "timeout_ms");
  const levels = input.console?.fail_on_levels ?? [];
  if (levels.some((level) => !["error", "warning"].includes(level))) throw new Error("Browser console policy has an invalid level");
  if (input.network?.fail_on_status_at_least !== undefined) {
    boundedInteger(input.network.fail_on_status_at_least, 400, 599, "network fail_on_status_at_least");
  }
  return input;
}

function validateAssertion(assertion: BrowserEvidenceAssertion, checkpointID: string, index: number): void {
  if (!assertion || typeof assertion !== "object") throw new Error(`Browser assertion ${checkpointID}:${index} is invalid`);
  if (assertion.label !== undefined && cleanBoundedText(assertion.label, 128) !== assertion.label) throw new Error(`Browser assertion ${checkpointID}:${index} label is invalid`);
  if (assertion.kind === "url") {
    if (!["equals", "origin_equals", "pathname_equals", "starts_with"].includes(assertion.operator)) throw new Error(`Browser URL assertion ${checkpointID}:${index} operator is invalid`);
    if (assertion.operator === "pathname_equals") {
      if (!assertion.expected.startsWith("/") || assertion.expected.length > 2048) throw new Error(`Browser URL assertion ${checkpointID}:${index} pathname is invalid`);
    } else if (assertion.operator === "starts_with") {
      if (!/^https?:\/\//.test(assertion.expected) || assertion.expected.length > 4096) throw new Error(`Browser URL assertion ${checkpointID}:${index} prefix is invalid`);
    } else {
      normalizedHttpUrl(assertion.expected, `Browser URL assertion ${checkpointID}:${index} expected`);
    }
    return;
  }
  if (assertion.kind !== "dom") throw new Error(`Browser assertion ${checkpointID}:${index} kind is unsupported`);
  if (cleanBoundedText(assertion.selector, 512) !== assertion.selector) throw new Error(`Browser DOM assertion ${checkpointID}:${index} selector is invalid`);
  if (assertion.state !== undefined && !["attached", "detached", "hidden", "visible"].includes(assertion.state)) throw new Error(`Browser DOM assertion ${checkpointID}:${index} state is invalid`);
  if (assertion.count) boundedInteger(assertion.count.value, 0, 100_000, `Browser DOM assertion ${checkpointID}:${index} count`);
  if (assertion.count && !["at_least", "at_most", "equals"].includes(assertion.count.operator)) throw new Error(`Browser DOM assertion ${checkpointID}:${index} count operator is invalid`);
  if (assertion.text && cleanBoundedText(assertion.text.expected, 4096) !== assertion.text.expected) throw new Error(`Browser DOM assertion ${checkpointID}:${index} text is invalid`);
  if (assertion.text && !["contains", "equals"].includes(assertion.text.operator)) throw new Error(`Browser DOM assertion ${checkpointID}:${index} text operator is invalid`);
}

function validateObservation(observation: BrowserCheckpointObservation): void {
  normalizedTimestamp(observation.observed_at, "Browser observation observed_at");
  normalizedHttpUrl(observation.final_url, "Browser observation final_url");
  if (observation.dom.length > MAX_SUMMARY_ENTRIES) throw new Error(`Browser DOM observation exceeds ${MAX_SUMMARY_ENTRIES} entries`);
  const selectors = new Set<string>();
  for (const item of observation.dom) {
    if (cleanBoundedText(item.selector, 512) !== item.selector || selectors.has(item.selector)) throw new Error("Browser DOM observation selector is invalid or duplicated");
    selectors.add(item.selector);
    boundedInteger(item.count, 0, 100_000, "Browser DOM observation count");
    boundedInteger(item.visible_count, 0, item.count, "Browser DOM observation visible_count");
    if (item.texts.length > 32 || item.texts.some((text) => cleanBoundedText(text, 4096) !== text)) throw new Error("Browser DOM observation text is invalid or oversized");
  }
  validateConsoleSummary(observation.console);
  validateNetworkSummary(observation.network);
  if (observation.screenshots.length > MAX_SCREENSHOTS) throw new Error(`Browser observation exceeds ${MAX_SCREENSHOTS} screenshots`);
  observation.screenshots.forEach(validateScreenshot);
}

function validateCapture(capture: BrowserCheckpointCapture): void {
  if (!ID_PATTERN.test(capture.checkpoint_id)) throw new Error("Browser capture checkpoint_id is invalid");
  normalizedTimestamp(capture.observed_at, "Browser capture observed_at");
  if (capture.status === "completed") {
    validateObservation(capture);
    return;
  }
  if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(capture.reason_code)) throw new Error("Browser inconclusive reason_code is invalid");
  if (cleanBoundedText(capture.message, 4096) !== capture.message) throw new Error("Browser inconclusive message is invalid");
}

function validateConsoleSummary(summary: BrowserConsoleSummary): void {
  if (summary.entries.length > MAX_SUMMARY_ENTRIES) throw new Error(`Browser console summary exceeds ${MAX_SUMMARY_ENTRIES} entries`);
  [summary.error_count, summary.total_count, summary.warning_count].forEach((value) => boundedInteger(value, 0, 1_000_000, "Browser console count"));
  if (summary.error_count + summary.warning_count > summary.total_count) throw new Error("Browser console summary counts are inconsistent");
  summary.entries.forEach((entry) => {
    if (!["error", "info", "log", "warning"].includes(entry.level) || cleanBoundedText(entry.message, 4096) !== entry.message) throw new Error("Browser console entry is invalid");
  });
}

function validateNetworkSummary(summary: BrowserNetworkSummary): void {
  if (summary.entries.length > MAX_SUMMARY_ENTRIES) throw new Error(`Browser network summary exceeds ${MAX_SUMMARY_ENTRIES} entries`);
  [summary.failed_request_count, summary.http_error_count, summary.total_count].forEach((value) => boundedInteger(value, 0, 1_000_000, "Browser network count"));
  if (summary.failed_request_count + summary.http_error_count > summary.total_count) throw new Error("Browser network summary counts are inconsistent");
  if (summary.max_status !== null) boundedInteger(summary.max_status, 100, 599, "Browser network max_status");
  summary.entries.forEach((entry) => {
    if (!/^[A-Z]+$/.test(entry.method) || entry.method.length > 16) throw new Error("Browser network entry method is invalid");
    normalizedHttpUrl(entry.url, "Browser network entry url");
    if (entry.status !== undefined) boundedInteger(entry.status, 100, 599, "Browser network entry status");
    if (entry.failure !== undefined && cleanBoundedText(entry.failure, 4096) !== entry.failure) throw new Error("Browser network entry failure is invalid");
  });
}

function validateScreenshot(screenshot: BrowserScreenshotObservation): void {
  normalizedTimestamp(screenshot.captured_at, "Browser screenshot captured_at");
  boundedInteger(screenshot.width, 1, 32_768, "Browser screenshot width");
  boundedInteger(screenshot.height, 1, 32_768, "Browser screenshot height");
  if (!screenshot.bytes && cleanBoundedText(screenshot.image_ref, 4096) === "") throw new Error("Browser screenshot requires bytes or image_ref");
  if (screenshot.bytes && screenshot.bytes.byteLength > MAX_SCREENSHOT_BYTES) throw new Error(`Browser screenshot exceeds ${MAX_SCREENSHOT_BYTES} bytes`);
  if (!["image/jpeg", "image/png", "image/webp"].includes(screenshot.media_type)) throw new Error("Browser screenshot media type is invalid");
  if (screenshot.bytes && detectedImageMediaType(screenshot.bytes) !== screenshot.media_type) {
    throw new Error("Browser screenshot bytes do not match the declared media type");
  }
}

function browserReport(input: {
  audit_event_ref: string;
  captures: readonly BrowserCheckpointCapture[];
  evidence_id: EvidenceID;
  expires_at: string;
  inconclusive: readonly InconclusiveReason[];
  outcome: string;
  results: readonly AssertionResult[];
  scenario: BrowserEvidenceScenario;
  source_ref: string;
}): string {
  const captures = input.captures.map((capture) => capture.status === "inconclusive" ? capture : {
    ...capture,
    screenshots: capture.screenshots.map(({ bytes, ...screenshot }) => ({
      ...screenshot,
      bytes: bytes?.byteLength ?? 0,
      sha256: bytes ? createHash("sha256").update(bytes).digest("hex") : null
    }))
  });
  const sanitized = sanitizeArtifactValue({
    schema_version: 1,
    audit_event_ref: input.audit_event_ref,
    evidence_id: input.evidence_id,
    scenario: input.scenario,
    source_ref: input.source_ref,
    expires_at: input.expires_at,
    outcome: input.outcome,
    captures,
    assertions: input.results,
    inconclusive: input.inconclusive,
    redaction: { policy_ref: "evidence-browser-redaction:v1" }
  });
  const content = `${JSON.stringify(sanitized)}\n`;
  if (Buffer.byteLength(content) > MAX_REPORT_BYTES) throw new Error(`Browser Evidence report exceeds ${MAX_REPORT_BYTES} bytes`);
  return content;
}

function validateArtifactBundle(
  bundle: BrowserEvidenceArtifactBundle,
  screenshots: readonly BrowserScreenshotObservation[]
): void {
  if (bundle.report.kind !== "report" || bundle.report.media_type !== "application/json") {
    throw new Error("Browser Evidence artifact store returned an invalid report ref");
  }
  if (bundle.screenshots.length !== screenshots.length) {
    throw new Error("Browser Evidence artifact store did not associate every screenshot");
  }
  screenshots.forEach((screenshot, index) => {
    const artifact = bundle.screenshots[index];
    if (artifact.kind !== "screenshot" || artifact.media_type !== screenshot.media_type) {
      throw new Error(`Browser Evidence screenshot artifact ${index} metadata does not match the observation`);
    }
    if (screenshot.bytes) {
      const sha256 = createHash("sha256").update(screenshot.bytes).digest("hex");
      if (artifact.sha256 !== sha256) throw new Error(`Browser Evidence screenshot artifact ${index} checksum does not match`);
    } else if (artifact.ref !== redactEvidenceText(screenshot.image_ref!)) {
      throw new Error(`Browser Evidence screenshot artifact ${index} ref does not match the observation`);
    }
  });
}

function sanitizeArtifactValue(value: unknown, key = ""): unknown {
  if (key !== "" && SENSITIVE_NAME_PATTERN.test(key)) return "[redacted]";
  if (typeof value === "string") return redactEvidenceText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeArtifactValue(item));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
    childKey,
    sanitizeArtifactValue(child, childKey)
  ]));
}

function screenshotArtifactRef(
  bundleRef: string,
  screenshot: BrowserScreenshotObservation,
  index: number
): EvidenceArtifactRef {
  if (!screenshot.bytes) {
    return {
      kind: "screenshot",
      label: `Browser screenshot captured ${screenshot.captured_at}`,
      media_type: screenshot.media_type,
      ref: redactEvidenceText(screenshot.image_ref!)
    };
  }
  const sha256 = createHash("sha256").update(screenshot.bytes).digest("hex");
  const extension = screenshot.media_type === "image/png" ? "png" : screenshot.media_type === "image/jpeg" ? "jpg" : "webp";
  return {
    kind: "screenshot",
    label: `Browser screenshot captured ${screenshot.captured_at}`,
    media_type: screenshot.media_type,
    ref: `${bundleRef}/${index}-${sha256}.${extension}`,
    sha256
  };
}

function outcomeSummary(
  scenario: BrowserEvidenceScenario,
  status: EvidenceRecord["status"],
  results: readonly AssertionResult[],
  inconclusive: readonly InconclusiveReason[]
): string {
  const passed = results.filter((result) => result.passed).length;
  if (status === "blocked") {
    return redactEvidenceText(`Browser verification inconclusive for ${scenario.id}: ${inconclusive[0]?.reason_code ?? "insufficient_observation"}`);
  }
  if (status === "failed") {
    const failed = results.find((result) => !result.passed)!;
    return redactEvidenceText(`Browser verification failed for ${scenario.id}: ${failed.id}: ${failed.message}`);
  }
  return `Browser verification passed for ${scenario.id}: ${passed}/${results.length} assertions passed`;
}

function aggregateConsole(observations: readonly BrowserCheckpointObservation[]): BrowserConsoleSummary {
  const available = observations.length > 0 && observations.every((item) => item.console.available);
  return {
    available,
    entries: observations.flatMap((item) => item.console.entries).slice(0, MAX_SUMMARY_ENTRIES),
    error_count: observations.reduce((sum, item) => sum + item.console.error_count, 0),
    total_count: observations.reduce((sum, item) => sum + item.console.total_count, 0),
    truncated: observations.some((item) => item.console.truncated),
    warning_count: observations.reduce((sum, item) => sum + item.console.warning_count, 0)
  };
}

function aggregateNetwork(observations: readonly BrowserCheckpointObservation[]): BrowserNetworkSummary {
  const statuses = observations
    .map((item) => item.network.max_status)
    .filter((status): status is number => status !== null);
  return {
    available: observations.length > 0 && observations.every((item) => item.network.available),
    entries: observations.flatMap((item) => item.network.entries).slice(0, MAX_SUMMARY_ENTRIES),
    failed_request_count: observations.reduce((sum, item) => sum + item.network.failed_request_count, 0),
    http_error_count: observations.reduce((sum, item) => sum + item.network.http_error_count, 0),
    max_status: statuses.length > 0 ? Math.max(...statuses) : null,
    total_count: observations.reduce((sum, item) => sum + item.network.total_count, 0),
    truncated: observations.some((item) => item.network.truncated)
  };
}

function unavailableConsoleSummary(): BrowserConsoleSummary {
  return { available: false, entries: [], error_count: 0, total_count: 0, truncated: false, warning_count: 0 };
}

function unavailableNetworkSummary(): BrowserNetworkSummary {
  return { available: false, entries: [], failed_request_count: 0, http_error_count: 0, max_status: null, total_count: 0, truncated: false };
}

function screenshotMediaType(value: unknown): BrowserScreenshotObservation["media_type"] {
  return value === "image/jpeg" || value === "image/webp" ? value : "image/png";
}

function detectedImageMediaType(bytes: Uint8Array): BrowserScreenshotObservation["media_type"] | "" {
  const buffer = Buffer.from(bytes);
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  if (buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP") return "image/webp";
  return "";
}

function assertionID(checkpointID: string, label: string | undefined, kind: string, index: number): string {
  return `${checkpointID}:${label?.trim() || `${kind}-${index + 1}`}`;
}

function validTimestampOr(value: string, fallback: string): string {
  try { return normalizedTimestamp(value, "timestamp"); } catch { return fallback; }
}

function normalizedHttpUrl(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) throw new Error(`${label} is required and must be bounded`);
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username !== "" || url.password !== "") throw new Error();
    return url.toString();
  } catch {
    throw new Error(`${label} must be a valid http or https URL without userinfo`);
  }
}

function normalizedTimestamp(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(`${label} must be an ISO timestamp`);
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return Number(value);
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function positiveInteger(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : 0;
}

function cleanBoundedText(value: unknown, maximum: number): string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= maximum ? value : "";
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function boundedText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(1, maximum - 1))}…`;
}

function uniqueArtifactRefs(values: readonly EvidenceArtifactRef[]): EvidenceArtifactRef[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value.ref)) return false;
    seen.add(value.ref);
    return true;
  }).map((value) => ({ ...value }));
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
