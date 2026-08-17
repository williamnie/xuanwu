import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createImInteractionBinding } from "../db/repositories/imInteractionBindings.ts";
import { createImInteractionService } from "./imInteractionService.ts";

const tempRoots: string[] = [];
const bindingSecurity = {
  actions: [{ action_id: "approve", value: "approve" }],
  actor: { id: "u_1", openId: "ou_1" }
};

function callback(interactionId: string, overrides: Record<string, unknown> = {}) {
  return {
    actionId: "approve",
    actor: { id: "u_1", openId: "ou_1" },
    connectorId: "feishu",
    interactionId,
    revision: 1,
    scopeKey: "feishu-chat-oc_1",
    ...overrides
  };
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("generic im interaction service", () => {
  test("executes the business resolver exactly once per binding", async () => {
    const db = await openFixtureDatabase();
    try {
      const binding = createImInteractionBinding(db, {
        ...bindingSecurity,
        actionKind: "approval",
        actionRef: "pi_approval_requests:apr-9",
        connectorId: "feishu",
        expiresAt: "2027-01-01T00:00:00.000Z",
        scopeKey: "feishu-chat-oc_1"
      });
      const calls: string[] = [];
      const service = createImInteractionService({
        database: db,
        resolvers: {
          approval: async ({ binding: resolved }) => {
            calls.push(resolved.action_ref);
            return { ok: true, status: "approved" };
          }
        }
      });
      const first = await service.handle(callback(binding.interaction_id));
      expect(first).toMatchObject({ reason: "consumed", resolution: { ok: true, status: "approved" } });

      // Double click / replay after restart: the resolver never runs again.
      const replay = await service.handle(callback(binding.interaction_id));
      expect(replay.reason).toBe("already_consumed");
      expect(calls).toEqual(["pi_approval_requests:apr-9"]);
    } finally {
      db.close();
    }
  });

  test("recovers an expired resolver lease after a crash without repeating the authoritative side effect", async () => {
    const db = await openFixtureDatabase();
    try {
      const binding = createImInteractionBinding(db, {
        ...bindingSecurity,
        actionKind: "approval",
        actionRef: "pi_approval_requests:apr-recover",
        connectorId: "feishu",
        expiresAt: "2027-01-01T00:00:00.000Z",
        scopeKey: "feishu-chat-oc_1"
      });
      let current = new Date("2026-08-10T00:00:00.000Z");
      let authoritativeSideEffects = 0;
      let authoritativeResolved = false;
      let firstAttempt = true;
      const service = createImInteractionService({
        clock: { now: () => current },
        database: db,
        leaseMs: 1_000,
        resolvers: {
          approval: async () => {
            if (!authoritativeResolved) {
              authoritativeResolved = true;
              authoritativeSideEffects += 1;
            }
            if (firstAttempt) {
              firstAttempt = false;
              throw new Error("process exited after authoritative transition");
            }
            return { ok: true, status: "approved" };
          }
        }
      });

      await expect(service.handle(callback(binding.interaction_id))).rejects.toThrow(/process exited/);
      expect(authoritativeSideEffects).toBe(1);
      expect((await service.handle(callback(binding.interaction_id))).reason).toBe("resolution_in_progress");

      // A restarted process can reclaim only after the bounded lease. The
      // business authority reports its terminal state instead of repeating it.
      current = new Date("2026-08-10T00:00:01.001Z");
      expect(await service.handle(callback(binding.interaction_id))).toMatchObject({
        reason: "consumed",
        resolution: { ok: true, status: "approved" }
      });
      expect(authoritativeSideEffects).toBe(1);
      expect((await service.handle(callback(binding.interaction_id))).reason).toBe("already_consumed");
    } finally {
      db.close();
    }
  });

  test("consumes a deterministic 4xx resolver rejection instead of retrying the provider update forever", async () => {
    const db = await openFixtureDatabase();
    try {
      const binding = createImInteractionBinding(db, {
        ...bindingSecurity,
        actionKind: "pi_action",
        actionRef: "pi_actions:act-invalid-scope",
        connectorId: "feishu",
        expiresAt: "2027-01-01T00:00:00.000Z",
        scopeKey: "feishu-chat-oc_1"
      });
      let calls = 0;
      const service = createImInteractionService({
        database: db,
        resolvers: {
          piAction: async () => {
            calls += 1;
            const error = new Error("Persistent approval requires an installed MCP capability") as Error & { status: number };
            error.status = 409;
            throw error;
          }
        }
      });

      expect(await service.handle(callback(binding.interaction_id))).toMatchObject({
        reason: "consumed",
        resolution: { ok: false, status: "Persistent approval requires an installed MCP capability" }
      });
      expect((await service.handle(callback(binding.interaction_id))).reason).toBe("already_consumed");
      expect(calls).toBe(1);
    } finally {
      db.close();
    }
  });

  test("fails closed on forged tokens, connector mismatch, scope mismatch and expiry", async () => {
    const db = await openFixtureDatabase();
    try {
      const calls: string[] = [];
      const resolver = async () => {
        calls.push("ran");
        return { ok: true, status: "approved" };
      };
      const service = createImInteractionService({
        database: db,
        resolvers: { approval: resolver, piAction: resolver }
      });

      const forged = await service.handle(callback("i1.forged-token"));
      expect(forged.reason).toBe("missing_binding");

      const binding = createImInteractionBinding(db, {
        ...bindingSecurity,
        actionKind: "pi_action",
        actionRef: "pi_actions:act-9",
        connectorId: "feishu",
        expiresAt: "2027-01-01T00:00:00.000Z",
        scopeKey: "feishu-chat-oc_2"
      });
      expect((await service.handle(callback(binding.interaction_id, { connectorId: "telegram" }))).reason).toBe("source_mismatch");
      expect((await service.handle(callback(binding.interaction_id, { scopeKey: "feishu-chat-oc_other" }))).reason).toBe("source_mismatch");
      expect((await service.handle(callback(binding.interaction_id, { actor: { id: "u_other" }, scopeKey: "feishu-chat-oc_2" }))).reason).toBe("actor_mismatch");
      expect((await service.handle(callback(binding.interaction_id, { revision: 2, scopeKey: "feishu-chat-oc_2" }))).reason).toBe("revision_mismatch");
      expect((await service.handle(callback(binding.interaction_id, { actionId: "forged", scopeKey: "feishu-chat-oc_2" }))).reason).toBe("action_mismatch");

      const expired = createImInteractionBinding(db, {
        ...bindingSecurity,
        actionKind: "approval",
        actionRef: "pi_approval_requests:apr-old",
        connectorId: "feishu",
        expiresAt: "2020-01-01T00:00:00.000Z",
        scopeKey: "feishu-chat-oc_2"
      });
      expect((await service.handle(callback(expired.interaction_id, { scopeKey: "feishu-chat-oc_2" }))).reason).toBe("expired");

      const unknownKind = createImInteractionBinding(db, {
        ...bindingSecurity,
        actionKind: "arbitrary.provider.action",
        actionRef: "whatever",
        connectorId: "feishu",
        expiresAt: "2027-01-01T00:00:00.000Z",
        scopeKey: "feishu-chat-oc_2"
      });
      expect((await service.handle(callback(unknownKind.interaction_id, { scopeKey: "feishu-chat-oc_2" }))).reason).toBe("unsupported_action_kind");

      const missingResolver = createImInteractionBinding(db, {
        ...bindingSecurity,
        actionKind: "project_selection",
        actionRef: "im_project_selections:sel-9",
        connectorId: "feishu",
        expiresAt: "2027-01-01T00:00:00.000Z",
        scopeKey: "feishu-chat-oc_2"
      });
      expect((await service.handle(callback(missingResolver.interaction_id, { scopeKey: "feishu-chat-oc_2" }))).reason).toBe("resolver_unavailable");

      expect(calls).toEqual([]);
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "im-interaction-svc-"));
  tempRoots.push(root);
  return openDatabase({ dbPath: join(root, "runner.db"), stateDir: join(root, "state") });
}
