import { describe, expect, test } from "bun:test";
import { createImChannelRegistry, type ImChannelModule } from "../integrations/imChannelContracts.ts";
import { createRouter } from "./router.ts";
import { registerImChannelRoutes } from "./imChannelsApi.ts";

describe("registry-backed IM channel API", () => {
  test("registers provider callback routes without exposing clients or secret values", async () => {
    const registry = createImChannelRegistry();
    registry.register(fakeModule("sample", "/api/integrations/sample/events"));
    const router = createRouter();
    registerImChannelRoutes(router, { registry });

    const diagnostics = await router.handle(new Request("http://127.0.0.1/api/integrations/im/channels"));
    const body = await diagnostics.json() as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("secret-value");
    expect(body[0]).toMatchObject({ id: "sample" });

    const callback = await router.handle(new Request("http://127.0.0.1/api/integrations/sample/events", {
      method: "POST"
    }));
    expect(callback.status).toBe(202);
    expect(await callback.json()).toEqual({ connector: "sample", ok: true });
  });

  test("fails closed when two modules claim the same callback path", () => {
    const registry = createImChannelRegistry();
    registry.register(fakeModule("first", "/api/integrations/shared/events"));
    registry.register(fakeModule("second", "/api/integrations/shared/events"));
    expect(() => registerImChannelRoutes(createRouter(), { registry })).toThrow(/duplicate im channel callback path/);
  });
});

function fakeModule(id: string, callbackPath: string): ImChannelModule {
  return {
    callback: {
      handle: () => Response.json({ connector: id, ok: true }, { status: 202 }),
      path: callbackPath
    },
    configuration: {
      fields: [{ id: "token", kind: "secret", label: "Token", required: true, write_only: true }],
      mode: "provider_specific",
      settings_path: `/api/integrations/${id}/settings`
    },
    connector: {
      deliver: async () => ({ provider_request_ref: "ref", replayed: false, target: "target" }),
      health: () => ({ checked_at: new Date().toISOString(), last_error: "", reconnect_attempts: 0, state: "healthy" }),
      ingest: () => undefined,
      manifest: {
        auth_refs: [],
        capabilities: [
          { id: "message.receive", kind: "inbound", requires_authorization: true },
          { id: "message.reply", kind: "outbound", requires_authorization: true }
        ],
        contract_version: 1,
        display_name: id,
        id,
        kind: "channel"
      }
    },
    id,
    presentation: {
      deliver: async () => ({ provider_request_ref: "ref", replayed: false, target: "target" })
    },
    receiver: {
      restart: () => undefined,
      start: () => undefined,
      status: () => ({
        connected: false,
        connector_id: id,
        last_error: "",
        last_event_at: "",
        reconnect_attempts: 0,
        state: "disabled"
      }),
      stop: () => undefined
    }
  };
}
