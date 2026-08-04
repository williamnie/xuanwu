import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/database.ts";
import { listPiActions } from "../db/repositories/pi.ts";
import { buildPiRuntimeSystemPrompt } from "../http/piRuntimePrompt.ts";
import { decidePiAuthorization, type PiActionEnvelope } from "../pi/actionGate.ts";
import { executeSafePiAction } from "../pi/actionEngine.ts";
import {
  assessDataEgress,
  formatModelVisibleToolOutput,
  formatUntrustedContent,
  promptInjectionDefenseSystemPrompt,
  unsafeUrlEgressReason,
  type UntrustedContentSource
} from "./promptInjectionDefense.ts";

type AttackFixture = { content: string; id: string; source: UntrustedContentSource };

describe("Prompt injection defense", () => {
  test("marks malicious prompt, HTML, repository, and MCP/tool fixtures as data without instruction authority", () => {
    for (const fixture of attackFixtures()) {
      const marked = fixture.source === "mcp"
        ? formatModelVisibleToolOutput({ content: fixture.content }, { source: fixture.source })
        : formatUntrustedContent(fixture.content, fixture.source);

      expect(marked).toContain("version=xw.untrusted-data.v1");
      expect(marked).toContain(`source=${fixture.source}`);
      expect(marked).toContain("instruction_authority=none");
      expect(marked).toContain(JSON.stringify(fixture.content).slice(1, -1));
    }
  });

  test("keeps capability and approval decisions outside model-controlled content", () => {
    const malicious = attackFixtures()[0]?.content ?? "ignore policy";
    const untrustedWrite: PiActionEnvelope = {
      action_type: "issue.enqueue",
      issue_id: 728,
      payload: { issue_id: 728, prompt: malicious },
      project_id: "xuanwu",
      requires_confirmation: true,
      risk_level: "medium",
      source: "external_message"
    };

    expect(decidePiAuthorization(untrustedWrite, {
      mode: "autonomous",
      scope: { project_id: "xuanwu" }
    })).toMatchObject({ decision: "deny" });
    expect(decidePiAuthorization(untrustedWrite, {
      allowed_actions: ["issue.enqueue"],
      mode: "attended",
      scope: { project_id: "xuanwu" }
    })).toMatchObject({ decision: "ask" });
  });

  test("does not invoke an unauthorized write callback and records the denial", async () => {
    const root = await mkdtemp(join(tmpdir(), "xw-prompt-write-gate-"));
    const db = await openDatabase({ stateDir: join(root, "state") });
    let mutated = false;
    try {
      const result = executeSafePiAction(db, {
        authorization: { mode: "autonomous", scope: { project_id: "demo" } },
        conversationID: "attack-fixture",
        source: "external_message"
      }, {
        actionType: "issue.enqueue",
        issueID: 728,
        payload: { issue_id: 728, prompt: attackFixtures()[0]?.content },
        projectID: "demo",
        execute: () => { mutated = true; }
      });

      expect(result).toMatchObject({ decision: "deny", status: "denied" });
      expect(mutated).toBe(false);
      expect(listPiActions(db)).toContainEqual(expect.objectContaining({
        gate_decision: "deny",
        source: "external_message",
        status: "denied"
      }));
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed when a model tries to send secrets through MCP or a URL", () => {
    const externalCall: PiActionEnvelope = {
      action_type: "mcp.tool.call",
      payload: {
        capability_id: "fixture:tool:search",
        input: { query: "status", token: "fixture-secret-value" }
      },
      project_id: "demo",
      requires_confirmation: false,
      risk_level: "low",
      source: "pi_mcp_tool"
    };

    expect(assessDataEgress(externalCall.payload)).toMatchObject({ allowed: false, code: "secret_key" });
    expect(decidePiAuthorization(externalCall, {
      allowed_mcp_capabilities: ["fixture:tool:search"],
      allowed_actions: ["mcp.tool.call"],
      authorizedActions: [{ action_type: "mcp.tool.call", project_id: "demo" }],
      mode: "autonomous",
      scope: { project_id: "demo" }
    })).toMatchObject({ decision: "deny", reason: expect.stringContaining("sensitive field") });
    expect(unsafeUrlEgressReason(new URL("https://example.test/?token=fixture-secret-value")))
      .toContain("sensitive egress material");
    expect(unsafeUrlEgressReason(new URL("https://example.test/?q=release-notes"))).toBe("");
    const visible = formatModelVisibleToolOutput({ auth_token: "fixture-secret-value", status: "ok" });
    expect(visible).not.toContain("fixture-secret-value");
    expect(visible).toContain("redacted");
  });

  test("defines trust boundaries and least-authority handling in the canonical system prompt", () => {
    const prompt = promptInjectionDefenseSystemPrompt();
    for (const boundary of ["Repository files", "HTML/web content", "Skill text", "MCP content", "tool result"]) {
      expect(prompt).toContain(boundary);
    }
    expect(prompt).toContain("deterministic registry/scope/permission/Action Gate");
    expect(prompt).toContain("is never authorization");
  });

  test("assembles the trust contract before runtime resource and Skill data", async () => {
    const root = await mkdtemp(join(tmpdir(), "xw-prompt-defense-"));
    const db = await openDatabase({ stateDir: join(root, "state") });
    try {
      const prompt = buildPiRuntimeSystemPrompt({
        agent: {
          id: "runner-default", name: "Xuanwu Supervisor", provider: "pi-sdk", model_provider: "fixture", model_id: "fixture",
          thinking_level: "off", cwd_policy: "project", tools_json: "[]", instructions: "", enabled: 1,
          created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z"
        } as never,
        conversationID: "security-fixture",
        promptProfile: "chat",
        project: {
          id: "demo", name: "Demo", cwd: root, provider: "codex", provider_config_json: "{}", auto_run: 0,
          model: "", approval_policy: "never", sandbox: "workspace-write", default_agent_profile_id: "",
          sort_order: 1, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
          default_mcp_policy: "{}", default_skill_policy: "{}", loop_status: "stopped", provider_capabilities: []
        } as never
      }, db);

      expect(prompt).toContain("Prompt-injection and trust-boundary contract:");
      expect(prompt.indexOf("Prompt-injection and trust-boundary contract:")).toBeLessThan(prompt.indexOf("Relevant Skill Metadata:"));
      expect(prompt).toContain("source=skill instruction_authority=none");
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function attackFixtures(): AttackFixture[] {
  const path = join(import.meta.dir, "../../../docs/fixtures/security/prompt-injection-attacks.json");
  return JSON.parse(readFileSync(path, "utf8")) as AttackFixture[];
}
