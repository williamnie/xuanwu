export const UNKNOWN_USAGE_KEY = "unknown";

export type TokenUsage = {
  cached_input_tokens: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
};

export type UsageProjectRef = { cwd: string; id: string; name: string };
export type UsageIssueRef = {
  id: number;
  project_id: string;
  session_id: string;
  status: string;
  title: string;
};

export type UsageOptions = {
  includeDimensions?: boolean;
  issues?: UsageIssueRef[];
  limit?: number;
  projects?: UsageProjectRef[];
};

export type UsageMeta = { cwd: string; id: string };
export type UsageRecord = { event: TokenEvent; meta: UsageMeta };
export type UsageBucket = {
  events: number;
  meta: UsageMeta;
  timestamp: string;
  usage: TokenUsage;
};
export type TokenEvent = {
  payload?: { info?: TokenInfo | null; rate_limits?: RateLimits | null; type?: string };
  timestamp?: string;
  type?: string;
};

export type TokenInfo = {
  last_token_usage?: Partial<TokenUsage>;
  model_context_window?: number;
  total_token_usage?: Partial<TokenUsage>;
};

export type RateLimits = Record<string, unknown> & {
  captured_at?: string;
  primary?: LimitWindow | null;
  secondary?: LimitWindow | null;
};

export type LimitWindow = Record<string, unknown> & {
  remaining_percent?: number;
  resets_at?: number;
  resets_at_iso?: string;
  used_percent?: number;
};

export type UsageReport = Record<string, unknown>;
