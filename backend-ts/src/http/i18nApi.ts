import type { RunnerDatabase } from "../db/database.ts";
import { APP_LANGUAGES, appLanguage, saveAppLanguage } from "../i18n/language.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";

export function registerI18nRoutes(router: Router, context: { database: RunnerDatabase }): void {
  router.get("/api/i18n", () => json(languageResponse(context.database)));
  router.put("/api/i18n", async (request) => {
    const body = await parseJsonBody(request);
    const language = body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).language
      : undefined;
    try {
      saveAppLanguage(context.database, language);
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : "invalid language");
    }
    return json(languageResponse(context.database));
  });
}

function languageResponse(db: RunnerDatabase): Record<string, unknown> {
  return {
    language: appLanguage(db),
    supported_languages: APP_LANGUAGES
  };
}
