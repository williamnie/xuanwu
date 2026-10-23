
type RemoteGitRateLimit = {
  limit?: number;
  remaining?: number;
  reset_at?: string;
  resource?: string;
  retry_after_seconds?: number;
};

export type RemoteGitProviderResponse<T> = {
  provider_request_ref?: string;
  rate_limit?: RemoteGitRateLimit;
  value: T;
};

export type RemoteGitMutationResponse<T> = RemoteGitProviderResponse<T> & {
  idempotency: {
    key: string;
    replayed: boolean;
  };
};
