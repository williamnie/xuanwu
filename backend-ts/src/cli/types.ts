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
  verification?: {
    owner?: string;
    request?: { id?: string; revision?: number; status?: string } | null;
  };
};

export type IssueEventDTO = {
  created_at?: string;
  id?: number;
  issue_id?: number;
  payload?: string;
  type?: string;
};

export type ProjectDTO = {
  auto_run?: number;
  cwd: string;
  id: string;
  loop_status?: string;
  pi_managed?: number;
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
  connectors?: Array<{ id?: string; status?: string }>;
  codex?: { capability_summary?: string; command_ok?: boolean };
  config?: { auth_enabled?: boolean };
  db?: { ok?: boolean };
  runner?: { in_progress_issues?: number; running_loops?: number };
  service?: { alive?: boolean };
};

export type SystemDoctorDTO = SystemStatusDTO & {
  health?: {
    reasons?: Array<{ code?: string; message?: string; source?: string }>;
    state?: string;
  };
  providers?: Array<{ available?: boolean; id?: string; label?: string; status?: string }>;
  security?: { warnings?: Array<{ code?: string; message?: string }> };
};
