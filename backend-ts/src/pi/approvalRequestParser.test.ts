import { describe, expect, test } from "bun:test";
import { parseCodexApprovalRequest } from "./approvalRequestParser.ts";

describe("approval request parser", () => {
  test("normalizes command approvals with scoped paths and redacted summary", () => {
    const parsed = parseCodexApprovalRequest({
      jsonRpcId: 42,
      method: "item/commandExecution/requestApproval",
      params: {
        command: "cat CODEX_API_KEY=fixture-secret /repo/demo/src/app.ts /tmp/outside.log",
        cwd: "/repo/demo/",
        itemId: "cmd-1",
        threadId: "thread-1",
        turnId: "turn-1"
      }
    });

    expect(parsed).toMatchObject({
      approval_id: "cmd-1",
      command: "cat CODEX_API_KEY=fixture-secret /repo/demo/src/app.ts /tmp/outside.log",
      parse_status: "ok",
      request_type: "command",
      normalized_scope: {
        all_paths_within_cwd: false,
        cwd: "/repo/demo"
      }
    });
    expect(parsed.paths).toEqual([
      { in_cwd: true, normalized_path: "/repo/demo/src/app.ts", raw_path: "/repo/demo/src/app.ts" },
      { in_cwd: false, normalized_path: "/tmp/outside.log", raw_path: "/tmp/outside.log" }
    ]);
    expect(parsed.summary).toContain("CODEX_API_KEY=[redacted]");
    expect(parsed.summary).toContain("[redacted-path]");
    expect(parsed.summary).not.toContain("fixture-secret");
    expect(parsed.summary).not.toContain("/repo/demo");
    expect(parsed.summary).not.toContain("/tmp/outside");
  });

  test("normalizes file change paths relative to cwd", () => {
    const parsed = parseCodexApprovalRequest({
      jsonRpcId: "rpc-file",
      method: "item/fileChange/requestApproval",
      params: {
        approvalId: "file-1",
        changes: [{ path: "src/App.tsx" }, { path: "../outside.txt" }],
        cwd: "/repo/demo"
      }
    });

    expect(parsed).toMatchObject({
      approval_id: "file-1",
      command: "",
      parse_status: "ok",
      request_type: "fileChange",
      normalized_scope: { all_paths_within_cwd: false, cwd: "/repo/demo" }
    });
    expect(parsed.paths).toEqual([
      { in_cwd: true, normalized_path: "/repo/demo/src/App.tsx", raw_path: "src/App.tsx" },
      { in_cwd: false, normalized_path: "/repo/outside.txt", raw_path: "../outside.txt" }
    ]);
  });

  test("parses permissions approvals without throwing", () => {
    const parsed = parseCodexApprovalRequest({
      jsonRpcId: "rpc-perm",
      method: "item/permissions/requestApproval",
      params: {
        callId: "perm-1",
        cwd: "/repo/demo",
        permissions: { network: "enabled", sandbox: "workspace-write" }
      }
    });

    expect(parsed).toMatchObject({
      approval_id: "perm-1",
      parse_status: "ok",
      permissions: { network: "enabled", sandbox: "workspace-write" },
      request_type: "permissions"
    });
    expect(parsed.summary).toContain("permissions");
  });

  test("parses approval requested envelopes from provider events", () => {
    const parsed = parseCodexApprovalRequest({
      jsonRpcId: "rpc-envelope",
      method: "approval/requested",
      params: {
        id: "envelope-1",
        method: "item/commandExecution/requestApproval",
        params: {
          command: "git status",
          cwd: "/repo/demo"
        }
      }
    });

    expect(parsed).toMatchObject({
      approval_id: "envelope-1",
      command: "git status",
      parse_status: "ok",
      request_type: "command"
    });
  });

  test("returns ambiguous instead of throwing for malformed params", () => {
    const parsed = parseCodexApprovalRequest({
      jsonRpcId: "rpc-ambiguous",
      method: "item/fileChange/requestApproval",
      params: "not an object"
    });

    expect(parsed).toMatchObject({
      approval_id: "rpc-ambiguous",
      parse_status: "ambiguous",
      request_type: "fileChange"
    });
    expect(parsed.paths).toEqual([]);
  });
});
