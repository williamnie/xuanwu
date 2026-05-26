#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const addr = process.env.CODEX_RUNNER_ADDR || '127.0.0.1:3008';
const base = addr.startsWith('http') ? addr : `http://${addr}`;
const token = process.env.CODEX_RUNNER_AUTH_TOKEN || readToken();
const projectId = process.env.COMPOSER_SMOKE_PROJECT_ID || 'codex-issue-runner';

function readToken() {
  try {
    return readFileSync('data/auth_token', 'utf8').trim();
  } catch {
    return '';
  }
}

async function request(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${path}`, { ...options, headers });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, ok: response.ok, body };
}

function assert(condition, message, details = {}) {
  if (condition) return;
  const error = new Error(message);
  error.details = details;
  throw error;
}

function firstIssue(issues) {
  return issues.find((issue) => String(issue.status || '').toLowerCase() !== 'cancelled') || issues[0];
}

async function main() {
  const refs = await request(`/api/projects/${encodeURIComponent(projectId)}/references/search?type=file&query=Sessions&limit=5`);
  assert(refs.ok, '@file search failed', refs);
  const file = refs.body?.files?.find((item) => String(item.path || '').includes('Sessions')) || refs.body?.files?.[0];
  assert(file?.path, '@file search returned no file reference', refs.body);

  const issueList = await request(`/api/issues?projectId=${encodeURIComponent(projectId)}`);
  assert(issueList.ok, 'issue list failed', issueList);
  const issue = firstIssue(Array.isArray(issueList.body) ? issueList.body : []);
  assert(issue?.id, 'issue list returned no issue for @issue smoke', issueList.body);

  const status = await request('/api/commands', {
    method: 'POST',
    body: JSON.stringify({ command: { name: 'status', args: { issue_id: Number(issue.id) } } }),
  });
  assert(status.ok, '/status command failed', status);
  assert(status.body?.command?.name === 'status' && status.body?.issue?.id === issue.id,
    '/status did not return structured issue status', status.body);

  const runCancel = await request('/api/commands', {
    method: 'POST',
    body: JSON.stringify({ command: { name: 'run', args: { issue_id: Number(issue.id) } } }),
  });
  assert(runCancel.status === 400 && JSON.stringify(runCancel.body).includes('需要确认'),
    '/run without confirmation must be rejected', runCancel);

  const draft = await request('/api/commands', {
    method: 'POST',
    body: JSON.stringify({
      command: { name: 'issue', args: { project_id: projectId, prompt: 'Composer v2 smoke draft：验证 structured references 不退化为纯文本。' } },
      references: [
        { type: 'file', path: file.path, label: file.path },
        { type: 'issue', id: String(issue.id), label: issue.title || `#${issue.id}` },
      ],
    }),
  });
  assert(draft.ok, '/issue command with structured references failed', draft);
  const draftIssueId = draft.body?.issue?.id;
  try {
    const description = draft.body?.issue?.description || '';
    assert(description.includes(`file:${file.path}`) && description.includes(`issue:${issue.id}`),
      '/issue did not persist structured references into draft evidence', draft.body);

    const summary = {
      project_id: projectId,
      file_reference: file.path,
      issue_reference: issue.id,
      status_summary: status.body.summary,
      smoke_issue_id: draftIssueId,
      smoke_issue_cleanup: 'cancelled',
      run_cancel_status: runCancel.status,
    };
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    if (draftIssueId) {
      await request(`/api/issues/${draftIssueId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'cancelled', error: 'Composer v2 smoke cleanup' }),
      });
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  process.exit(1);
});
