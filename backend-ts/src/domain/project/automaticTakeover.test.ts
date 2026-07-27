import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { deleteProjectPiSettings, getPiSupervisor, updatePiSupervisor } from "../../db/repositories/pi.ts";
import { updateProject } from "../../db/repositories/projects.ts";
import {
  createAutomaticallyManagedProject,
  ensureProjectAutomaticTakeover,
  updateAutomaticallyManagedProject
} from "./automaticTakeover.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { force: true, recursive: true });
  }
});

describe("automatic project takeover", () => {
  test("creates and updates projects with mandatory PI takeover", async () => {
    const { cwd, database } = await fixture();
    try {
      updatePiSupervisor(database, { enabled: 0 });
      const created = createAutomaticallyManagedProject(database, { id: "demo", cwd, auto_run: 0 });
      expect(created).toMatchObject({ id: "demo", auto_run: 1, pi_managed: 1 });
      expect(getPiSupervisor(database)?.enabled).toBe(1);

      const updated = updateAutomaticallyManagedProject(database, "demo", { auto_run: 0, name: "Renamed" });
      expect(updated).toMatchObject({ id: "demo", name: "Renamed", auto_run: 1, pi_managed: 1 });
    } finally {
      database.close();
    }
  });

  test("repairs a legacy project that is paused and not bound", async () => {
    const { cwd, database } = await fixture();
    try {
      const project = createAutomaticallyManagedProject(database, { id: "demo", cwd });
      deleteProjectPiSettings(database, project.id);
      updateProject(database, project.id, { auto_run: 0 });

      expect(ensureProjectAutomaticTakeover(database, project.id))
        .toMatchObject({ auto_run: 1, pi_managed: 1 });
    } finally {
      database.close();
    }
  });
});

async function fixture(): Promise<{ cwd: string; database: RunnerDatabase }> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-project-takeover-"));
  tempRoots.push(root);
  return { cwd: root, database: await openDatabase({ stateDir: join(root, "state") }) };
}
