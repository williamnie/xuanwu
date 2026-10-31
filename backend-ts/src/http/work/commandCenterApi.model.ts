import { type InboxReaders } from "./commandCenterInbox.ts";
import type { COMMAND_CENTER_SECTIONS, COMMAND_CENTER_COMPATIBILITY_POLICY, COMMAND_CENTER_SUMMARY_CONTRACT } from "./commandCenterApi.piActionAttentionDetails.ts";
import type { freshness } from "./commandCenterApi.attentionDetails.ts";

export type CommandCenterSectionName = typeof COMMAND_CENTER_SECTIONS[number];

export type CommandCenterFreshness = {
  is_stale: boolean;
  queried_at: string;
  source_updated_at: string;
  stale_after_seconds: number;
  state: "current" | "empty" | "stale" | "unknown";
};

export type CommandCenterSectionPayload = {
  counts: Record<string, number>;
  freshness: CommandCenterFreshness;
  operations?: Record<string, unknown>;
  recent_history?: unknown[];
  items?: unknown[];
  links: Record<string, string>;
  summary?: Record<string, unknown>;
};

export type CommandCenterSectionResult = (CommandCenterSectionPayload & { status: "ok" }) | {
  error: { code: "section_unavailable"; message: string };
  freshness: CommandCenterFreshness;
  links: Record<string, string>;
  status: "error";
};

export type CommandCenterSummary = {
  compatibility: typeof COMMAND_CENTER_COMPATIBILITY_POLICY;
  contract: typeof COMMAND_CENTER_SUMMARY_CONTRACT;
  failed_sections: CommandCenterSectionName[];
  generated_at: string;
  limits: { default: number; maximum: number; requested: number };
  partial: boolean;
  requested_sections: CommandCenterSectionName[];
  sections: Partial<Record<CommandCenterSectionName, CommandCenterSectionResult>>;
};

export type SectionInput = { limit: number; now: Date };

export type CommandCenterSectionReader = (input: SectionInput) => CommandCenterSectionPayload;

export type CommandCenterSectionReaders = Record<CommandCenterSectionName, CommandCenterSectionReader>;

export type CommandCenterRouteOptions = {
  now?: () => Date;
  readers?: Partial<CommandCenterSectionReaders>;
  inboxReaders?: Partial<InboxReaders>;
};
