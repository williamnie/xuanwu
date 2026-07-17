import type { TrackerIssueAdapter, TrackerIssueEvent, TrackerIssuePollResult } from "./issueSync.ts";

export function createFakeTrackerIssueAdapter(events: readonly TrackerIssueEvent[], cursor?: { position: string; scope: string }): TrackerIssueAdapter {
  return { provider_id: "fake", async poll(): Promise<TrackerIssuePollResult> { return { cursor, events: events.map((event) => structuredClone(event)) }; } };
}
