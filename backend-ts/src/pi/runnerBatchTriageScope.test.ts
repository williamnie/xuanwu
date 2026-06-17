import { describe, expect, test } from "bun:test";
import { parseBatchTriageScope } from "./runnerBatchTriageScope.ts";

describe("PI batch triage scope parsing", () => {
  test("detects issue ranges and series/all phrases without treating single-start as batch", () => {
    expect(parseBatchTriageScope("把 #387-#391 都开始做")).toEqual({
      explicit: true,
      issueIds: [387, 388, 389, 390, 391],
      kind: "issue_refs"
    });
    expect(parseBatchTriageScope("继续做这个系列")).toEqual({
      explicit: true,
      issueIds: [],
      kind: "all"
    });
    expect(parseBatchTriageScope("开始这25个issue")).toEqual({
      explicit: true,
      issueIds: [],
      kind: "all"
    });
    expect(parseBatchTriageScope("movo-mobile 这 25 个 issue 都开始")).toEqual({
      explicit: true,
      issueIds: [],
      kind: "all"
    });
    expect(parseBatchTriageScope("把剩下 25 个 issue 开始")).toEqual({
      explicit: true,
      issueIds: [],
      kind: "all"
    });
    expect(parseBatchTriageScope("开始做吧")).toEqual({
      explicit: false,
      issueIds: [],
      kind: "missing"
    });
    expect(parseBatchTriageScope("继续")).toEqual({
      explicit: false,
      issueIds: [],
      kind: "missing"
    });
    expect(parseBatchTriageScope("继续做下一个")).toEqual({
      explicit: false,
      issueIds: [],
      kind: "missing"
    });
    expect(parseBatchTriageScope("start issue 25")).toEqual({
      explicit: false,
      issueIds: [],
      kind: "missing"
    });
  });
});
