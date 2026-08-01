import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../database.ts";
import { getPiPersona, listPiActionEvents, updatePiPersona } from "../../repositories/pi.ts";

describe("Supervisor Chat Persona repository", () => {
  test("seeds a disabled system-language persona and audits an optimistic update without plaintext", async () => {
    const root = await mkdtemp(join(tmpdir(), "xw-persona-repository-"));
    const db = await openDatabase({ stateDir: join(root, "state") });
    try {
      expect(getPiPersona(db)).toMatchObject({
        supervisor_id: "runner-default",
        enabled: 0,
        language_mode: "system",
        revision: 0,
        verbosity: "adaptive"
      });
      const saved = db.transaction(() => updatePiPersona(db, {
        expected_revision: 0,
        enabled: 1,
        personality: "  自然可靠  ",
        communication_style: "  先说结论  "
      }, {
        actor: "settings-test",
        reason: "enable canary",
        requestedAt: "2026-08-01T00:00:00.000Z"
      })).immediate();
      expect(saved).toMatchObject({
        enabled: 1,
        personality: "自然可靠",
        communication_style: "先说结论",
        revision: 1
      });
      const [event] = listPiActionEvents(db, { eventType: "supervisor_persona_updated" });
      const payload = JSON.parse(event?.payload_json ?? "{}") as Record<string, unknown>;
      expect(event).toMatchObject({ actor: "settings-test", reason: "enable canary" });
      expect(payload).toMatchObject({
        schema_version: "xw.supervisor-persona-audit.v1",
        before_revision: 0,
        after_revision: 1,
        changed_fields: ["enabled", "personality", "communication_style"]
      });
      expect(event?.payload_json).not.toContain("自然可靠");
      expect(event?.payload_json).not.toContain("先说结论");
      expect(payload.text_fields).toMatchObject({
        personality: { chars: 4, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        communication_style: { chars: 4, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }
      });
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects stale revisions, invalid enums, and text over the fixed budgets", async () => {
    const root = await mkdtemp(join(tmpdir(), "xw-persona-validation-"));
    const db = await openDatabase({ stateDir: join(root, "state") });
    const audit = { actor: "test", reason: "validation", requestedAt: new Date().toISOString() };
    try {
      expect(() => updatePiPersona(db, { expected_revision: 1, enabled: 1 }, audit))
        .toThrow("persona revision conflict");
      expect(() => updatePiPersona(db, { expected_revision: 0, verbosity: "verbose" as never }, audit))
        .toThrow("verbosity must be one of");
      expect(() => updatePiPersona(db, { expected_revision: 0, language_mode: "auto" as never }, audit))
        .toThrow("language_mode must be one of");
      expect(() => updatePiPersona(db, { expected_revision: 0, personality: "x".repeat(1_001) }, audit))
        .toThrow("personality must be at most 1000");
      expect(() => updatePiPersona(db, { expected_revision: 0, communication_style: "x".repeat(2_001) }, audit))
        .toThrow("communication_style must be at most 2000");
      expect(getPiPersona(db)?.revision).toBe(0);
      expect(listPiActionEvents(db, { eventType: "supervisor_persona_updated" })).toHaveLength(0);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
