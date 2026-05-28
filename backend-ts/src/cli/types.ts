export type CliOptions = {
  env?: EnvReader;
  fetch?: Fetcher;
};

export type EnvReader = (key: string) => string | undefined;
export type Fetcher = typeof globalThis.fetch;
export type Writer = { write(chunk: string | Uint8Array): unknown };

export type IssueDTO = {
  error?: string;
  id: number;
  project_id: string;
  status: string;
  title: string;
};

export type IssueEventDTO = {
  created_at?: string;
  id?: number;
  issue_id?: number;
  payload?: string;
  type?: string;
};

export type ProjectDTO = {
  cwd: string;
  id: string;
  loop_status?: string;
};

export type SystemLogLineDTO = {
  level?: string;
  source?: string;
  text?: string;
  time?: string;
};

export type SystemLogsDTO = {
  logs?: Array<{
    available?: boolean;
    error?: string;
    lines?: SystemLogLineDTO[];
    source?: string;
  }>;
};

export type SystemStatusDTO = {
  auth?: { enabled?: boolean };
  codex?: { capability_summary?: string; command_ok?: boolean };
  config?: { auth_enabled?: boolean };
  db?: { ok?: boolean };
  runner?: { in_progress_issues?: number; running_loops?: number };
  service?: { alive?: boolean };
};
