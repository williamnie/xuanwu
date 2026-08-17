const PREFIX = "i1";
const CALLBACK_DATA_MAX_BYTES = 64;

export type TelegramCallbackData = {
  actionIndex: number;
  interactionId: string;
  revision: number;
};

export function isTelegramCallbackDataWithinByteLimit(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const bytes = new TextEncoder().encode(value).byteLength;
  return bytes >= 1 && bytes <= CALLBACK_DATA_MAX_BYTES;
}

/** Telegram callback_data is capped at 64 UTF-8 bytes. */
export function encodeTelegramCallbackData(input: TelegramCallbackData): string {
  if (!Number.isSafeInteger(input.actionIndex) || input.actionIndex < 0) throw new Error("Telegram action index is invalid");
  if (!Number.isSafeInteger(input.revision) || input.revision <= 0) throw new Error("Telegram interaction revision is invalid");
  const token = input.interactionId.trim();
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw new Error("Telegram interaction token is invalid");
  const value = `${PREFIX}.${token}.${input.actionIndex.toString(36)}.${input.revision.toString(36)}`;
  if (!isTelegramCallbackDataWithinByteLimit(value)) throw new Error("Telegram callback data exceeds 64 bytes");
  return value;
}

export function decodeTelegramCallbackData(value: unknown): TelegramCallbackData | null {
  if (typeof value !== "string" || !isTelegramCallbackDataWithinByteLimit(value)) return null;
  const [prefix, interactionId, actionPart, revisionPart, extra] = value.split(".");
  if (prefix !== PREFIX || extra !== undefined || !/^[A-Za-z0-9_-]{16,64}$/.test(interactionId ?? "")) return null;
  if (!/^[0-9a-z]+$/.test(actionPart ?? "") || !/^[0-9a-z]+$/.test(revisionPart ?? "")) return null;
  const actionIndex = Number.parseInt(actionPart!, 36);
  const revision = Number.parseInt(revisionPart!, 36);
  if (!Number.isSafeInteger(actionIndex) || actionIndex < 0 || !Number.isSafeInteger(revision) || revision <= 0) return null;
  return { actionIndex, interactionId: interactionId!, revision };
}
