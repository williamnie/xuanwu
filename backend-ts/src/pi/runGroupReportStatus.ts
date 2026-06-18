export type RunGroupReportInput = {
  enqueue_status?: unknown;
  final_issue_status?: unknown;
  report_bucket?: unknown;
  report_status?: unknown;
  status?: unknown;
};

export type RunGroupReportView = {
  report_bucket: string;
  report_status: string;
  reportable: boolean;
  status: string;
};

const REPORTABLE_STATUSES = new Set([
  "done",
  "pending_verification",
  "failed",
  "blocked",
  "cancelled",
  "skipped",
  "needs_user",
  "budget_exhausted",
  "enqueue_failed",
  "enqueue_pending_approval"
]);
const REPORTABLE_BUCKETS = new Set(["done", "verification", "failed", "skipped", "needs_user"]);

export function deriveRunGroupReportView(input: RunGroupReportInput): RunGroupReportView {
  const lifecycle = lifecycleReport(cleanString(input.final_issue_status));
  const enqueue = enqueueReport(cleanString(input.enqueue_status));
  if (lifecycle) return withExplicitReport(lifecycle, input);
  if (enqueue) return withExplicitReport(enqueue, input);
  return explicitReport(input);
}

export function isRunGroupItemReportable(input: RunGroupReportInput): boolean {
  if (cleanString(input.status) === "reportable") return true;
  if (REPORTABLE_STATUSES.has(cleanString(input.report_status))) return true;
  if (REPORTABLE_BUCKETS.has(cleanString(input.report_bucket))) return true;
  return enqueueReport(cleanString(input.enqueue_status))?.reportable === true;
}

export function lifecycleReport(status: string): RunGroupReportView | null {
  if (status === "done") return reportable("done", "done");
  if (status === "pending_verification") return reportable("pending_verification", "verification");
  if (status === "failed") return reportable("failed", "failed");
  if (status === "blocked") return reportable("blocked", "failed");
  if (status === "cancelled") return reportable("cancelled", "skipped");
  return null;
}

export function enqueueReport(status: string): RunGroupReportView | null {
  if (status === "failed") return reportable("enqueue_failed", "skipped");
  if (status === "skipped") return reportable("skipped", "skipped");
  if (status === "pending_approval") return reportable("enqueue_pending_approval", "needs_user");
  return null;
}

function explicitReport(input: RunGroupReportInput): RunGroupReportView {
  const reportStatus = cleanString(input.report_status) || "active";
  const reportBucket = cleanString(input.report_bucket) || bucketForReportStatus(reportStatus) || "active";
  const reportable = isRunGroupItemReportable({
    report_bucket: reportBucket,
    report_status: reportStatus,
    status: cleanString(input.status) || "active"
  });
  const itemStatus = reportable ? "reportable" : cleanString(input.status) || "active";
  return { report_bucket: reportBucket, report_status: reportStatus, reportable, status: itemStatus };
}

function withExplicitReport(base: RunGroupReportView, input: RunGroupReportInput): RunGroupReportView {
  const status = reportableStatus(input.status, base.status);
  const reportStatus = reportValue(input.report_status, base.report_status);
  const reportBucket = reportValue(input.report_bucket, bucketForReportStatus(reportStatus) || base.report_bucket);
  return {
    report_bucket: reportBucket,
    report_status: reportStatus,
    reportable: isRunGroupItemReportable({ report_bucket: reportBucket, report_status: reportStatus, status }),
    status
  };
}

function reportableStatus(value: unknown, fallback: string): string {
  return cleanString(value) === "reportable" ? "reportable" : fallback;
}

function reportValue(value: unknown, fallback: string): string {
  const text = cleanString(value);
  return text === "" || text === "active" ? fallback : text;
}

function bucketForReportStatus(status: string): string {
  if (status === "done") return "done";
  if (status === "pending_verification") return "verification";
  if (status === "failed" || status === "blocked") return "failed";
  if (status === "cancelled" || status === "skipped" || status === "enqueue_failed") return "skipped";
  if (status === "needs_user" || status === "budget_exhausted" || status === "enqueue_pending_approval") return "needs_user";
  return "";
}

function reportable(reportStatus: string, reportBucket: string): RunGroupReportView {
  return { report_bucket: reportBucket, report_status: reportStatus, reportable: true, status: "reportable" };
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
