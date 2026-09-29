import { describe, expect, test } from "bun:test";
import { RedactionRegistry } from "./redactionRegistry.ts";

describe("repository text redaction", () => {
  test("bounds scanning of long ASCII source lines without a secret assignment", () => {
    const registry = new RedactionRegistry();
    const source = "x".repeat(32768);
    const start = performance.now();
    expect(registry.redactText(source)).toBe(source);
    // 未锚定的贪婪字段前缀会从每个字符重新扫描；原实现在此输入约耗时 1.9s。
    expect(performance.now() - start).toBeLessThan(250);
  });

  test("preserves credential prefixes, separators, punctuation and newline boundaries", () => {
    const registry = new RedactionRegistry();
    expect(registry.redactText([
      "prefix_ACCESS_KEY_suffix=credential-value",
      "MY-TOKEN-extra:credential-value",
      "{API_KEY:credential-value, PASSWORD=credential-value;}",
      "中文TOKEN=credential-value",
      "first line",
      "token\n=credential-value",
      "url=https://example.test/token/resource",
      "const ordinary = 'value'"
    ].join("\n"))).toBe([
      "prefix_ACCESS_KEY_suffix=[redacted]",
      "MY-TOKEN-extra:[redacted]",
      "{API_KEY:[redacted], PASSWORD=[redacted];}",
      "中文TOKEN=[redacted]",
      "first line",
      "token\n=credential-value",
      "url=https://example.test/token/resource",
      "const ordinary = 'value'"
    ].join("\n"));
  });

  test("does not backtrack between repeated credential markers without an assignment", () => {
    const registry = new RedactionRegistry();
    const source = "TOKEN_".repeat(5462);
    const start = performance.now();
    expect(registry.redactText(source)).toBe(source);
    expect(performance.now() - start).toBeLessThan(250);
  });

  test("redacts a credential after a long key prefix and registered multiline secrets", () => {
    const registry = new RedactionRegistry();
    registry.register("first-private-line\nsecond-private-line");
    const prefix = "x".repeat(32768);
    expect(registry.redactText(`${prefix}_TOKEN=credential-value`)).toBe(`${prefix}_TOKEN=[redacted]`);
    expect(registry.redactText("start\nfirst-private-line\nsecond-private-line\nend")).toBe("start\n[redacted]\nend");
  });
});
