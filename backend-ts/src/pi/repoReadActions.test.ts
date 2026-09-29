import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "../db/repositories/projects.ts";
import { redactionRegistry } from "../security/redactionRegistry.ts";
import { readRepoExcerpt, searchRepo } from "./repoReadActions.ts";

describe("bounded repository reads", () => {
  let cwd: string;
  let project: Project;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "repo-read-test-"));
    project = { cwd } as Project;
  });
  afterEach(() => rmSync(cwd, { force: true, recursive: true }));

  test("reads a requested line beyond 4 KB without loading or returning the full file", () => {
    writeFileSync(join(cwd, "source.ts"), `${"ordinary source line\n".repeat(1000)}wanted line\nrest\n`);
    expect(readRepoExcerpt(project, { path: "source.ts", start_line: 1001, max_lines: 1, max_bytes: 32 }))
      .toMatchObject({ excerpt: "wanted line", line_range: { start: 1001, end: 1001 }, truncated: true });
  });

  test("clips redacted output on UTF-8 boundaries, including redaction expansion", () => {
    writeFileSync(join(cwd, "source.ts"), "中文😀尾\n");
    expect(readRepoExcerpt(project, { path: "source.ts", max_bytes: 8 })).toMatchObject({ excerpt: "中文", truncated: true });
    writeFileSync(join(cwd, "source.ts"), "TOKEN=x\n");
    const result = readRepoExcerpt(project, { path: "source.ts", max_bytes: 8 });
    expect(Buffer.byteLength(result.excerpt)).toBeLessThanOrEqual(8);
    expect(result.excerpt).not.toContain("TOKEN=x");
    expect(result.truncated).toBe(true);
  });

  test("preserves CRLF, trailing empty line, and start beyond EOF semantics", () => {
    writeFileSync(join(cwd, "source.ts"), "one\r\ntwo\r\n");
    expect(readRepoExcerpt(project, { path: "source.ts" })).toMatchObject({ excerpt: "one\ntwo\n", line_range: { start: 1, end: 3 }, truncated: false });
    expect(readRepoExcerpt(project, { path: "source.ts", start_line: 100 })).toMatchObject({ excerpt: "", line_range: { start: 3, end: 3 }, truncated: false });
  });

  test("keeps source line numbers when registered multiline secrets collapse in output", () => {
    const secret = "private-head\nprivate-tail";
    redactionRegistry.register(secret);
    try {
      writeFileSync(join(cwd, "source.ts"), `intro\n${secret}\nlast\n`);
      expect(readRepoExcerpt(project, { path: "source.ts", max_lines: 3 })).toMatchObject({
        excerpt: "intro\n[redacted]", line_range: { start: 1, end: 3 }, truncated: true
      });
    } finally { redactionRegistry.unregister(secret); }
  });

  test("redacts the complete requested window before applying its byte limit", () => {
    const secret = "private-head\nprivate-tail";
    redactionRegistry.register(secret);
    try {
      writeFileSync(join(cwd, "source.ts"), secret);
      expect(readRepoExcerpt(project, { path: "source.ts", max_lines: 2, max_bytes: 8 })).toMatchObject({
        excerpt: "[redacte", line_range: { start: 1, end: 2 }, truncated: true
      });
    } finally { redactionRegistry.unregister(secret); }
  });

  test("maps clipped output back to only the original lines it actually contains", () => {
    writeFileSync(join(cwd, "source.ts"), "1234\nnext");
    expect(readRepoExcerpt(project, { path: "source.ts", max_bytes: 4 })).toMatchObject({
      excerpt: "1234", line_range: { start: 1, end: 1 }, truncated: true
    });
    writeFileSync(join(cwd, "source.ts"), "中文\nnext");
    expect(readRepoExcerpt(project, { path: "source.ts", max_bytes: 1 })).toMatchObject({
      excerpt: "", line_range: { start: 1, end: 0 }, truncated: true
    });
  });

  test("reports bounded reads of huge lines instead of allocating the complete line", () => {
    writeFileSync(join(cwd, "source.ts"), "x".repeat(9 * 1024 * 1024));
    const result = readRepoExcerpt(project, { path: "source.ts", max_bytes: 32 });
    expect(Buffer.byteLength(result.excerpt)).toBeLessThanOrEqual(32);
    expect(result.truncated).toBe(true);
  });

  test("searches past 4 KB while bounding and redacting each result", () => {
    writeFileSync(join(cwd, "source.ts"), `${"ordinary line\n".repeat(1000)}needle TOKEN=secret\n${"中".repeat(2000)} needle\n`);
    const result = searchRepo(project, { query: "needle" });
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({ excerpt: "needle TOKEN=[redacted]", line_range: { start: 1001, end: 1001 } });
    expect(JSON.stringify(result)).not.toContain("TOKEN=secret");
    for (const row of result.results as Array<{ excerpt: string; matched_text: string }>) {
      expect(Buffer.byteLength(row.excerpt)).toBeLessThanOrEqual(4096);
      expect(row.excerpt).not.toContain("�");
      expect(row.excerpt).toContain("needle");
    }
  });

  test("handles UTF-8 across read chunks and resumes after an oversized line", () => {
    writeFileSync(join(cwd, "source.ts"), `${"x".repeat(8191)}😀\n${"x".repeat(70000)}\nneedle 中文😀\n`);
    expect(readRepoExcerpt(project, { path: "source.ts", max_lines: 1, max_bytes: 65536 }).excerpt).toBe(`${"x".repeat(8191)}😀`);
    expect(readRepoExcerpt(project, { path: "source.ts", start_line: 3, max_lines: 1 }).excerpt).toBe("needle 中文😀");
    const result = searchRepo(project, { path: "source.ts", query: "needle" });
    expect(result.results).toEqual([expect.objectContaining({ excerpt: "needle 中文😀", line_range: { start: 3, end: 3 } })]);
    expect(result.truncated).toBe(true);
    expect(result.skipped).toEqual([{ path: "source.ts", reason: "line read budget exceeded" }]);
  });

  test("redacts long sensitive assignments before clipping and omits oversized sensitive lines", () => {
    writeFileSync(join(cwd, "source.ts"), `TOKEN=${"s".repeat(32000)}\nneedle TOKEN=${"s".repeat(70000)}\nneedle public\n`);
    expect(readRepoExcerpt(project, { path: "source.ts", max_lines: 1, max_bytes: 128 })).toMatchObject({ excerpt: "TOKEN=[redacted]", truncated: true });
    const oversized = readRepoExcerpt(project, { path: "source.ts", start_line: 2, max_lines: 1 });
    expect(oversized).toMatchObject({ excerpt: "[line exceeds read budget]", line_range: { start: 2, end: 2 }, truncated: true });
    const result = searchRepo(project, { path: "source.ts", query: "needle" });
    expect(result.results).toEqual([expect.objectContaining({ excerpt: "needle public", line_range: { start: 3, end: 3 } })]);
    expect(JSON.stringify(result)).not.toContain("ssss");
  });

  test("bounds raw redaction input even when secret replacement greatly shrinks output", () => {
    writeFileSync(join(cwd, "source.ts"), `TOKEN=${"s".repeat(32000)}\n`.repeat(80));
    const result = readRepoExcerpt(project, { path: "source.ts", max_lines: 80, max_bytes: 65536 });
    expect(result).toMatchObject({ line_range: { start: 1, end: 5 }, truncated: true });
    expect(result.excerpt).toBe("[excerpt exceeds read budget]");
  });

  test("omits the whole partial window when an oversized line prevents safe redaction", () => {
    const secret = `private-head\n${"z".repeat(70000)}`;
    redactionRegistry.register(secret);
    try {
      writeFileSync(join(cwd, "source.ts"), secret);
      expect(readRepoExcerpt(project, { path: "source.ts", max_lines: 2 })).toMatchObject({
        excerpt: "[line exceeds read budget]", line_range: { start: 1, end: 2 }, truncated: true
      });
    } finally { redactionRegistry.unregister(secret); }
  });

  test("omits partial source content when the clock expires before the requested window is complete", () => {
    writeFileSync(join(cwd, "source.ts"), "private-head\nprivate-tail");
    let clockTime = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => { clockTime += 100; return clockTime; });
    try {
      expect(readRepoExcerpt(project, { path: "source.ts", max_lines: 2 })).toMatchObject({
        excerpt: "[excerpt exceeds read budget]", line_range: { start: 1, end: 1 }, truncated: true
      });
    } finally { clock.mockRestore(); }
  });

  test("stops a search when its clock budget expires", () => {
    writeFileSync(join(cwd, "source.ts"), "needle\n");
    let clockTime = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => { clockTime += 100; return clockTime; });
    try {
      expect(searchRepo(project, { query: "needle" })).toMatchObject({ results: [], truncated: true });
    } finally { clock.mockRestore(); }
  });

  test("does not mistake exhausted excerpt scan budget for EOF", () => {
    const clock = spyOn(Date, "now").mockReturnValue(0);
    try {
      writeFileSync(join(cwd, "source.ts"), "ordinary line\n".repeat(700000));
      expect(readRepoExcerpt(project, { path: "source.ts", start_line: 700000 })).toMatchObject({
        excerpt: "", line_range: { start: 700000, end: 699999 }, truncated: true
      });
    } finally { clock.mockRestore(); }
  });

  test("caps aggregate search reads and result count", () => {
    const clock = spyOn(Date, "now").mockReturnValue(0);
    try {
      for (const name of ["a", "b", "c", "d", "e"]) {
        writeFileSync(join(cwd, `${name}.ts`), `needle\n${"x".repeat(1023)}\n${`${"x".repeat(1023)}\n`.repeat(1023)}`);
      }
      const result = searchRepo(project, { query: "needle", max_results: 50 });
      expect(result.results).toHaveLength(4);
      expect(result.results).not.toEqual(expect.arrayContaining([expect.objectContaining({ path: "e.ts" })]));
      expect(result.truncated).toBe(true);
      expect(searchRepo(project, { query: "needle", max_results: 1 })).toMatchObject({
        results: [expect.objectContaining({ path: "a.ts" })], truncated: true
      });
    } finally { clock.mockRestore(); }
  });

  test("blocks intermediate symlink escapes and sensitive aliases", () => {
    const outside = mkdtempSync(join(tmpdir(), "repo-read-outside-"));
    try {
      writeFileSync(join(outside, "source.ts"), "needle\n");
      symlinkSync(outside, join(cwd, "alias"));
      mkdirSync(join(cwd, "secrets"));
      writeFileSync(join(cwd, "secrets", "source.ts"), "needle\n");
      symlinkSync(join(cwd, "secrets"), join(cwd, "private-alias"));
      expect(() => readRepoExcerpt(project, { path: "alias/source.ts" })).toThrow(/scope/);
      expect(() => searchRepo(project, { path: "alias/source.ts", query: "needle" })).toThrow(/scope/);
      expect(() => readRepoExcerpt(project, { path: "private-alias/source.ts" })).toThrow(/sensitive/);
    } finally { rmSync(outside, { force: true, recursive: true }); }
  });

  test("reports a partial search when a huge file exhausts its read budget", () => {
    writeFileSync(join(cwd, "a.ts"), `needle\n${"ordinary line\n".repeat(1000000)}`);
    writeFileSync(join(cwd, "b.ts"), "needle in another file\n");
    const result = searchRepo(project, { query: "needle" });
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "a.ts" }), expect.objectContaining({ path: "b.ts" })
    ]));
    expect(result.truncated).toBe(true);
    expect(result.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ path: "a.ts", reason: expect.stringContaining("budget") })]));
  });

  test("keeps path, sensitive file, and file type restrictions", () => {
    writeFileSync(join(cwd, ".env"), "needle\n");
    mkdirSync(join(cwd, "src"));
    symlinkSync(join(cwd, ".env"), join(cwd, "link.ts"));
    for (const path of ["../outside", "/tmp/outside", ".env", "src", "link.ts"]) {
      expect(() => readRepoExcerpt(project, { path })).toThrow();
    }
    const result = searchRepo(project, { query: "needle" });
    expect(result.results).toEqual([]);
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ".env", reason: expect.stringContaining("sensitive") }),
      expect.objectContaining({ path: "link.ts", reason: "unsupported file type" })
    ]));
  });
});
