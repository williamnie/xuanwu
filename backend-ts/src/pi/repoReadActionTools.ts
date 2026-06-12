import type { RunnerDatabase } from "../db/database.ts";
import { ProjectNotFoundError, type Project } from "../db/repositories/projects.ts";
import { executeSafePiAction, type PiActionContext } from "./actionEngine.ts";
import {
  readRepoExcerpt,
  readRepoTree,
  searchRepo,
  summarizeRepoToolResult,
  type RepoReadExcerptInput,
  type RepoSearchInput,
  type RepoTreeInput
} from "./repoReadActions.ts";

export type PiRepoReadActionLayer = {
  readRepoExcerpt(input: RepoReadExcerptInput): unknown;
  readRepoTree(input: RepoTreeInput): unknown;
  searchRepo(input: RepoSearchInput): unknown;
};

type RepoActionContext = PiActionContext & { project?: Project };

export function createPiRepoReadActions(db: RunnerDatabase, context: RepoActionContext): PiRepoReadActionLayer {
  return {
    readRepoExcerpt: (input) => executeSafePiAction(db, context, {
      actionType: "repo.read_excerpt",
      payload: cleanPayload({
        max_bytes: input.max_bytes,
        max_lines: input.max_lines,
        path: input.path,
        start_line: input.start_line
      }),
      projectID: context.project?.id ?? "",
      execute: () => readRepoExcerpt(requireProject(context), input),
      resultForAudit: summarizeRepoToolResult
    }),
    readRepoTree: (input) => executeSafePiAction(db, context, {
      actionType: "repo.tree",
      payload: cleanPayload({ max_depth: input.max_depth, max_entries: input.max_entries, path: input.path }),
      projectID: context.project?.id ?? "",
      execute: () => readRepoTree(requireProject(context), input),
      resultForAudit: summarizeRepoToolResult
    }),
    searchRepo: (input) => executeSafePiAction(db, context, {
      actionType: "repo.search",
      payload: cleanPayload({ max_results: input.max_results, path: input.path, query: input.query }),
      projectID: context.project?.id ?? "",
      execute: () => searchRepo(requireProject(context), input),
      resultForAudit: summarizeRepoToolResult
    })
  };
}

function requireProject(context: RepoActionContext): Project {
  if (!context.project) throw new ProjectNotFoundError();
  return context.project;
}

function cleanPayload(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== ""));
}
