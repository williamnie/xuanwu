export const PI_RUNTIME_PROMPT_PROFILES = [
  "chat",
  "acceptance",
  "recovery",
  "manager_cycle",
  "notification"
] as const;

export type PiRuntimePromptProfile = typeof PI_RUNTIME_PROMPT_PROFILES[number];

export type PiChatToolMode = "full" | "legacy_full" | "review";

export function resolvePiChatToolMode(
  review: boolean,
  env: Record<string, string | undefined> = process.env
): PiChatToolMode {
  if (review) return "review";
  return cleanString(env.XUANWU_PI_CHAT_TOOL_SURFACE).toLowerCase() === "legacy_full"
    ? "legacy_full"
    : "full";
}

export function isInternalPiRuntimePromptProfile(profile: PiRuntimePromptProfile): boolean {
  return profile !== "chat";
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
