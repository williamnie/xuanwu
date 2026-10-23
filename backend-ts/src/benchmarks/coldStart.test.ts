import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("cold-start memory benchmark", () => {

  test("keeps CLI, PI SDK, OAuth, and Supervisor runtimes off the idle static import chain", () => {
    const main = source("../main.ts");
    const core = source("../runtime/core.ts");
    const conversation = source("../http/piConversationApi.ts");
    const oauth = source("../http/piOAuthApi.ts");
    const supervisor = source("../pi/supervisor/issueSupervisorDecision.ts");

    expect(main).not.toMatch(/^import \{ runCli \}/m);
    expect(main).not.toMatch(/^import \{ runPiConversationPrompt \}/m);
    expect(main).toContain('await import("./cli/command.ts")');
    expect(main).toContain('await import("./runtime/web.ts")');
    expect(main).toContain('await import("./runtime/core.ts")');
    expect(core).not.toMatch(/^import \{ runPiConversationPrompt \}/m);
    expect(core).toContain('await import("../http/piConversationApi.ts")');
    expect(conversation).not.toMatch(/^import \{[^}]*createPiRuntimeSession[^}]*\} from "\.\/piRuntime\.ts"/ms);
    expect(conversation).toContain('await import("./piRuntime.ts")');
    expect(oauth).not.toMatch(/^import \{ AuthStorage \} from "@earendil-works\/pi-coding-agent"/m);
    expect(oauth).toContain('await import("@earendil-works/pi-coding-agent")');
    expect(supervisor).not.toMatch(/^import \{ createPiRuntimeSession \}/m);
    expect(supervisor).toContain('await import("../../http/piRuntime.ts")');
  });
});

function source(relativePath: string): string {
  return readFileSync(join(import.meta.dir, relativePath), "utf8");
}
