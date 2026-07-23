export type PiConversationSseEvent = {
  data: Record<string, unknown>;
  event: string;
  id: string;
};

export async function readPiConversationSse(response: Response): Promise<PiConversationSseEvent[]> {
  return parsePiConversationSse(await response.text());
}

export function parsePiConversationSse(value: string): PiConversationSseEvent[] {
  return value.split(/\r?\n\r?\n/)
    .map((frame) => frame.trim())
    .filter((frame) => frame !== "" && !frame.startsWith(":"))
    .map((frame) => {
      const lines = frame.split(/\r?\n/);
      const event = field(lines, "event");
      const id = field(lines, "id");
      const data = JSON.parse(field(lines, "data") || "{}");
      return {
        data: data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {},
        event,
        id
      };
    });
}

export async function finalPiConversationSseData(response: Response): Promise<Record<string, unknown>> {
  const events = await readPiConversationSse(response);
  return events.at(-1)?.data ?? {};
}

function field(lines: string[], name: string): string {
  const prefix = `${name}:`;
  return lines.find((line) => line.startsWith(prefix))?.slice(prefix.length).trimStart() ?? "";
}
