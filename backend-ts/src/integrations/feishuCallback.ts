import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import { cleanString, recordValue } from "./feishuShared.ts";

const FEISHU_SIGNATURE_MAX_SKEW_SECONDS = 300;

export type FeishuCallbackParseResult = {
  body: Record<string, unknown>;
  encrypted: boolean;
};

export type FeishuSignatureVerification =
  | { ok: true }
  | { ok: false; reason: FeishuSignatureFailureReason };

export type FeishuSignatureFailureReason =
  | "invalid_signature"
  | "invalid_timestamp"
  | "missing_signature_headers"
  | "stale_timestamp";

export class FeishuCallbackPayloadError extends Error {
  constructor(readonly status: number, message: string, readonly reason: string) {
    super(message);
    this.name = "FeishuCallbackPayloadError";
  }
}

export function calculateFeishuCallbackSignature(input: {
  encryptKey: string;
  nonce: string;
  rawBody: string;
  timestamp: string;
}): string {
  return createHash("sha256")
    .update(input.timestamp)
    .update(input.nonce)
    .update(input.encryptKey)
    .update(input.rawBody)
    .digest("hex");
}

export function verifyFeishuCallbackSignature(input: {
  encryptKey: string;
  headers: Headers;
  maxSkewSeconds?: number;
  now?: Date;
  rawBody: string;
}): FeishuSignatureVerification {
  const headers = signatureHeaders(input.headers);
  if (!headers) return { ok: false, reason: "missing_signature_headers" };
  return verifySignatureValues(headers, input);
}

function verifySignatureValues(
  headers: { nonce: string; signature: string; timestamp: string },
  input: { encryptKey: string; maxSkewSeconds?: number; now?: Date; rawBody: string }
): FeishuSignatureVerification {
  if (!validTimestamp(headers.timestamp)) return { ok: false, reason: "invalid_timestamp" };
  if (timestampIsStale(headers.timestamp, input.now, input.maxSkewSeconds)) return { ok: false, reason: "stale_timestamp" };
  const expected = calculateFeishuCallbackSignature({ ...headers, encryptKey: input.encryptKey, rawBody: input.rawBody });
  return constantTimeEqual(headers.signature, expected) ? { ok: true } : { ok: false, reason: "invalid_signature" };
}

export function parseFeishuCallbackPayload(rawBody: string, encryptKey = ""): FeishuCallbackParseResult {
  const root = parseJsonObject(rawBody);
  const encrypted = cleanString(root.encrypt);
  if (encrypted === "") return { body: root, encrypted: false };
  if (cleanString(encryptKey) === "") {
    throw new FeishuCallbackPayloadError(
      400,
      "feishu encrypted callback requires FEISHU_ENCRYPT_KEY",
      "encrypted_event_without_encrypt_key"
    );
  }
  return { body: parseJsonObject(decryptFeishuCallbackPayload(encrypted, encryptKey)), encrypted: true };
}

export function decryptFeishuCallbackPayload(encrypted: string, encryptKey: string): string {
  const data = Buffer.from(encrypted, "base64");
  if (data.length <= 16) throw new FeishuCallbackPayloadError(400, "invalid feishu encrypted payload", "invalid_encrypted_payload");
  try {
    const decipher = createDecipheriv("aes-256-cbc", createHash("sha256").update(encryptKey).digest(), data.subarray(0, 16));
    return Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]).toString("utf8");
  } catch {
    throw new FeishuCallbackPayloadError(400, "invalid feishu encrypted payload", "invalid_encrypted_payload");
  }
}

function signatureHeaders(headers: Headers): { nonce: string; signature: string; timestamp: string } | null {
  const timestamp = cleanString(headers.get("x-lark-request-timestamp"));
  const nonce = cleanString(headers.get("x-lark-request-nonce"));
  const signature = cleanString(headers.get("x-lark-signature"));
  return timestamp === "" || nonce === "" || signature === "" ? null : { nonce, signature, timestamp };
}

function validTimestamp(value: string): boolean {
  return Number.isInteger(Number(value));
}

function timestampIsStale(value: string, now = new Date(), maxSkewSeconds = FEISHU_SIGNATURE_MAX_SKEW_SECONDS): boolean {
  return Math.abs(Math.floor(now.getTime() / 1000) - Number(value)) > maxSkewSeconds;
}

function constantTimeEqual(value: string, expected: string): boolean {
  const valueBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);
  return valueBuffer.length === expectedBuffer.length && timingSafeEqual(valueBuffer, expectedBuffer);
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    const record = recordValue(parsed);
    if (Object.keys(record).length > 0) return record;
  } catch {}
  throw new FeishuCallbackPayloadError(400, "invalid feishu callback json", "invalid_json");
}
