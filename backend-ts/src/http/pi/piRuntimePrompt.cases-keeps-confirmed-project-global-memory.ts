import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../db/database.ts";
import { createPiMemoryItem } from "../../db/repositories/pi.ts";
import { buildPiRuntimeSystemPrompt, xuanwuPiRoleContractPrompt } from "./piRuntimePrompt.ts";
import { ISSUE_PLANNING_POLICY } from "../../pi/issues/issuePlanningPolicy.ts";
import { buildPiRuntimeContextEnvelope, piRuntimeContextEnvelopePrompt } from "../../pi/runtime/runtimeContextEnvelope.ts";
import type { TestFixture } from "./piRuntimePrompt.testFixture.ts";

export function registerKeepsConfirmedProjectGlobalMemoryCases(testScope: TestFixture) {
  const { trackDatabase, withRuntimePrompt, estimatedTokens, agentRecord, projectRecord } = testScope;
  test("keeps confirmed project/global memory scoped away from an old conversation", async () => {
      const root = await mkdtemp(join(tmpdir(), "xuanwu-bun-supervisor-memory-"));
      const db = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
      try {
        createPiMemoryItem(db, {
          content: "Project-level Supervisor preference",
          id: "supervisor-project-memory",
          kind: "preference",
          scope: "project",
          scope_id: "demo"
        });
        createPiMemoryItem(db, {
          content: "Global Supervisor behavior",
          id: "supervisor-global-memory",
          kind: "constraint",
          scope: "global"
        });
        createPiMemoryItem(db, {
          content: "Old chat conversation memory",
          id: "supervisor-old-conversation-memory",
          kind: "conversation_note",
          scope: "conversation",
          scope_id: "feishu-chat-old"
        });
  
        const prompt = buildPiRuntimeSystemPrompt({
          agent: agentRecord(),
          conversationID: "feishu-chat-new",
          promptProfile: "chat",
          project: projectRecord("/tmp/xuanwu-prompt-project")
        }, db);
  
        expect(prompt).toContain("Shared PI runtime context envelope");
        expect(prompt).toContain("Project-level Supervisor preference");
        expect(prompt).toContain("Global Supervisor behavior");
        expect(prompt).not.toContain("Old chat conversation memory");
      } finally {
        db.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  
  test("keeps retrieval diagnostics in the audit envelope without inflating the model prompt", async () => {
      const root = await mkdtemp(join(tmpdir(), "xuanwu-context-diagnostics-"));
      const db = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
      try {
        const envelope = buildPiRuntimeContextEnvelope(db, {
          agent: agentRecord(), conversationID: "diagnostics", promptProfile: "chat",
          project: projectRecord("/tmp/xuanwu-prompt-project")
        });
        const prompt = piRuntimeContextEnvelopePrompt(envelope);
        envelope.durable_context.retrieval.elapsed_ms = 123456.789;
        envelope.durable_context.retrieval.scanned = 999;
        expect(piRuntimeContextEnvelopePrompt(envelope)).toBe(prompt);
        expect(envelope.durable_context.retrieval).toMatchObject({ elapsed_ms: 123456.789, scanned: 999 });
        const projected = JSON.parse(prompt.split("\n")[1]!);
        expect(projected.durable_context.retrieval_scopes).toEqual(envelope.durable_context.retrieval_scopes);
        expect(projected.durable_context.truncation).toEqual(envelope.durable_context.truncation);
        expect(projected.authority_rules).toEqual(envelope.authority_rules);
      } finally {
        db.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  
  test("keeps the static and assembled prompt inside the token-size baseline", async () => {
      const role = xuanwuPiRoleContractPrompt();
      await withRuntimePrompt("token-size", (prompt) => {
        const benchmark = {
          assembled_chars: prompt.length,
          assembled_estimated_tokens: estimatedTokens(prompt),
          planning_estimated_tokens: estimatedTokens(ISSUE_PLANNING_POLICY),
          role_chars: role.length,
          role_estimated_tokens: estimatedTokens(role)
        };
  
        expect(benchmark).toMatchSnapshot();
        expect(benchmark.role_estimated_tokens).toBeLessThanOrEqual(1_000);
        // 保留原有提示词预算，另列共享规范和内部工具适配的固定开销。
        expect(benchmark.planning_estimated_tokens).toBeLessThanOrEqual(2_000);
        expect(benchmark.assembled_estimated_tokens - benchmark.planning_estimated_tokens).toBeLessThanOrEqual(6_500);
      });
    });
}
