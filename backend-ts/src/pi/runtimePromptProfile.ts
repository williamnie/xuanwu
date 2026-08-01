export const PI_RUNTIME_PROMPT_PROFILES = [
  "chat",
  "acceptance",
  "recovery",
  "manager_cycle",
  "notification"
] as const;

export type PiRuntimePromptProfile = typeof PI_RUNTIME_PROMPT_PROFILES[number];

export type PiChatToolMode = "full" | "review";

export function isInternalPiRuntimePromptProfile(profile: PiRuntimePromptProfile): boolean {
  return profile !== "chat";
}
