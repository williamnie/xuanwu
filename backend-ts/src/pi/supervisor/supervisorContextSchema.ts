import { Type, type Static } from "@sinclair/typebox";
import { type Project } from "../../db/repositories/projects.ts";
import type { WorkLedgerEntry } from "../../domain/work/contracts.ts";
import { clarification } from "./supervisorContextCandidates.ts";

export const SUPERVISOR_CONTEXT_CANDIDATE_SOURCES = [
  "work_reference",
  "one_shot_work",
  "one_shot_target",
  "explicit_project",
  "current_page",
  "conversation_history"
] as const;

export const DIRECT_SOURCE_KINDS = new Set<SupervisorContextCandidateSourceKind>([
  "work_reference",
  "one_shot_work",
  "one_shot_target",
  "explicit_project"
]);

export const objectOptions = { additionalProperties: false } as const;

export const sourceKindSchema = Type.Union(
  SUPERVISOR_CONTEXT_CANDIDATE_SOURCES.map((kind) => Type.Literal(kind))
);

export const candidateSourceSchema = Type.Object({
  kind: sourceKindSchema,
  ref: Type.String({ minLength: 1 }),
  score: Type.Integer({ maximum: 100, minimum: 0 })
}, objectOptions);

export const candidateSchema = Type.Object({
  project_id: Type.String({ minLength: 1 }),
  score: Type.Integer({ maximum: 100, minimum: 0 }),
  sources: Type.Array(candidateSourceSchema, { minItems: 1 }),
  work_ids: Type.Array(Type.String({ minLength: 1 }))
}, objectOptions);

export const SUPERVISOR_CONTEXT_RESOLUTION_SCHEMA = Type.Object({
  candidates: Type.Array(candidateSchema),
  clarification: Type.Object({
    question: Type.Optional(Type.String({ minLength: 1 })),
    reason: Type.String({ minLength: 1 }),
    required: Type.Boolean()
  }, objectOptions),
  input_audit: Type.Object({
    char_count: Type.Integer({ minimum: 0 }),
    input_digest: Type.String({ minLength: 16, maxLength: 16 })
  }, objectOptions),
  provenance: Type.Object({
    context_inheritance_allowed: Type.Boolean(),
    conversation_id: Type.String(),
    resolver: Type.Literal("deterministic_supervisor_context"),
    source: Type.String({ minLength: 1 }),
    target_binding: Type.Union([
      Type.Literal("explicit"),
      Type.Literal("one_shot"),
      Type.Literal("conversation"),
      Type.Literal("none")
    ])
  }, objectOptions),
  reason: Type.String({ minLength: 1 }),
  schema_version: Type.Literal("xw.supervisor-context-resolution.v1"),
  status: Type.Union([
    Type.Literal("resolved"),
    Type.Literal("ambiguous"),
    Type.Literal("missing")
  ]),
  target: Type.Object({
    issue_ids: Type.Array(Type.Integer({ minimum: 1 })),
    project_id: Type.String(),
    work_ids: Type.Array(Type.String({ minLength: 1 }))
  }, objectOptions)
}, objectOptions);

export type SupervisorContextResolution = Static<typeof SUPERVISOR_CONTEXT_RESOLUTION_SCHEMA>;

export type SupervisorContextCandidateSourceKind =
  (typeof SUPERVISOR_CONTEXT_CANDIDATE_SOURCES)[number];

export type SupervisorContextResolverInput = {
  conversationID?: string;
  conversationProjectID?: string;
  oneShotProjectID?: string;
  oneShotIssueID?: number;
  oneShotSource?: string;
  prompt: string;
  source?: string;
};

export type SupervisorContextAuditInput = {
  conversationID: string;
  turnID: string;
};

export type CandidateSource = Static<typeof candidateSourceSchema>;

export type MutableCandidate = {
  project: Project;
  sources: CandidateSource[];
  works: Map<string, WorkLedgerEntry>;
};

export type Candidate = Static<typeof candidateSchema>;
