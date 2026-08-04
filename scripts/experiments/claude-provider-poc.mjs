#!/usr/bin/env node
// Isolated Claude Code provider PoC. It only exercises Claude CLI/SDK probes.
import { createInterface } from 'node:readline';
import { createWriteStream, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const MARKER = 'xuanwu-claude-provider-poc';

function parseArgs(argv) {
  const opts = {
    allowedTools: splitList(process.env.CLAUDE_ALLOWED_TOOLS || 'Read,Glob,Grep'),
    claudeCmd: process.env.CLAUDE_CMD || 'claude',
    model: process.env.CLAUDE_MODEL || 'sonnet',
    permissionMode: process.env.CLAUDE_PERMISSION_MODE || 'dontAsk',
    timeoutMs: Number(process.env.CLAUDE_POC_TIMEOUT_MS || 60_000),
    keepTemp: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cwd') opts.cwd = needValue(argv, ++i, arg);
    else if (arg === '--model') opts.model = needValue(argv, ++i, arg);
    else if (arg === '--permission-mode') opts.permissionMode = needValue(argv, ++i, arg);
    else if (arg === '--claude-cmd') opts.claudeCmd = needValue(argv, ++i, arg);
    else if (arg === '--allowed-tools') opts.allowedTools = splitList(needValue(argv, ++i, arg));
    else if (arg === '--timeout-ms') opts.timeoutMs = Number(needValue(argv, ++i, arg));
    else if (arg === '--output') opts.output = needValue(argv, ++i, arg);
    else if (arg === '--interrupt-after-ms') opts.interruptAfterMs = Number(needValue(argv, ++i, arg));
    else if (arg === '--keep-temp') opts.keepTemp = true;
    else if (arg === '--help' || arg === '-h') return { ...opts, help: true };
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number');
  }
  return opts;
}

function splitList(value) {
  return value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
}

function needValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/experiments/claude-provider-poc.mjs [options]

Runs an isolated Claude Code CLI PoC in a temporary cwd, captures stream-json output,
prints a normalized JSON summary, and leaves production runner paths untouched.

Options:
  --cwd <dir>                Existing cwd. Default: fresh temp dir with README marker.
  --model <model>            Claude model/alias. Default: sonnet.
  --permission-mode <mode>   Claude permission mode. Default: dontAsk.
  --claude-cmd <path>        Claude CLI command. Default: CLAUDE_CMD or claude.
  --allowed-tools <list>     Comma/space list for --tools/--allowedTools. Default: Read,Glob,Grep.
  --timeout-ms <n>           Kill process after n ms. Default: 60000.
  --interrupt-after-ms <n>   Optional host-side interrupt probe using SIGINT.
  --output <path>            Raw JSONL output path. Default: temp file under os.tmpdir().
  --keep-temp                Keep the generated temp cwd.
`);
}

function commandPath(cmd) {
  const quoted = `'${String(cmd).replaceAll(`'`, `'\\''`)}'`;
  const probe = spawnSync('zsh', ['-lc', `command -v ${quoted}`], { encoding: 'utf8' });
  return probe.status === 0 ? probe.stdout.trim() : '';
}

function commandVersion(cmd) {
  const result = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
  return (result.stdout || result.stderr || '').trim();
}

async function probeNodeSdk() {
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    return { installed: true, exports: Object.keys(sdk).slice(0, 20) };
  } catch (error) {
    const missing = error && error.code === 'ERR_MODULE_NOT_FOUND';
    return { installed: false, error: missing ? 'ERR_MODULE_NOT_FOUND' : String(error.message || error) };
  }
}

function prepareCwd(opts) {
  if (opts.cwd) return { cwd: resolve(opts.cwd), generated: false };
  const cwd = mkdtempSync(join(tmpdir(), 'claude-provider-poc-'));
  writeFileSync(join(cwd, 'README.md'), `# Claude provider PoC\n\nmarker: ${MARKER}\n`, 'utf8');
  return { cwd, generated: true };
}

function outputPath(opts, cwdInfo) {
  if (opts.output) return resolve(opts.output);
  const prefix = cwdInfo.generated ? cwdInfo.cwd.split('/').pop() : 'claude-provider-poc';
  return join(tmpdir(), `${prefix}-output.jsonl`);
}

function claudeArgs(opts) {
  const prompt = [
    'You are running a Claude Code provider PoC for xuanwu.',
    'Read README.md in the current working directory.',
    'Do not modify files. Do not run shell commands.',
    `Reply exactly with: ${MARKER}`,
  ].join('\n');
  return [
    '-p', '--verbose', '--bare', '--output-format', 'stream-json',
    '--permission-mode', opts.permissionMode, '--model', opts.model,
    '--tools', opts.allowedTools.join(','), '--allowedTools', opts.allowedTools.join(','),
    '--max-turns', '4', prompt,
  ];
}

function initialState() {
  return {
    assistantText: '', compactEvents: [], hookEvents: [], isError: false,
    killedByTimeout: false, parseErrors: 0, rawEvents: 0, result: '', resultUuid: '',
    sessionId: '', stderr: '', terminalReason: '', toolUses: [], interrupted: false,
  };
}

function compactEvent(record, state) {
  state.sessionId = record.session_id || state.sessionId;
  if (record.type === 'system' && record.subtype?.startsWith('hook_')) {
    state.hookEvents.push(record.subtype);
    return { type: 'agent.hook.event', subtype: record.subtype, hook_event: record.hook_event };
  }
  if (record.type === 'system' && record.subtype === 'init') {
    return { type: 'agent.turn.started', session_id: record.session_id, cwd: record.cwd, model: record.model };
  }
  if (record.type === 'assistant' && Array.isArray(record.message?.content)) {
    return compactAssistant(record.message.content, state);
  }
  if (record.type === 'user' && record.tool_use_result) {
    return { type: 'agent.tool.output', result_type: record.tool_use_result.type || 'unknown' };
  }
  if (record.type === 'result') return compactResult(record, state);
  return undefined;
}

function compactAssistant(content, state) {
  const texts = content.filter((item) => item.type === 'text' && item.text).map((item) => item.text);
  const tools = content.filter((item) => item.type === 'tool_use').map((item) => ({ name: item.name, input: item.input }));
  if (texts.length > 0) {
    const text = texts.join('');
    state.assistantText += text;
    return { type: 'agent.message.delta', text };
  }
  if (tools.length > 0) {
    state.toolUses.push(...tools);
    return { type: 'agent.tool.started', tools };
  }
  return undefined;
}

function compactResult(record, state) {
  state.result = record.result || '';
  state.resultUuid = record.uuid || '';
  state.terminalReason = record.terminal_reason || record.stop_reason || '';
  state.isError = Boolean(record.is_error);
  return {
    type: record.is_error ? 'agent.error' : 'agent.turn.completed',
    session_id: record.session_id,
    status: record.terminal_reason || record.stop_reason,
    is_error: record.is_error,
  };
}

async function runClaude(opts, cwd, rawPath) {
  const args = claudeArgs(opts);
  const child = spawn(opts.claudeCmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = createWriteStream(rawPath, { flags: 'w' });
  const state = initialState();
  const timeout = setTimeout(() => { state.killedByTimeout = true; child.kill('SIGTERM'); }, opts.timeoutMs);
  const interrupt = opts.interruptAfterMs ? setTimeout(() => {
    state.interrupted = true; child.kill('SIGINT');
  }, opts.interruptAfterMs) : undefined;
  createInterface({ input: child.stdout }).on('line', (line) => parseLine(line, out, state));
  child.stderr.on('data', (chunk) => { state.stderr += chunk.toString('utf8'); });
  const exit = await new Promise((resolveExit) => child.on('close', (code, signal) => resolveExit({ code, signal })));
  clearTimeout(timeout);
  if (interrupt) clearTimeout(interrupt);
  out.end();
  return { args, exit, state };
}

function parseLine(line, out, state) {
  out.write(`${line}\n`);
  if (!line.trim()) return;
  state.rawEvents += 1;
  try {
    const event = compactEvent(JSON.parse(line), state);
    if (event) state.compactEvents.push(event);
  } catch {
    state.parseErrors += 1;
  }
}

function buildSummary(opts, cwdInfo, rawPath, cli, sdk, run) {
  const markerFound = `${run.state.result}\n${run.state.assistantText}`.includes(MARKER);
  const ok = run.exit.code === 0 && !run.state.isError && markerFound && !run.state.killedByTimeout;
  return {
    ok, mode: 'cli-stream-json', cli, sdk: { node: sdk }, cwd: cwdInfo.cwd,
    generated_cwd: cwdInfo.generated, model: opts.model, permission_mode: opts.permissionMode,
    allowed_tools: opts.allowedTools, session_id: run.state.sessionId,
    result_uuid: run.state.resultUuid, terminal_reason: run.state.terminalReason,
    interrupted: run.state.interrupted, killed_by_timeout: run.state.killedByTimeout,
    exit: run.exit, raw_jsonl: rawPath, raw_event_count: run.state.rawEvents,
    parse_errors: run.state.parseErrors, compact_events: run.state.compactEvents,
    hook_events: run.state.hookEvents, tool_uses: run.state.toolUses,
    assistant_text: run.state.assistantText.trim(), result: run.state.result,
    marker_found: markerFound, stderr: run.state.stderr.trim(), command: [opts.claudeCmd, ...run.args],
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printHelp(); return; }
  const cli = { command: opts.claudeCmd, path: commandPath(opts.claudeCmd), version: '' };
  const sdk = await probeNodeSdk();
  if (!cli.path) throw new Error(`Claude CLI not found: ${opts.claudeCmd}`);
  cli.version = commandVersion(opts.claudeCmd);
  const cwdInfo = prepareCwd(opts);
  const rawPath = outputPath(opts, cwdInfo);
  try {
    const run = await runClaude(opts, cwdInfo.cwd, rawPath);
    const summary = buildSummary(opts, cwdInfo, rawPath, cli, sdk, run);
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = summary.ok ? 0 : 1;
  } finally {
    if (cwdInfo.generated && !opts.keepTemp) rmSync(cwdInfo.cwd, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error.stack || error) }, null, 2));
  process.exitCode = 1;
});
