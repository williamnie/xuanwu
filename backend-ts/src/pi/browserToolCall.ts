import { createHash } from "node:crypto";
import { redactSensitiveText } from "../util/redact.ts";
import {
  BROWSER_READ_PAGE_CONTEXT_TOOL_NAME,
  BROWSER_READONLY_PROVIDER_ID,
  BROWSER_SNAPSHOT_ENV
} from "./browserToolProvider.ts";
import type { ToolResult, ToolResultError } from "./toolProviderEnvelope.ts";
export type BrowserToolCallInput = {
  env?: Record<string, string | undefined>;
  input?: Record<string, unknown>;
  invocationID?: string;
  toolName: string;
};
export type BrowserSnapshotDiagnostic = {
  authorized: boolean;
  code: BrowserSnapshotDiagnosticCode;
  env_configured: boolean;
  message: string;
  ok: boolean;
  page_count: number;
};
type BrowserSnapshotDiagnosticCode =
  | "browser_configured"
  | "browser_no_pages"
  | "browser_snapshot_invalid"
  | "browser_unauthorized"
  | "browser_unavailable";
type JsonObject = Record<string, unknown>;
type Clock = { invocationID: string; started: number; startedAt: Date };
type BrowserSnapshot = { activePageID: string; authorized: boolean; generatedAt: string; pages: JsonObject[] };
type ReadOptions = {
  includeDom: boolean;
  includeImageRef: boolean;
  includeScreenshot: boolean;
  includeText: boolean;
  maxDomItems: number;
  maxTextChars: number;
};
type PageSelection = { page: JsonObject } | { error: ToolResultError; status: "denied" | "failed" };
const DEFAULT_TEXT_CHARS = 12_000;
const MAX_TEXT_CHARS = 50_000;
const HARD_MAX_TEXT_CHARS = 200_000;
const DEFAULT_DOM_ITEMS = 40;
const MAX_DOM_ITEMS = 200;
const HARD_MAX_DOM_ITEMS = 5_000;
const SUMMARY_TEXT_CHARS = 800;
const SOURCE_ID = "browser";
export async function callBrowserTool(request: BrowserToolCallInput): Promise<ToolResult> {
  const clock = invocationClock(request.invocationID);
  if (request.toolName !== BROWSER_READ_PAGE_CONTEXT_TOOL_NAME) {
    return finish(clock, "failed", { code: "browser_tool_not_found", message: `Browser tool not found: ${request.toolName}` });
  }
  const loaded = loadSnapshot(request.env);
  if ("error" in loaded) return finish(clock, loaded.status, loaded.error);
  const selected = selectPage(loaded.snapshot, request.input ?? {});
  if ("error" in selected) return finish(clock, selected.status, selected.error);
  if (oversizePage(selected.page)) return finish(clock, "denied", pageTooLargeError(selected.page));
  return finish(clock, "succeeded", undefined, outputForPage(selected.page, readOptions(request.input ?? {})));
}
export function diagnoseBrowserSnapshot(env?: Record<string, string | undefined>): BrowserSnapshotDiagnostic {
  const loaded = loadSnapshot(env);
  if ("error" in loaded) return diagnosticFromError(loaded.error);
  if (loaded.snapshot.pages.length === 0) {
    return { authorized: true, code: "browser_no_pages", env_configured: true, message: "Browser snapshot has no authorized pages", ok: false, page_count: 0 };
  }
  return {
    authorized: true,
    code: "browser_configured",
    env_configured: true,
    message: "Browser read-only snapshot is configured",
    ok: true,
    page_count: loaded.snapshot.pages.length
  };
}
function loadSnapshot(env?: Record<string, string | undefined>):
  { snapshot: BrowserSnapshot } | { error: ToolResultError; status: "denied" | "failed" } {
  const raw = cleanString((env ?? process.env)[BROWSER_SNAPSHOT_ENV]);
  if (raw === "") return { error: { code: "browser_unavailable", message: `${BROWSER_SNAPSHOT_ENV} is not configured` }, status: "failed" };
  const parsed = parseJson(raw);
  if (!parsed) return { error: { code: "browser_snapshot_invalid", message: "Browser snapshot JSON is invalid" }, status: "failed" };
  const snapshot = normalizeSnapshot(parsed);
  if (!snapshot.authorized) return { error: { code: "browser_unauthorized", message: "Browser snapshot is not user-authorized for read-only access" }, status: "denied" };
  if (snapshot.pages.length === 0) return { error: { code: "browser_no_pages", message: "Browser snapshot has no authorized pages" }, status: "failed" };
  return { snapshot };
}
function normalizeSnapshot(value: JsonObject): BrowserSnapshot {
  return {
    activePageID: firstText(value.active_page_id, value.activePageId, value.active_page, value.activePage),
    authorized: value.authorized === true || value.user_authorized === true,
    generatedAt: firstText(value.generated_at, value.generatedAt),
    pages: arrayValue(value.pages).map(objectValue)
  };
}
function selectPage(snapshot: BrowserSnapshot, input: JsonObject): PageSelection {
  const pageID = cleanString(input.page_id ?? input.pageId);
  const url = normalizedUrl(input.url);
  const pages = snapshot.pages;
  if (pageID !== "") return pageByID(pages, pageID);
  if (url !== "") return pageByUrlOrOrigin(pages, url, activePage(snapshot));
  return { page: activePage(snapshot) ?? pages[0] };
}
function pageByID(pages: JsonObject[], id: string): PageSelection {
  const page = pages.find((item) => pageID(item) === id);
  return page ? { page } : { error: { code: "browser_page_not_found", message: `Browser page not found: ${id}` }, status: "failed" };
}
function pageByUrlOrOrigin(pages: JsonObject[], url: string, active: JsonObject | undefined): PageSelection {
  const page = pages.find((item) => normalizedUrl(pageUrl(item)) === url);
  if (page) return { page };
  if (active && differentOrigin(pageUrl(active), url)) {
    return { error: { code: "browser_cross_origin_denied", message: "Requested URL is outside the authorized browser page origin" }, status: "denied" };
  }
  return { error: { code: "browser_page_not_found", message: `Browser page not found for URL: ${url}` }, status: "failed" };
}
function activePage(snapshot: BrowserSnapshot): JsonObject | undefined {
  return snapshot.pages.find((item) => pageID(item) === snapshot.activePageID) ?? snapshot.pages[0];
}
function outputForPage(page: JsonObject, options: ReadOptions): JsonObject {
  const text = options.includeText ? boundedText(redacted(pageText(page)), options.maxTextChars) : { truncated: false, value: "" };
  const dom = options.includeDom ? boundedDom(domItems(page), options.maxDomItems) : { items: [], truncated: false };
  const screenshot = options.includeScreenshot ? screenshotMetadata(page, options.includeImageRef) : {};
  const redaction = redactionSummary(page, text.value, dom.items);
  const hash = evidenceHash(page, text.value, dom.items, screenshot);
  const pageOutput = cleanObject({
    dom_summary: dom.items,
    dom_truncated: dom.truncated,
    evidence_ref: `browser_page:${hash}`,
    page_id: pageID(page),
    screenshot,
    storage_metadata: storageMetadata(firstRecord(page.storage, page.storage_metadata, page.storageMetadata)),
    text: text.value,
    text_truncated: text.truncated,
    title: redacted(pageTitle(page)),
    url: redactedUrl(pageUrl(page))
  });
  return {
    events: [rawEvent(pageOutput, redaction, screenshot)],
    page: pageOutput,
    processed_watermark: `browser:${pageOutput.page_id || hash}:${hash}`,
    provider: BROWSER_READONLY_PROVIDER_ID,
    redaction,
    source: SOURCE_ID
  };
}
function rawEvent(page: JsonObject, redaction: JsonObject, screenshot: JsonObject): JsonObject {
  const attachment = screenshotAttachment(screenshot);
  return cleanObject({
    actor: "browser",
    attachments: attachment ? [attachment] : [],
    content: eventContent(page),
    dedupe_key: `browser:${page.page_id || page.evidence_ref}`,
    event_type: "browser.page_context",
    external_id: cleanString(page.page_id) || cleanString(page.evidence_ref),
    normalized_message: { page_id: page.page_id, title: page.title, url: page.url },
    provider: BROWSER_READONLY_PROVIDER_ID,
    source: SOURCE_ID,
    source_ref: `browser:${page.page_id || page.evidence_ref}`,
    summary: { evidence_ref: page.evidence_ref, redaction, screenshot: screenshotSummary(screenshot) },
    trust_level: "untrusted"
  });
}
function readOptions(input: JsonObject): ReadOptions {
  return {
    includeDom: input.include_dom_summary !== false && input.includeDomSummary !== false,
    includeImageRef: input.include_image_ref === true || input.includeImageRef === true,
    includeScreenshot: input.include_screenshot !== false && input.includeScreenshot !== false,
    includeText: input.include_text !== false && input.includeText !== false,
    maxDomItems: boundedInt(input.max_dom_items ?? input.maxDomItems, DEFAULT_DOM_ITEMS, MAX_DOM_ITEMS),
    maxTextChars: boundedInt(input.max_text_chars ?? input.maxTextChars, DEFAULT_TEXT_CHARS, MAX_TEXT_CHARS)
  };
}
function oversizePage(page: JsonObject): boolean {
  return pageText(page).length > HARD_MAX_TEXT_CHARS || domItems(page).length > HARD_MAX_DOM_ITEMS;
}
function pageTooLargeError(page: JsonObject): ToolResultError {
  return {
    code: "browser_page_too_large",
    details: { dom_items: domItems(page).length, text_chars: pageText(page).length },
    message: "Browser page exceeds read-only evidence size limits"
  };
}
function storageMetadata(storage: JsonObject): JsonObject {
  return {
    cookies: keyMetadata(firstRecord(storage.cookies, storage.cookieStore), "name"),
    local_storage: keyMetadata(firstRecord(storage.localStorage, storage.local_storage), "key"),
    session_storage: keyMetadata(firstRecord(storage.sessionStorage, storage.session_storage), "key")
  };
}
function keyMetadata(value: unknown, keyField: string): JsonObject {
  const keys = Array.isArray(value) ? value.map((item) => firstText(objectValue(item)[keyField], item)) : Object.keys(objectValue(value));
  return { count: keys.length, keys: unique(keys.map(redactedStorageKey).filter(Boolean)) };
}
function screenshotMetadata(page: JsonObject, includeImageRef: boolean): JsonObject {
  const raw = firstRecord(page.screenshot, page.screenshot_metadata, page.screenshotMetadata);
  if (Object.keys(raw).length === 0) return {};
  return cleanObject({
    captured_at: firstText(raw.captured_at, raw.capturedAt),
    height: positiveInteger(raw.height),
    image_ref: includeImageRef ? redactedUrl(firstText(raw.image_ref, raw.imageRef, raw.remote_ref, raw.remoteRef)) : "",
    mime_type: firstText(raw.mime_type, raw.mimeType) || "image/png",
    width: positiveInteger(raw.width)
  });
}
function screenshotAttachment(screenshot: JsonObject): JsonObject | null {
  const imageRef = cleanString(screenshot.image_ref);
  if (imageRef === "") return null;
  return {
    kind: "image",
    mime_type: cleanString(screenshot.mime_type) || "image/png",
    name: "browser-screenshot.png",
    remote_ref: imageRef,
    vision_summary: `Browser screenshot metadata ${positiveInteger(screenshot.width)}x${positiveInteger(screenshot.height)}`
  };
}
function redactionSummary(page: JsonObject, text: string, dom: string[]): JsonObject {
  const fields: string[] = [];
  if (text !== pageText(page) || page.sensitive === true) fields.push("text");
  if (dom.join("\n") !== rawDomItems(page).slice(0, dom.length).join("\n")) fields.push("dom_summary");
  if (JSON.stringify(storageMetadata(firstRecord(page.storage, page.storage_metadata))).includes("[redacted-key]")) fields.push("storage_metadata");
  return { applied: fields.length > 0, fields: unique(fields), policy: "browser_read_only_metadata_redaction" };
}
function domItems(page: JsonObject): string[] {
  return rawDomItems(page).map(redacted).filter(Boolean);
}
function rawDomItems(page: JsonObject): string[] { return arrayValue(firstValue(page.dom_summary, page.domSummary, page.dom)).map(domItemText).filter(Boolean); }
function domItemText(item: unknown): string {
  if (typeof item === "string") return item;
  try { return JSON.stringify(item); } catch { return String(item); }
}
function eventContent(page: JsonObject): string {
  return [`${page.title || "Browser page"}`, page.url, cleanString(page.text).slice(0, SUMMARY_TEXT_CHARS)]
    .filter(Boolean).join("\n");
}
function evidenceHash(...values: unknown[]): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(values)).digest("hex")}`;
}
function diagnosticFromError(error: ToolResultError): BrowserSnapshotDiagnostic {
  const code = (error.code ?? "browser_unavailable") as BrowserSnapshotDiagnosticCode;
  return { authorized: code !== "browser_unauthorized", code, env_configured: code !== "browser_unavailable", message: error.message, ok: false, page_count: 0 };
}
function finish(clock: Clock, status: ToolResult["status"], error?: ToolResultError, output?: unknown): ToolResult {
  const endedAt = new Date();
  return {
    duration_ms: Math.max(0, Math.round(performance.now() - clock.started)),
    ended_at: endedAt.toISOString(),
    invocation_id: clock.invocationID,
    started_at: clock.startedAt.toISOString(),
    status,
    ...(output === undefined ? {} : { output }),
    ...(error === undefined ? {} : { error }),
    metadata: { browser: { provider_id: BROWSER_READONLY_PROVIDER_ID, read_only: true, tool_name: BROWSER_READ_PAGE_CONTEXT_TOOL_NAME } }
  };
}
function boundedText(value: string, maxChars: number): { truncated: boolean; value: string } {
  return value.length > maxChars ? { truncated: true, value: `${value.slice(0, Math.max(1, maxChars - 1))}…` } : { truncated: false, value };
}
function boundedDom(items: string[], maxItems: number): { items: string[]; truncated: boolean } {
  return { items: items.slice(0, maxItems), truncated: items.length > maxItems };
}
function pageID(page: JsonObject): string { return firstText(page.id, page.page_id, page.pageId, page.url); }
function pageText(page: JsonObject): string { return firstText(page.text, page.page_text, page.pageText, page.body_text, page.bodyText); }
function pageTitle(page: JsonObject): string { return firstText(page.title, page.name); }
function pageUrl(page: JsonObject): string { return firstText(page.url, page.href); }
function redacted(value: string): string { return redactSensitiveText(value); }
function redactedStorageKey(value: string): string { return /token|secret|password|authorization|cookie|credential|api[_-]?key/i.test(value) ? "[redacted-key]" : value; }
function redactedUrl(value: string): string { try { const url = new URL(value); for (const key of url.searchParams.keys()) if (/token|secret|password|key/i.test(key)) url.searchParams.set(key, "[redacted]"); return url.toString(); } catch { return redacted(value); } }
function screenshotSummary(value: JsonObject): JsonObject { return cleanObject({ captured_at: value.captured_at, height: value.height, image_ref_available: cleanString(value.image_ref) !== "", mime_type: value.mime_type, width: value.width }); }
function invocationClock(id: string | undefined): Clock { return { invocationID: id || crypto.randomUUID(), started: performance.now(), startedAt: new Date() }; }
function boundedInt(value: unknown, fallback: number, max: number): number { const parsed = typeof value === "number" ? value : Number.parseInt(cleanString(value), 10); return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback; }
function positiveInteger(value: unknown): number { const parsed = typeof value === "number" ? value : Number.parseInt(cleanString(value), 10); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0; }
function normalizedUrl(value: unknown): string { try { return new URL(cleanString(value)).toString(); } catch { return ""; } }
function differentOrigin(left: string, right: string): boolean { try { return new URL(left).origin !== new URL(right).origin; } catch { return true; } }
function parseJson(raw: string): JsonObject | null { try { return objectValue(JSON.parse(raw)); } catch { return null; } }
function firstRecord(...values: unknown[]): JsonObject { return objectValue(firstValue(...values)); }
function firstValue(...values: unknown[]): unknown { return values.find((value) => value !== undefined && value !== null) ?? {}; }
function objectValue(value: unknown): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}; }
function arrayValue(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function cleanObject(value: JsonObject): JsonObject { return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== "" && child !== undefined && child !== null)); }
function unique(items: string[]): string[] { return [...new Set(items)]; }
function firstText(...values: unknown[]): string { for (const value of values) { const text = cleanString(value); if (text !== "") return text; } return ""; }
function cleanString(value: unknown): string { if (typeof value === "string") return value.trim(); if (typeof value === "number" && Number.isFinite(value)) return String(value); return ""; }
