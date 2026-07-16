import { redactedUserVisibleText } from "../../util/redact.ts";

export type HandoffPullRequestBodyInput = {
  branch: string;
  commit: string;
  review: {
    required: boolean;
    summary: string;
  };
  status_link: {
    label?: string;
    url: string;
  };
  summary: string;
  tracker_update: string;
  verification: ReadonlyArray<{
    command: string;
    outcome: "failed" | "passed" | "skipped";
    summary?: string;
  }>;
};

/** Deterministic, provider-neutral PR body; adapters only add their hidden idempotency marker. */
export function buildHandoffPullRequestBody(input: HandoffPullRequestBodyInput): string {
  const statusURL = safeStatusURL(input.status_link.url);
  const statusLabel = safeText(input.status_link.label || "Open Handoff status");
  const verification = input.verification.length === 0
    ? "- [ ] No verification recorded"
    : input.verification.map((item) => {
      const checked = item.outcome === "passed" ? "x" : " ";
      const suffix = item.summary ? ` — ${safeText(item.summary)}` : "";
      return `- [${checked}] \`${safeCode(item.command)}\` — ${item.outcome}${suffix}`;
    }).join("\n");

  return [
    "## Summary",
    safeText(input.summary),
    "",
    "## Delivery",
    `- Branch: \`${safeCode(input.branch)}\``,
    `- Commit: \`${safeCode(input.commit)}\``,
    `- Status: [${statusLabel}](${statusURL})`,
    "",
    "## Verification",
    verification,
    "",
    "## Review",
    `- Required: ${input.review.required ? "yes" : "no"}`,
    `- ${safeText(input.review.summary)}`,
    "",
    "## Tracker update",
    safeText(input.tracker_update)
  ].join("\n");
}

function safeStatusURL(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Handoff status URL is invalid");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Handoff status URL must use http or https");
  if (parsed.username || parsed.password) throw new Error("Handoff status URL cannot contain credentials");
  for (const key of parsed.searchParams.keys()) {
    if (/token|secret|password|api[_-]?key|auth/i.test(key)) throw new Error("Handoff status URL cannot contain credential query parameters");
  }
  return parsed.toString();
}

function safeText(value: string): string {
  return redactedUserVisibleText(value) || "Not provided";
}

function safeCode(value: string): string {
  return safeText(value).replace(/`/g, "'");
}
