import { expect, test } from "bun:test";
import { buildGitHubIssueSyncConfig } from "./issueSyncConfig.ts";
import { classifyGitHubIssue } from "./jevRouting.ts";

function response(confidence = 0.99) {
  const choice = (selected: string, keys: string[]) => ({ type: "choice", choice: selected, confidence,
    probabilities: Object.fromEntries(keys.map(key => [key, key === selected ? 1 : 0])) });
  return { model: "jev-1.13.0", answers: {
    intent: choice("bug_report", ["bug_report", "change_request", "question", "unknown"]),
    information: choice("missing", ["supplied", "missing", "unknown"]),
    message_kind: choice("report", ["report", "supplement", "decision", "revision", "other"])
  } };
}
const input = { stateDir: "/unused", title: "页面错误", body: "打开页面出现异常", resolveKey: async () => "jev-test-credential" };

test("Jev shadow cannot change route, low confidence and outages fall back to PI", async () => {
  const config = buildGitHubIssueSyncConfig({ jev: { mode: "shadow" } }).jev;
  const observed = await classifyGitHubIssue({ ...input, config, fetch: async () => Response.json(response()) });
  expect(observed).toMatchObject({ status: "observed", route: "pi", reason: "shadow_only" });
  const routing = { ...config, mode: "routing" as const };
  expect(await classifyGitHubIssue({ ...input, config: routing, fetch: async () => Response.json(response()) })).toMatchObject({ route: "investigate" });
  expect(await classifyGitHubIssue({ ...input, config: routing, fetch: async () => Response.json(response(0.6)) })).toMatchObject({ route: "pi", reason: "low_confidence" });
  expect(await classifyGitHubIssue({ ...input, config: routing, fetch: async () => { throw new Error("secret credential"); } })).toMatchObject({ status: "fallback", route: "pi", reason: "unavailable_or_invalid" });
});

test("Jev rejects fabricated categories and invalid probability distributions", async () => {
  const config = buildGitHubIssueSyncConfig({ jev: { mode: "routing" } }).jev;
  const invalid = response();
  invalid.answers.intent.choice = "close_issue";
  expect(await classifyGitHubIssue({ ...input, config, fetch: async () => Response.json(invalid) })).toMatchObject({ status: "fallback", route: "pi" });
  invalid.answers.intent.choice = "bug_report";
  invalid.answers.intent.probabilities.bug_report = 0.5;
  expect(await classifyGitHubIssue({ ...input, config, fetch: async () => Response.json(invalid) })).toMatchObject({ status: "fallback" });
});

test("Jev input is bounded and redacted, output contains only hash and typed decisions", async () => {
  const config = buildGitHubIssueSyncConfig({ jev: { mode: "shadow" } }).jev;
  const result = await classifyGitHubIssue({ ...input, body: "secret jev-test-credential " + "x".repeat(15000), config,
    fetch: async (url, init) => {
      expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone");
      expect(String(init?.body)).not.toContain("jev-test-credential");
      expect(JSON.parse(String(init?.body)).state.body.length).toBeLessThanOrEqual(12000);
      expect(init?.redirect).toBe("error");
      return Response.json(response());
    }
  });
  expect(result.status).toBe("observed");
  expect(result.input_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(result)).not.toContain("credential");
});

test("disabled Jev never reads credentials or calls external services", async () => {
  const result = await classifyGitHubIssue({ ...input, config: buildGitHubIssueSyncConfig({}).jev,
    resolveKey: async () => { throw new Error("must not run"); }, fetch: async () => { throw new Error("must not run"); } });
  expect(result).toMatchObject({ status: "disabled", route: "pi" });
});
