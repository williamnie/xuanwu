import { describe } from "bun:test";
import { registerHumanReviewOwnershipCases } from "./humanReviewOwnershipCases.ts";
import { registerHumanReviewRevisionCases } from "./humanReviewRevisionCases.ts";

describe("human review workflow", () => {
  registerHumanReviewOwnershipCases();
  registerHumanReviewRevisionCases();
});
