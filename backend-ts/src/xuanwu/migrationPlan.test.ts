import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type DependencyNode = {
  depends_on: string[];
  id?: string;
  key?: string;
};

type RoadmapNode = DependencyNode & {
  issue_id: number;
  key: string;
  title: string;
};

type ArchitectureLane = DependencyNode & {
  completion_gate: string;
  id: string;
  name: string;
  roadmap_scope: string[];
};

type MigrationGate = DependencyNode & {
  enter_when: string[];
  exit_evidence: string[];
  id: string;
  name: string;
  rollback_point: string;
};

type MigrationStream = {
  cutover_gate: string;
  dual_read_release_windows: number;
  dual_read_windows: string[];
  dual_write_release_windows: number;
  dual_write_windows: string[];
  final_delete_gate: string;
  id: string;
  owner_issues: string[];
  rollback: string;
  source_of_truth_before_cutover: string;
  target_authority_after_cutover: string;
};

type MigrationStep = DependencyNode & {
  audit_preconditions: string[];
  backup_preconditions: string[];
  destructive: boolean;
  exit_evidence: string[];
  id: string;
  name: string;
  owner_issues: string[];
  rollback_preconditions: string[];
};

type MigrationPlan = {
  architecture_lanes: ArchitectureLane[];
  baseline: {
    dependency_snapshot_date: string;
    dependency_source: string;
    roadmap_issue_id: number;
    roadmap_node_count: number;
  };
  canonical_document: string;
  compatibility_policy: {
    api: Record<string, string>;
    formal_release_window: string;
    max_dual_mode_release_windows: number;
    windows: Array<{ authority: string; id: string; purpose: string; reads: string; writes: string }>;
  };
  data_migration_steps: MigrationStep[];
  global_invariants: string[];
  migration_gates: MigrationGate[];
  migration_streams: MigrationStream[];
  roadmap_nodes: RoadmapNode[];
  schema_version: string;
};

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const PLAN_PATH = "docs/architecture/xuanwu-migration/plan.json";
const ADR_PATH = "docs/architecture/xuanwu-migration/README.md";
const plan = JSON.parse(readFileSync(resolve(REPO_ROOT, PLAN_PATH), "utf8")) as MigrationPlan;

describe("Xuanwu migration architecture plan", () => {
  test("keeps the exact 115-item roadmap dependency graph complete, reachable, and acyclic", () => {
    expect(plan.schema_version).toBe("xuanwu.migration-plan.v1");
    expect(plan.baseline.roadmap_issue_id).toBe(746);
    expect(plan.baseline.roadmap_node_count).toBe(115);
    expect(plan.roadmap_nodes).toHaveLength(115);
    expect(unique(plan.roadmap_nodes.map((node) => node.key))).toHaveLength(115);
    expect(unique(plan.roadmap_nodes.map((node) => node.issue_id))).toHaveLength(115);
    expect(plan.roadmap_nodes.map((node) => node.issue_id)).toEqual(
      Array.from({ length: 115 }, (_, index) => 631 + index)
    );

    const byKey = new Map(plan.roadmap_nodes.map((node) => [node.key, node]));
    expect(plan.roadmap_nodes.filter((node) => node.depends_on.length === 0).map((node) => node.key))
      .toEqual(["P00.01"]);
    expect(phaseCounts(plan.roadmap_nodes)).toEqual({
      P00: 6, P01: 10, P02: 9, P03: 7, P04: 9, P05: 8,
      P06: 13, P07: 14, P08: 10, P09: 7, P10: 12, P11: 10
    });

    for (const node of plan.roadmap_nodes) {
      expect(node.title.trim()).not.toBe("");
      for (const dependency of node.depends_on) {
        const parent = byKey.get(dependency);
        expect(parent, `${node.key} references missing ${dependency}`).toBeDefined();
      }
    }

    expect(assertAcyclic(plan.roadmap_nodes, "key")).toHaveLength(115);
    expect(reachableFrom("P00.01", plan.roadmap_nodes)).toHaveLength(115);
    expect(() => assertAcyclic([
      { key: "A", depends_on: ["B"] },
      { key: "B", depends_on: ["A"] }
    ], "key")).toThrow("dependency cycle detected");
  });

  test("keeps architecture lanes and migration gates as complete acyclic graphs", () => {
    expect(assertAcyclic(plan.architecture_lanes, "id")).toHaveLength(plan.architecture_lanes.length);
    expect(unique(plan.architecture_lanes.map((lane) => lane.id))).toHaveLength(plan.architecture_lanes.length);
    for (const lane of plan.architecture_lanes) {
      expect(lane.name.trim()).not.toBe("");
      expect(lane.roadmap_scope.length).toBeGreaterThan(0);
      expect(lane.completion_gate.trim()).not.toBe("");
    }

    expect(plan.migration_gates.map((gate) => gate.id)).toEqual(
      Array.from({ length: 8 }, (_, index) => `G${index}`)
    );
    expect(assertAcyclic(plan.migration_gates, "id")).toEqual(
      Array.from({ length: 8 }, (_, index) => `G${index}`)
    );
    for (const gate of plan.migration_gates) {
      expect(gate.enter_when.length).toBeGreaterThan(0);
      expect(gate.exit_evidence.length).toBeGreaterThan(0);
      expect(gate.rollback_point.trim()).not.toBe("");
    }
  });

  test("bounds every compatibility stream and declares one authority, rollback, and deletion gate", () => {
    const maximum = plan.compatibility_policy.max_dual_mode_release_windows;
    const allowedDualWindows = new Set(["W1", "W2"]);
    expect(maximum).toBe(2);
    expect(plan.compatibility_policy.windows.map((window) => window.id)).toEqual(["W0", "W1", "W2", "W3"]);
    expect(plan.compatibility_policy.windows[0].authority).toBe("legacy");
    expect(plan.compatibility_policy.windows[3].authority).toBe("target");
    expect(plan.compatibility_policy.api.write_rule).toContain("same deterministic domain command");
    expect(plan.compatibility_policy.api.removal_gate).toContain("G7");

    const roadmapKeys = new Set(plan.roadmap_nodes.map((node) => node.key));
    const gateIDs = new Set(plan.migration_gates.map((gate) => gate.id));
    expect(plan.migration_streams.map((stream) => stream.id)).toEqual([
      "work", "run", "evidence_handoff", "attention_approval", "automation", "api_ui_compatibility"
    ]);
    for (const stream of plan.migration_streams) {
      expect(stream.source_of_truth_before_cutover.trim()).not.toBe("");
      expect(stream.target_authority_after_cutover.trim()).not.toBe("");
      expect(stream.source_of_truth_before_cutover).not.toBe(stream.target_authority_after_cutover);
      expect(stream.dual_read_release_windows).toBeLessThanOrEqual(maximum);
      expect(stream.dual_write_release_windows).toBeLessThanOrEqual(maximum);
      expect(stream.dual_read_windows).toHaveLength(stream.dual_read_release_windows);
      expect(stream.dual_write_windows).toHaveLength(stream.dual_write_release_windows);
      for (const window of [...stream.dual_read_windows, ...stream.dual_write_windows]) {
        expect(allowedDualWindows.has(window)).toBe(true);
      }
      expect(stream.rollback.trim()).not.toBe("");
      expect(stream.final_delete_gate).toContain("P11");
      expect(gateIDs.has(stream.cutover_gate)).toBe(true);
      for (const issue of stream.owner_issues) expect(roadmapKeys.has(issue)).toBe(true);
    }
  });

  test("orders data migration and gives every destructive step backup, rollback, and deterministic audit gates", () => {
    expect(plan.data_migration_steps.map((step) => step.id)).toEqual(
      Array.from({ length: 12 }, (_, index) => `M${String(index).padStart(2, "0")}`)
    );
    expect(assertAcyclic(plan.data_migration_steps, "id")).toHaveLength(12);

    const roadmapKeys = new Set(plan.roadmap_nodes.map((node) => node.key));
    for (const step of plan.data_migration_steps) {
      expect(step.exit_evidence.length).toBeGreaterThan(0);
      expect(step.audit_preconditions.length).toBeGreaterThan(0);
      for (const issue of step.owner_issues) expect(roadmapKeys.has(issue)).toBe(true);
    }

    const destructive = plan.data_migration_steps.filter((step) => step.destructive);
    expect(destructive.map((step) => step.id)).toEqual(["M09", "M10", "M11"]);
    for (const step of destructive) {
      expect(step.backup_preconditions.length).toBeGreaterThanOrEqual(2);
      expect(step.rollback_preconditions.length).toBeGreaterThanOrEqual(2);
      expect(step.audit_preconditions.join(" ")).toContain("Non-LLM");
    }
  });

  test("locks the canonical document, API policy, compatibility window, and no-early-delete rule", () => {
    const adr = readFileSync(resolve(REPO_ROOT, ADR_PATH), "utf8");
    expect(plan.canonical_document).toBe(ADR_PATH);
    for (const heading of [
      "目标架构依赖图", "分阶段迁移门禁", "兼容窗口", "source of truth",
      "数据迁移顺序", "DB migration policy", "API compatibility policy", "回滚模型"
    ]) expect(adr).toContain(heading);
    expect(adr).toContain("P11 前不得提前删除");
    expect(adr).toContain("LLM 只可提议");
    expect(adr).toContain("M10 drop table/index");
    expect(plan.global_invariants.some((invariant) => invariant.includes("cannot approve"))).toBe(true);
    expect(plan.global_invariants.some((invariant) => invariant.includes("before G7"))).toBe(true);
  });
});

function assertAcyclic<T extends DependencyNode>(nodes: readonly T[], identity: "id" | "key"): string[] {
  const ids = nodes.map((node) => node[identity]);
  if (ids.some((id) => !id)) throw new Error(`missing ${identity}`);
  if (unique(ids as string[]).length !== ids.length) throw new Error(`duplicate ${identity}`);

  const known = new Set(ids as string[]);
  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    const id = node[identity] as string;
    indegree.set(id, node.depends_on.length);
    for (const dependency of node.depends_on) {
      if (!known.has(dependency)) throw new Error(`${id} references missing dependency ${dependency}`);
      children.set(dependency, [...(children.get(dependency) ?? []), id]);
    }
  }

  const ready = [...indegree.entries()].filter(([, count]) => count === 0).map(([id]) => id);
  const ordered: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    ordered.push(id);
    for (const child of children.get(id) ?? []) {
      const remaining = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, remaining);
      if (remaining === 0) ready.push(child);
    }
  }
  if (ordered.length !== nodes.length) throw new Error("dependency cycle detected");
  return ordered;
}

function reachableFrom(root: string, nodes: readonly RoadmapNode[]): string[] {
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dependency of node.depends_on) {
      children.set(dependency, [...(children.get(dependency) ?? []), node.key]);
    }
  }
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return [...seen];
}

function phaseCounts(nodes: readonly RoadmapNode[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const node of nodes) {
    const phase = node.key.slice(0, 3);
    counts[phase] = (counts[phase] ?? 0) + 1;
  }
  return counts;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
