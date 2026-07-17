import { redactionRegistry } from "../security/redactionRegistry.ts";

const ABSOLUTE_PATH_PATTERN = /(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g;
const STACK_LINE_PATTERN = /^\s*at\s+\S+/;

export function redactSensitiveText(text: string): string {
  return redactionRegistry.redactText(text);
}

export function redactedUserVisibleText(text: string): string {
  return redactSensitiveText(text)
    .split(/\r?\n/)
    .filter((line) => !STACK_LINE_PATTERN.test(line))
    .join(" ")
    .replace(ABSOLUTE_PATH_PATTERN, "[redacted-path]")
    .replace(/\s+/g, " ")
    .trim();
}
