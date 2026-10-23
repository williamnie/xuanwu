import { describe, expect, test } from "bun:test";
import { decidePiAuthorization, type PiActionEnvelope, type PiGatePolicy } from "./actionGate.ts";

const BASE: PiActionEnvelope = {
  action_type: "issue.comment",
  issue_id: 7,
  payload: {},
  project_id: "demo",
  requires_confirmation: false,
  risk_level: "low",
  source: "pi_tool"
};

describe("PI authorization decision", () => {
  for (const scenario of AUTHORIZATION_MATRIX) {
    test(scenario.name, () => {
      const decision = decidePiAuthorization(actionEnvelope(scenario.action), scenario.policy);

      expect(decision).toMatchObject({ decision: scenario.decision });
      if (scenario.reason) expect(decision.reason).toContain(scenario.reason);
    });
  }

  test("manual mode asks instead of auto-executing non-read-only safe actions", () => {
    expect(decidePiAuthorization(BASE, { mode: "manual" })).toMatchObject({
      decision: "ask"
    });
  });

  test("attended mode asks for confirm and high risk actions", () => {
    expect(decidePiAuthorization({ ...BASE, action_type: "issue.enqueue", requires_confirmation: true, risk_level: "medium" }, {
      mode: "attended"
    })).toMatchObject({ decision: "ask" });
    expect(decidePiAuthorization({
      ...BASE,
      action_type: "issue_completion_watch.create",
      payload: { issue_ids: [7] },
      requires_confirmation: true,
      risk_level: "medium"
    }, { mode: "attended" })).toMatchObject({ decision: "ask" });
    expect(decidePiAuthorization({ ...BASE, action_type: "session.steer", requires_confirmation: true, risk_level: "high" }, {
      mode: "attended"
    })).toMatchObject({ decision: "ask" });
  });

  test("delegated mode executes only mutations covered by allowed_actions", () => {
    expect(decidePiAuthorization(BASE, {
      allowed_actions: ["issue.comment"],
      mode: "delegated",
      scope: { project_id: "demo" }
    })).toMatchObject({ decision: "execute" });
    expect(decidePiAuthorization(BASE, {
      allowed_actions: ["issue.read"],
      mode: "delegated",
      scope: { project_id: "demo" }
    })).toMatchObject({ decision: "deny" });
    expect(decidePiAuthorization(BASE, {
      allowed_actions: ["issue.comment"],
      authorizedActions: [{ action_type: "issue.comment", issue_id: 8, project_id: "demo" }],
      mode: "delegated",
      scope: { project_id: "demo" }
    })).toMatchObject({ decision: "deny" });
    expect(decidePiAuthorization({ ...BASE, action_type: "sdk.read" }, {
      mode: "delegated",
      scope: { project_id: "demo" }
    })).toMatchObject({ decision: "execute" });
    expect(decidePiAuthorization({
      ...BASE,
      action_type: "issue_completion_watch.list",
      requires_confirmation: false,
      risk_level: "low"
    }, {
      allowed_actions: ["issue.enqueue"],
      mode: "delegated",
      scope: { project_id: "demo" }
    })).toMatchObject({ decision: "execute" });
    expect(decidePiAuthorization({
      ...BASE,
      action_type: "issue_completion_watch.cancel",
      payload: { watch_id: "watch-1" },
      requires_confirmation: true,
      risk_level: "medium"
    }, {
      authorizedActions: [{ action_type: "issue_completion_watch.cancel", project_id: "demo" }],
      mode: "delegated",
      scope: { project_id: "demo" }
    })).toMatchObject({ decision: "execute" });
  });

  test("delegated mode denies skill intents outside snake_case authorization allowlist", () => {
    const action = {
      ...BASE,
      action_type: "issue.create",
      payload: {
        project_id: "demo",
        required_skill_intents: ["browser:control-in-app-browser"]
      },
      requires_confirmation: true,
      risk_level: "medium"
    };

    expect(decidePiAuthorization(action, {
      allowed_actions: ["issue.create"],
      allowed_skill_intents: ["xuanwu"],
      authorizedActions: [{ action_type: "issue.create", project_id: "demo" }],
      mode: "delegated",
      scope: { project_id: "demo" }
    })).toMatchObject({
      decision: "deny",
      reason: "delegated skill intent is not covered by authorization allowlist"
    });
  });

  test("forbidden actions and forbidden risk always deny", () => {
    expect(decidePiAuthorization(BASE, {
      allowed_actions: ["issue.comment"],
      authorizedActions: [{ action_type: "issue.comment", issue_id: 7, project_id: "demo" }],
      forbidden_actions: ["issue.comment"],
      mode: "delegated"
    })).toMatchObject({ decision: "deny" });
    expect(decidePiAuthorization({ ...BASE, risk_gate: "forbidden" } as PiActionEnvelope, {
      allowed_actions: ["issue.comment"],
      mode: "delegated"
    })).toMatchObject({ decision: "deny" });
    expect(decidePiAuthorization({ ...BASE, risk_level: "forbidden" } as unknown as PiActionEnvelope, {
      allowed_actions: ["issue.comment"],
      mode: "delegated"
    })).toMatchObject({ decision: "deny" });
  });

  test("delegation windows and scope mismatches block delegated execution", () => {
    expect(decidePiAuthorization(BASE, {
      allowed_actions: ["issue.comment"],
      mode: "delegated",
      now: "2026-06-03T10:00:00.000Z",
      starts_at: "2026-06-03T11:00:00.000Z"
    })).toMatchObject({ decision: "snooze" });
    expect(decidePiAuthorization(BASE, {
      allowed_actions: ["issue.comment"],
      expires_at: "2026-06-03T09:00:00.000Z",
      mode: "delegated",
      now: "2026-06-03T10:00:00.000Z"
    })).toMatchObject({ decision: "deny" });
    expect(decidePiAuthorization(BASE, {
      allowed_actions: ["issue.comment"],
      mode: "delegated",
      scope: { project_id: "other" }
    })).toMatchObject({ decision: "deny" });
  });

  test("matches issue/project/goal scopes and explains scope decisions", () => {
    expect(decidePiAuthorization(BASE, {
      allowed_actions: ["issue.comment"],
      mode: "delegated"
    })).toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("authorization scope is empty")
    });

    expect(decidePiAuthorization(BASE, {
      allowed_actions: ["issue.comment"],
      mode: "delegated",
      scope: { issue_ids: [7, 8], project_id: "demo" }
    })).toMatchObject({
      decision: "execute",
      reason: expect.stringContaining("scope matched issue 7")
    });

    expect(decidePiAuthorization({ ...BASE, action_type: "project.status", issue_id: 0 }, {
      allowed_actions: ["project.status"],
      mode: "delegated",
      scope: { project_id: "demo" }
    })).toMatchObject({
      decision: "execute",
      reason: expect.stringContaining("scope matched project demo")
    });

    expect(decidePiAuthorization({ ...BASE, project_id: "other" }, {
      allowed_actions: ["issue.comment"],
      mode: "delegated",
      scope: { issue_ids: [7], project_id: "demo" }
    })).toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("project scope demo does not match action project other")
    });

    expect(decidePiAuthorization(BASE, {
      allowed_actions: ["issue.comment"],
      mode: "delegated",
      scope: {}
    })).toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("authorization scope is empty")
    });

    expect(decidePiAuthorization(BASE, {
      allowed_actions: ["issue.comment"],
      mode: "delegated",
      scope: { goal_id: "night-run", issue_ids: [7, 8], project_id: "demo" }
    })).toMatchObject({
      decision: "execute",
      reason: expect.stringContaining("scope matched goal night-run issue 7")
    });
  });
});

type AuthorizationMatrixCase = {
  action?: Partial<PiActionEnvelope>;
  decision: "execute" | "ask" | "deny" | "snooze";
  name: string;
  policy: PiGatePolicy;
  reason?: string;
};

const OPEN_WINDOW = {
  expires_at: "2026-06-03T11:00:00.000Z",
  now: "2026-06-03T10:00:00.000Z",
  starts_at: "2026-06-03T09:00:00.000Z"
} as const;

const AUTHORIZATION_MATRIX: AuthorizationMatrixCase[] = [
  {
    decision: "ask",
    name: "mode=manual risk=low action=issue.comment scope=project time=open -> ask",
    policy: { ...OPEN_WINDOW, allowed_actions: ["issue.comment"], mode: "manual", scope: { project_id: "demo" } },
    reason: "manual mode"
  },
  {
    decision: "execute",
    name: "mode=attended risk=low action=issue.comment scope=project time=open -> execute",
    policy: { ...OPEN_WINDOW, allowed_actions: ["issue.comment"], mode: "attended", scope: { project_id: "demo" } },
    reason: "low-risk"
  },
  {
    action: { action_type: "issue.enqueue", requires_confirmation: true, risk_level: "medium" },
    decision: "ask",
    name: "mode=attended risk=confirm action=issue.enqueue scope=issue time=open -> ask",
    policy: { ...OPEN_WINDOW, allowed_actions: ["issue.enqueue"], mode: "attended", scope: { issue_id: 7 } },
    reason: "confirmation"
  },
  {
    action: { action_type: "session.steer", requires_confirmation: true, risk_level: "high" },
    decision: "ask",
    name: "mode=default-attended risk=high action=session.steer scope=project time=open -> ask",
    policy: { ...OPEN_WINDOW, allowed_actions: ["session.steer"], scope: { project_id: "demo" } },
    reason: "confirmation"
  },
  {
    decision: "execute",
    name: "mode=delegated risk=low action=issue.comment scope=issue time=open -> execute",
    policy: { ...OPEN_WINDOW, allowed_actions: ["issue.comment"], mode: "delegated", scope: { issue_id: 7 } },
    reason: "authorization envelope"
  },
  {
    decision: "deny",
    name: "mode=delegated risk=low action=issue.comment allowed-and-forbidden conflict -> deny",
    policy: {
      ...OPEN_WINDOW,
      allowed_actions: ["issue.comment"],
      forbidden_actions: ["issue.comment"],
      mode: "delegated",
      scope: { issue_id: 7 }
    },
    reason: "forbidden"
  },
  {
    decision: "deny",
    name: "mode=delegated risk=low action=issue.comment scope=wrong-issue -> deny",
    policy: { ...OPEN_WINDOW, allowed_actions: ["issue.comment"], mode: "delegated", scope: { issue_id: 8 } },
    reason: "scope"
  },
  {
    decision: "snooze",
    name: "mode=delegated risk=low action=issue.comment scope=issue time=not-started -> snooze",
    policy: {
      allowed_actions: ["issue.comment"],
      mode: "delegated",
      now: "2026-06-03T10:00:00.000Z",
      scope: { issue_id: 7 },
      starts_at: "2026-06-03T11:00:00.000Z"
    },
    reason: "not started"
  },
  {
    decision: "deny",
    name: "mode=delegated risk=low action=issue.comment scope=issue time=expired -> deny",
    policy: {
      allowed_actions: ["issue.comment"],
      expires_at: "2026-06-03T09:00:00.000Z",
      mode: "delegated",
      now: "2026-06-03T10:00:00.000Z",
      scope: { issue_id: 7 }
    },
    reason: "expired"
  },
  {
    action: { action_type: "issue.enqueue", requires_confirmation: true, risk_level: "medium" },
    decision: "execute",
    name: "mode=autonomous risk=confirm action=issue.enqueue scope=project time=open explicit-envelope -> execute",
    policy: {
      ...OPEN_WINDOW,
      authorizedActions: [{ action_type: "issue.enqueue", issue_id: 7, project_id: "demo" }],
      mode: "autonomous",
      scope: { project_id: "demo" }
    },
    reason: "authorization envelope"
  },
  {
    action: { action_type: "session.steer", requires_confirmation: true, risk_level: "high" },
    decision: "deny",
    name: "mode=autonomous risk=high action=session.steer scope=project time=open no-envelope -> deny",
    policy: { ...OPEN_WINDOW, mode: "autonomous", scope: { project_id: "demo" } },
    reason: "not covered"
  }
];

function actionEnvelope(overrides: Partial<PiActionEnvelope> | undefined): PiActionEnvelope {
  return { ...BASE, ...overrides };
}
