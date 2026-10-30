export const MAX_PROJECTION_BYTES = 128 * 1024 * 1024;

export const DEFAULT_OBSERVATION_SECONDS = 24 * 60 * 60;

export const DEFAULT_PERFORMANCE_SAMPLES = 20;

export type Authorization = {
  actor: string;
  actorKind: "retention_worker" | "system" | "user";
  auditRef: string;
  reason: string;
};

export type DatabaseInput = { dbPath: string };

export type AuthorizedDatabaseInput = DatabaseInput & Authorization;
