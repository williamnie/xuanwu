import { Buffer } from "node:buffer";
import { redactSensitiveText } from "../util/redact.ts";
import type { CliStderrSummary } from "./cliConnectorManifest.ts";

export type StderrMode = CliStderrSummary["summary"];
export type CapturedText = { bytes: number; omitted_bytes: number; raw: string; truncated: boolean };

export const SECRET_ENV_RE = /(^|_)(TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|AUTH)(_|$)/i;

export function buildAllowedEnv(source: Record<string, string | undefined>, allowlist?: string[]): Record<string, string> {
  const names = allowlist ?? ["PATH"];
  return Object.fromEntries(names.flatMap((name) => source[name] === undefined ? [] : [[name, String(source[name])]]));
}

export function createCollector(limit: number, mode: "head" | "tail") {
  let bytes = 0;
  let buffer = Buffer.alloc(0);
  return {
    push(chunk: Buffer | string) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += data.length;
      buffer = mode === "tail" ? tailBuffer(buffer, data, limit) : headBuffer(buffer, data, limit);
    },
    finish(summary?: StderrMode): CapturedText {
      const raw = summarizeBuffer(buffer, summary);
      return { bytes, omitted_bytes: Math.max(0, bytes - limit), raw, truncated: bytes > limit };
    }
  };
}

export function publicCapture(capture: CapturedText, secrets: string[]): Record<string, unknown> {
  return {
    bytes: capture.bytes,
    omitted_bytes: capture.omitted_bytes,
    text: sanitizeText(capture.raw, secrets),
    truncated: capture.truncated
  };
}

export function safeMessage(value: unknown, secrets: string[]): string {
  return sanitizeText(value instanceof Error ? value.message : String(value), secrets);
}

export function sanitizeText(value: string, secrets: string[]): string {
  return secrets.reduce((text, secret) => text.split(secret).join("[redacted]"), redactSensitiveText(value));
}

export function sanitizeValue(value: unknown, secrets: string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, secrets));
  if (value && typeof value === "object") return sanitizeObject(value as Record<string, unknown>, secrets);
  return typeof value === "string" ? sanitizeText(value, secrets) : value;
}

export function stderrCapture(mode: StderrMode): "head" | "tail" {
  return mode === "first_line" ? "head" : "tail";
}

function headBuffer(buffer: Buffer, data: Buffer, limit: number): Buffer {
  if (limit <= 0 || buffer.length >= limit) return buffer;
  return Buffer.concat([buffer, data.subarray(0, limit - buffer.length)]);
}

function tailBuffer(buffer: Buffer, data: Buffer, limit: number): Buffer {
  if (limit <= 0) return Buffer.alloc(0);
  const next = Buffer.concat([buffer, data]);
  return next.length > limit ? next.subarray(next.length - limit) : next;
}

function summarizeBuffer(buffer: Buffer, summary?: StderrMode): string {
  if (summary === "none") return "";
  const text = buffer.toString("utf8");
  if (summary === "first_line") return text.split(/\r?\n/)[0] ?? "";
  if (summary === "last_line") return [...text.split(/\r?\n/)].reverse().find((line) => line.trim() !== "") ?? "";
  return text;
}

function sanitizeObject(value: Record<string, unknown>, secrets: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    SECRET_ENV_RE.test(key) ? "[redacted]" : sanitizeValue(entry, secrets)
  ]));
}
