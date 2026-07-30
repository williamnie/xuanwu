import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSessionResumeCommand, markdownFilenameForSession, sessionToMarkdown } from './sessionMarkdownExport.js';

const project = { id: 'demo', name: 'Demo', cwd: '/repo/demo' };

function demoSession(overrides = {}) {
  return {
    id: 'codex:thread-1',
    provider: 'codex',
    provider_session_id: 'thread-1',
    name: '修复 Session 导出',
    cwd: '/repo/demo',
    status: { type: 'completed' },
    model: 'gpt-5.5',
    updatedAt: 1710000000000,
    linked_issue: { id: 98, title: 'Session 支持 Markdown 导出', status: 'todo' },
    source_issues: [{ id: 97, title: '从 Session 创建 Issue', status: 'triage', source_turn_id: 'turn-1', source_excerpt: '来源摘要' }],
    token_usage: {
      total_token_usage: { total_tokens: 1234, input_tokens: 800, output_tokens: 300, reasoning_output_tokens: 134 },
      last_token_usage: { total_tokens: 200 },
      captured_at: '2026-05-26T08:00:00Z',
    },
    command_history: [{ id: 1, command_name: 'issue', created_issue_id: 97, result_summary: 'created triage issue #97' }],
    turns: [
      {
        id: 'turn-1',
        items: [
          { type: 'userMessage', content: [{ type: 'input_text', text: '请导出 Markdown transcript' }] },
          { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"echo hi"}' },
          { type: 'function_call_output', output: 'CODEX_RUNNER_AUTH_TOKEN=secret\nAuthorization: Bearer abcdef\n"private_key":"abc123"' },
          { type: 'agentMessage', text: '已完成。' },
        ],
      },
    ],
    ...overrides,
  };
}

test('exports Codex session metadata, issues, usage, transcript and tool summary', () => {
  const markdown = sessionToMarkdown(demoSession(), { project });

  assert.match(markdown, /^# 修复 Session 导出/m);
  assert.match(markdown, /- Provider: codex/);
  assert.match(markdown, /codex resume thread-1/);
  assert.match(markdown, /#98 \[todo\] Session 支持 Markdown 导出/);
  assert.match(markdown, /#97 \[triage\] 从 Session 创建 Issue/);
  assert.match(markdown, /- Total tokens: 1,234/);
  assert.match(markdown, /#### User\n请导出 Markdown transcript/);
  assert.match(markdown, /#### Tool: 调用工具：exec_command/);
  assert.match(markdown, /#### Tool: 工具输出/);
  assert.match(markdown, /CODEX_RUNNER_AUTH_TOKEN=\[REDACTED\]/);
  assert.match(markdown, /Authorization: Bearer \[REDACTED\]/);
  assert.match(markdown, /"private_key":"\[REDACTED\]"/);
  assert.doesNotMatch(markdown, /secret|Bearer abcdef|abc123/);
});

test('uses Runner resume for Claude without inventing a CLI command', () => {
  const resume = buildSessionResumeCommand({ provider: 'claude', provider_session_id: 'abc' });

  assert.equal(resume.command, '');
  assert.equal(resume.action, 'runner');
  assert.match(resume.note, /Claude Agent SDK session in Runner/);
  assert.doesNotMatch(resume.note, /Codex-only|claude resume/);
});

test('keeps empty and long transcripts exportable with truncation notes', () => {
  const empty = sessionToMarkdown(demoSession({ turns: [], token_usage: null }), { project });
  assert.match(empty, /- Empty transcript\./);

  const markdown = sessionToMarkdown(demoSession({
    turns: [{ id: 'long-turn', items: [{ type: 'agentMessage', text: 'x'.repeat(6100) }] }],
  }), { project });

  assert.match(markdown, /\[Truncated: 100 characters omitted\]/);
  assert.match(markdown, /assistant message exceeded 6000 characters/);
});

test('builds safe markdown filenames from provider session ids', () => {
  assert.equal(markdownFilenameForSession({ provider_session_id: 'thread/id:one' }), 'codex-session-thread-id-one.md');
  assert.equal(markdownFilenameForSession({ provider: 'claude', provider_session_id: 'session/one' }), 'claude-session-session-one.md');
});
