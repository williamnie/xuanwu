import { describe, expect, test } from "bun:test";
import type { AgentProfile } from "../db/repositories/agentProfiles.ts";
import { selectRoleProfile } from "./roleProfileSelector.ts";

const baseProfile = {
  approval_policy: "",
  created_at: "2026-01-01T00:00:00Z",
  default_instructions: "",
  model: "codex-default",
  plugin_intents: "[]",
  provider: "codex",
  reasoning_effort: "",
  sandbox: "",
  skill_intents: "[]",
  updated_at: "2026-01-01T00:00:00Z"
};

describe("role profile selector", () => {
  test("honors issue agent profile override for verifier workflows", () => {
    const selected = selectRoleProfile({
      issueProfileId: "qa-general",
      profiles: [profile("qa-general", { name: "QA General", provider: "claude" }), verifierProfile()],
      projectProvider: "codex",
      role: "verifier",
      requiredSkillIntents: ["verification-before-completion"]
    });

    expect(selected.profile?.id).toBe("qa-general");
    expect(selected.selection_reason).toBe("issue assigned agent_profile_id");
  });

  test("uses project default profile when no override is present", () => {
    const selected = selectRoleProfile({
      projectDefaultProfileId: "default-codex",
      profiles: [profile("default-codex"), verifierProfile()],
      projectProvider: "codex",
      role: "executor",
      requiredSkillIntents: []
    });

    expect(selected.profile?.id).toBe("default-codex");
    expect(selected.selection_reason).toBe("project default_agent_profile_id");
  });

  test("matches role, provider, and skill intent when defaults are absent", () => {
    const selected = selectRoleProfile({
      profiles: [profile("generic-codex"), verifierProfile(), profile("claude-verifier", { provider: "claude", skill_intents: "[\"verification-before-completion\"]" })],
      projectProvider: "codex",
      role: "verifier",
      requiredSkillIntents: ["verification-before-completion"]
    });

    expect(selected.profile?.id).toBe("codex-verifier");
    expect(selected.selection_reason).toContain("matched role/provider/skill intent strategy");
    expect(selected.selection_reason).toContain("codex-verifier");
  });

  test("falls back safely when requested profiles are missing", () => {
    const selected = selectRoleProfile({
      explicitProfileId: "manual-missing",
      issueProfileId: "issue-missing",
      projectDefaultProfileId: "default-missing",
      profiles: [],
      projectProvider: "codex",
      role: "executor",
      requiredSkillIntents: []
    });

    expect(selected.profile).toBeNull();
    expect(selected.selection_reason).toContain("fallback to project provider codex");
    expect(selected.selection_reason).toContain("manual-missing");
    expect(selected.selection_reason).toContain("issue-missing");
    expect(selected.selection_reason).toContain("default-missing");
  });

  test("can enforce Work routing priority without selecting a strategy profile", () => {
    const selected = selectRoleProfile({
      allowStrategy: false,
      profiles: [verifierProfile()],
      projectProvider: "claude",
      role: "verifier",
      requiredSkillIntents: ["verification-before-completion"]
    });

    expect(selected.profile).toBeNull();
    expect(selected.selection_reason).toContain("fallback to project provider claude");
  });

  test("audits missing overrides when falling back to a matched profile", () => {
    const selected = selectRoleProfile({
      issueProfileId: "issue-missing",
      profiles: [verifierProfile()],
      projectProvider: "codex",
      role: "verifier",
      requiredSkillIntents: ["verification-before-completion"]
    });

    expect(selected.profile?.id).toBe("codex-verifier");
    expect(selected.selection_reason).toContain("matched role/provider/skill intent strategy");
    expect(selected.selection_reason).toContain("issue assigned agent_profile_id missing: issue-missing");
  });
});

function verifierProfile(): AgentProfile {
  return profile("codex-verifier", { name: "Codex Verifier", skill_intents: "[\"verification-before-completion\"]" });
}

function profile(id: string, overrides: Partial<AgentProfile> = {}): AgentProfile {
  return { ...baseProfile, id, name: id, ...overrides };
}
