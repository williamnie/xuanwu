import { describe } from "bun:test";
import { registerDatabaseBootstrapCases } from "./databaseBootstrapCases.ts";
import { registerDatabaseSchemaRepairCases } from "./databaseSchemaRepairCases.ts";

describe("Bun SQLite database connection", () => {
  registerDatabaseBootstrapCases();
  registerDatabaseSchemaRepairCases();
});
