import { createHash } from "node:crypto";
import {
  TrackerAdapterError,
  type TrackerAdapter,
  type TrackerAdapterReceipt,
  type TrackerUpdateCommand,
  type TrackerWriteContext
} from "./contracts.ts";

export type FakeTrackerAdapter = TrackerAdapter & {
  readonly attempts: TrackerUpdateCommand[];
  readonly writes: TrackerUpdateCommand[];
  failNext(error: Error): void;
};

export function createFakeTrackerAdapter(options: {
  failures?: readonly Error[];
  provider_id?: string;
} = {}): FakeTrackerAdapter {
  const providerID = options.provider_id?.trim() || "fake";
  const attempts: TrackerUpdateCommand[] = [];
  const writes: TrackerUpdateCommand[] = [];
  const failures = [...(options.failures ?? [])];
  const receipts = new Map<string, { fingerprint: string; receipt: TrackerAdapterReceipt }>();

  return {
    provider_id: providerID,
    attempts,
    writes,
    failNext(error) {
      failures.push(error);
    },
    async applyUpdate(command, context) {
      attempts.push(structuredClone(command));
      const fingerprint = commandFingerprint(command);
      const existing = receipts.get(command.idempotency_key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new TrackerAdapterError("Fake tracker idempotency conflict", { retryable: false });
        }
        return { ...existing.receipt, replayed: true };
      }
      const failure = failures.shift();
      if (failure) throw failure;
      const receipt = fakeReceipt(command, context);
      receipts.set(command.idempotency_key, { fingerprint, receipt });
      writes.push(structuredClone(command));
      return receipt;
    }
  };
}

function fakeReceipt(command: TrackerUpdateCommand, context: TrackerWriteContext): TrackerAdapterReceipt {
  const externalID = encodeURIComponent(command.target.external_id);
  return {
    comment_ref: `fake-comment:${context.outbox_id}`,
    external_id: command.target.external_id,
    external_status: command.external_status,
    external_type: command.target.external_type,
    provider_request_ref: `fake-request:${context.outbox_id}:${context.attempt}`,
    replayed: false,
    url: `https://fake.tracker.invalid/items/${externalID}`
  };
}

function commandFingerprint(command: TrackerUpdateCommand): string {
  return createHash("sha256").update(JSON.stringify({
    comment: command.comment,
    external_status: command.external_status,
    handoff_id: command.handoff_id,
    project_id: command.project_id,
    target: command.target,
    work_id: command.work_id
  })).digest("hex");
}
