import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseSupervisorWorkflowEvalSuiteJSON } from "./supervisorWorkflowContracts.ts";
import { renderSupervisorWorkflowEvalMarkdown, runSupervisorWorkflowEvaluation } from "./supervisorWorkflowEval.ts";

const DEFAULT_SUITE = resolve(import.meta.dir, "../../../docs/fixtures/evals/supervisor-workflow-eval-v1.json");

export async function runSupervisorWorkflowEvalCLI(args: string[]): Promise<number> {
  const options = parseArgs(args);
  const suite = parseSupervisorWorkflowEvalSuiteJSON(await readFile(options.suite, "utf8"));
  const report = runSupervisorWorkflowEvaluation(suite);
  const markdown = renderSupervisorWorkflowEvalMarkdown(report);
  if (options.outputDir) {
    await mkdir(options.outputDir, { recursive: true });
    await Promise.all([
      writeFile(resolve(options.outputDir, "supervisor-workflow-eval-report.json"), `${JSON.stringify(report, null, 2)}\n`),
      writeFile(resolve(options.outputDir, "supervisor-workflow-eval-report.md"), markdown)
    ]);
  }
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : markdown);
  return report.status === "passed" ? 0 : 1;
}

function parseArgs(args: string[]): { json: boolean; outputDir?: string; suite: string } {
  let suite = DEFAULT_SUITE;
  let outputDir: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") json = true;
    else if (arg === "--suite") suite = requiredArg(args, ++index, "--suite");
    else if (arg === "--output-dir") outputDir = requiredArg(args, ++index, "--output-dir");
    else throw new Error(`unknown evaluation argument: ${arg}`);
  }
  return { json, ...(outputDir ? { outputDir: resolve(outputDir) } : {}), suite: resolve(suite) };
}

function requiredArg(args: string[], index: number, flag: string): string {
  const value = args[index]?.trim();
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

if (import.meta.main) {
  try {
    process.exitCode = await runSupervisorWorkflowEvalCLI(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
