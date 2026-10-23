import { describe, expect, test } from "bun:test";
import { parseBatchTriageScope } from "./runnerBatchTriageScope.ts";

describe("PI batch triage scope parsing", () => {
  test("trusts the agent tool call as batch intent while preserving explicit issue ranges", () => {
    expect(parseBatchTriageScope("把 #387-#391 都开始做")).toEqual({
      issueIds: [387, 388, 389, 390, 391],
      kind: "issue_refs"
    });
    expect(parseBatchTriageScope("继续做这个系列")).toEqual({
      issueIds: [],
      kind: "all"
    });
    expect(parseBatchTriageScope("开始这25个issue")).toEqual({
      issueIds: [],
      kind: "all"
    });
    expect(parseBatchTriageScope("movo-mobile 这 25 个 issue 都开始")).toEqual({
      issueIds: [],
      kind: "all"
    });
    expect(parseBatchTriageScope("把剩下 25 个 issue 开始")).toEqual({
      issueIds: [],
      kind: "all"
    });
    expect(parseBatchTriageScope("开始做吧")).toEqual({
      issueIds: [],
      kind: "all"
    });
    expect(parseBatchTriageScope("继续")).toEqual({
      issueIds: [],
      kind: "all"
    });
    expect(parseBatchTriageScope("继续做下一个")).toEqual({
      issueIds: [],
      kind: "all"
    });
    expect(parseBatchTriageScope("start issue 25")).toEqual({
      issueIds: [],
      kind: "all"
    });
  });
});
