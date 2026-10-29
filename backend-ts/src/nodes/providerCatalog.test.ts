import { expect, test } from "bun:test";
import { catalogForRemoteNode } from "./providerCatalog.ts";
import type { RemoteNode } from "../db/repositories/nodes.ts";

test("remote catalog does not inherit unreported capabilities from builtin manifests", () => {
  const node = {
    id: "node_test",
    name: "hermes",
    info: { providers: [
      { id: "codex", ready: true, capabilities: ["issue_execution"] },
      { id: "custom", ready: true, capabilities: ["issue_execution", "sessions", "model_list", "interrupt"],
        session_methods: ["createSession"], read_methods: ["listModels", "readSession"] },
      { id: "unready", ready: false, capabilities: ["issue_execution"] },
      { id: "constructor", ready: true, capabilities: ["issue_execution"] },
      { id: "non-executor", ready: true, capabilities: [] }
    ] }
  } as RemoteNode;
  const catalog = catalogForRemoteNode(node, false);
  expect(catalog.map((entry) => entry.id)).toEqual(["codex", "custom", "constructor"]);
  expect(catalog[0]).toMatchObject({ label: "hermes · Codex", legacy_capabilities: ["issue_execution"], session_actions: [], native_actions: [],
    enabled: true, submittable: true, node_online: false });
  expect(catalog[1]).toMatchObject({ label: "hermes · custom", supportLevel: "experimental",
    legacy_capabilities: ["issue_execution", "sessions", "interrupt", "model_list"], session_actions: ["create", "interrupt"] });
  expect(catalogForRemoteNode(node, true)[0]).toMatchObject({ node_online: true, runtime: { ready: true } });
});
