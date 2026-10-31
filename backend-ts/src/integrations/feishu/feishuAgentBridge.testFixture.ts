import { type RunnerDatabase } from "../../db/database.ts";
import { useTestDatabase } from "../../testing/harness.ts";



export function createTestFixture() {
  const openFixtureDatabase = useTestDatabase();

  function messageEvent(text: string, messageId = "om_agent_1"): Record<string, unknown> {
    return {
      message: {
        chat_id: "oc_group",
        chat_type: "group",
        content: JSON.stringify({ text }),
        create_time: "1781244167890",
        message_id: messageId
      },
      sender: {
        sender_id: { open_id: "ou_open_1", user_id: "ou_user_1" },
        sender_type: "user",
        tenant_key: "tenant_a"
      }
    };
  }

  function insertProject(db: RunnerDatabase, id: string, name: string): void {
    db.sqlite.run(
      `insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)`,
      [id, name, `/tmp/${id}`, "2026-06-13T00:00:00Z", "2026-06-13T00:00:00Z"]
    );
  }
  return { openFixtureDatabase, messageEvent, insertProject };
}
export type TestFixture = ReturnType<typeof createTestFixture>;
