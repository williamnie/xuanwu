export type PiActivityFilter = {
  conversationId?: string;
  inboxItemId?: number;
  issueId?: number;
  limit?: number;
  proposalId?: string;
  since?: string;
  source?: string;
  until?: string;
};

export type PiActivityNode = {
  at: string;
  decision?: string;
  id: string;
  kind: string;
  links: Record<string, string>;
  parent_ids: string[];
  refs: Record<string, unknown>;
  stage: string;
  status: string;
  summary: string;
  title: string;
};

export type PiActivityTimeline = {
  filters: Record<string, unknown>;
  generated_at: string;
  items: PiActivityNode[];
};

export type PiActivityScope = {
  actionIds: Set<string>;
  bundleIds: Set<number>;
  inboxIds: Set<number>;
  intakeRunIds: Set<number>;
  issueIds: Set<number>;
  proposalIds: Set<string>;
  rawEventIds: Set<number>;
  source: string;
};

export function emptyActivityScope(source: string): PiActivityScope {
  return {
    actionIds: new Set(), bundleIds: new Set(), inboxIds: new Set(), intakeRunIds: new Set(),
    issueIds: new Set(), proposalIds: new Set(), rawEventIds: new Set(), source
  };
}
