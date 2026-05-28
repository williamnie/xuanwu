export type CliOptions = {
  env?: EnvReader;
  fetch?: Fetcher;
};

export type EnvReader = (key: string) => string | undefined;
export type Fetcher = typeof globalThis.fetch;
export type Writer = { write(chunk: string | Uint8Array): unknown };

export type SystemStatusDTO = {
  auth?: { enabled?: boolean };
  codex?: { command_ok?: boolean };
  config?: { auth_enabled?: boolean };
  db?: { ok?: boolean };
  runner?: { in_progress_issues?: number; running_loops?: number };
  service?: { alive?: boolean };
};
