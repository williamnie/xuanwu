import { describe, expect, test } from "bun:test";
import { CodexAdapter, CodexThreadLifecycleError } from "./adapter.ts";
import type { JsonRpcParams } from "./jsonRpc.ts";

export class FakeRpc {
  readonly calls: Array<{ method: string; params: JsonRpcParams }> = [];
  readonly approvalResolutions: Array<{ requestID: string; decision: unknown }> = [];
  resolveApprovalRequest?: (requestID: string, decision: unknown) => Promise<void>;
  private processGeneration = 0;

  constructor(private readonly responses: Record<string, unknown>) {}

  generation(): number {
    return this.processGeneration;
  }

  bumpGeneration(): void {
    this.processGeneration += 1;
  }

  async request(method: string, params: JsonRpcParams = null): Promise<unknown> {
    this.calls.push({ method, params });
    const response = this.responses[method];
    if (Array.isArray(response)) {
      const item = response.shift();
      if (item instanceof Error) throw item;
      return item;
    }
    if (response instanceof Error) throw response;
    return response;
  }
}
