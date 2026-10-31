import { CodexAdapter } from "./adapter.ts";
import { localImageInput, textInput } from "./threadLifecycle.ts";
import type { AppEvent } from "../../events/bus.ts";
import type { ProviderRunInput, SessionCreateInput, ProviderEvent } from "../types.ts";
import { PROVIDER_CODEX } from "./providerModel.ts";

export function threadOptions(input: SessionCreateInput, developerInstructions: string): Parameters<CodexAdapter["startThread"]>[0] {
  return compactOptions({
    cwd: input.cwd,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    serviceTier: input.serviceTier,
    approvalPolicy: nativePolicyString(input, "approvalPolicy", input.approvalPolicy),
    sandbox: nativePolicyString(input, "sandbox", input.sandbox),
    developerInstructions
  }) as Parameters<CodexAdapter["startThread"]>[0];
}

export function turnOptions(input: Pick<SessionCreateInput, "approvalPolicy" | "model" | "policy" | "reasoningEffort" | "serviceTier" | "sandbox">) {
  return compactOptions({
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    serviceTier: input.serviceTier,
    approvalPolicy: nativePolicyString(input, "approvalPolicy", input.approvalPolicy),
    sandbox: nativePolicyString(input, "sandbox", input.sandbox)
  });
}

export function codexUserInputs(input: { images?: ProviderRunInput["images"]; prompt?: string }) {
  const items = [textInput(input.prompt ?? "")];
  for (const image of input.images ?? []) {
    const path = image.path.trim();
    if (path !== "") items.push(localImageInput(path, image.detail));
  }
  return items;
}

export function nativePolicyString(input: Pick<ProviderRunInput, "policy">, key: string, fallback: string | undefined): string | undefined {
  const value = input.policy?.nativeSummary[key];
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

export function sameThreadEvent(event: ProviderEvent, threadID: string): boolean {
  return event.provider === PROVIDER_CODEX && event.session?.sessionId === threadID;
}

export function providerEventItemID(event: ProviderEvent): string {
  const payload = event.raw?.payload;
  if (typeof payload !== "string" || payload === "") return "";
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
    const item = (parsed as Record<string, unknown>).item;
    if (!item || typeof item !== "object" || Array.isArray(item)) return "";
    const id = (item as Record<string, unknown>).id;
    return typeof id === "string" ? id.trim() : "";
  } catch {
    return "";
  }
}

export function terminalCodexEvent(event: ProviderEvent): boolean {
  return event.type === "done" || event.type === "error" || event.raw?.method === "turn/completed";
}

export function compactOptions<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== "")) as Partial<T>;
}

export function compactAppEvent(value: AppEvent): AppEvent {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== "")
  ) as AppEvent;
}

export function payloadText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined) return undefined;
  return JSON.stringify(value);
}
