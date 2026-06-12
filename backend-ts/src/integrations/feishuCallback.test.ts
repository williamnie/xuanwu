import { describe, expect, test } from "bun:test";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import {
  calculateFeishuCallbackSignature,
  decryptFeishuCallbackPayload,
  parseFeishuCallbackPayload,
  verifyFeishuCallbackSignature
} from "./feishu.ts";

const ENCRYPT_KEY = "fixture-encrypt-key";

describe("Feishu callback verification", () => {
  test("calculates and verifies the Open Platform signature over raw body", () => {
    const rawBody = JSON.stringify({ token: "verify-token", event: { message: { message_id: "om_1" } } });
    const signature = calculateFeishuCallbackSignature({
      encryptKey: ENCRYPT_KEY,
      nonce: "nonce-1",
      rawBody,
      timestamp: "1781244167"
    });

    expect(signature).toBe(createHash("sha256").update(`1781244167nonce-1${ENCRYPT_KEY}${rawBody}`).digest("hex"));
    expect(verifyFeishuCallbackSignature({
      encryptKey: ENCRYPT_KEY,
      headers: feishuHeaders(signature),
      now: new Date("2026-06-12T06:02:47Z"),
      rawBody
    })).toEqual({ ok: true });
  });

  test("rejects missing timestamp nonce and mismatched signatures without leaking secrets", () => {
    const rawBody = JSON.stringify({ token: "verify-token" });
    const invalid = verifyFeishuCallbackSignature({
      encryptKey: ENCRYPT_KEY,
      headers: new Headers({
        "x-lark-request-timestamp": "1781244167",
        "x-lark-request-nonce": "nonce-1",
        "x-lark-signature": "bad-signature"
      }),
      now: new Date("2026-06-12T06:02:47Z"),
      rawBody
    });
    const missingNonce = verifyFeishuCallbackSignature({
      encryptKey: ENCRYPT_KEY,
      headers: new Headers({
        "x-lark-request-timestamp": "1781244167",
        "x-lark-signature": "bad-signature"
      }),
      now: new Date("2026-06-12T06:02:47Z"),
      rawBody
    });

    expect(invalid).toEqual({ ok: false, reason: "invalid_signature" });
    expect(missingNonce).toEqual({ ok: false, reason: "missing_signature_headers" });
    expect(JSON.stringify({ invalid, missingNonce })).not.toContain(ENCRYPT_KEY);
  });

  test("decrypts AES-256-CBC encrypted callback payloads", () => {
    const plain = JSON.stringify({ challenge: "challenge-code", token: "verify-token", type: "url_verification" });
    const encrypted = encryptFeishuPayload(plain, ENCRYPT_KEY, Buffer.alloc(16, 3));

    expect(decryptFeishuCallbackPayload(encrypted, ENCRYPT_KEY)).toBe(plain);
    expect(parseFeishuCallbackPayload(JSON.stringify({ encrypt: encrypted }), ENCRYPT_KEY)).toEqual({
      body: { challenge: "challenge-code", token: "verify-token", type: "url_verification" },
      encrypted: true
    });
  });
});

function feishuHeaders(signature: string): Headers {
  return new Headers({
    "x-lark-request-nonce": "nonce-1",
    "x-lark-request-timestamp": "1781244167",
    "x-lark-signature": signature
  });
}

function encryptFeishuPayload(plainText: string, encryptKey: string, iv = randomBytes(16)): string {
  const key = createHash("sha256").update(encryptKey).digest();
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([iv, cipher.update(plainText, "utf8"), cipher.final()]).toString("base64");
}
